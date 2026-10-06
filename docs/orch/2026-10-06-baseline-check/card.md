# baseline-check — run the card's Check once before the executor, so a Check that was already red is not blamed on it

## Goal
For a normal run (not `--fix`, not `--recon`) the runner runs the Check once after the snapshot and before the
executor, and records `state.baselineCheck`. The summary shows `baseline check: exit=<n>` and, when both the baseline
and the real Check fail, ` (Check was already red before the executor)`. Files the baseline run writes are not
counted as the executor's: the `before` snapshot is retaken after it. If the baseline run changes a read-only path the
outcome is `readonly_violated` and the executor never starts. All existing tests pass; the new cases pass.

## Risk
medium — shared tooling (reviewer sol via `--reviewer sol`).

## Parameters
- baseline log: `path.posix.join(stateDir, \`${name}.baseline.log\`)` (next to the existing `${name}.check.log`)
- timeout: `Math.min(30, remainingMin())` minutes, same as the real Check
- state shape: `state.baselineCheck = { exit: <number|null>, timedOut: <bool>, log: <path>, touched: [<paths>] }`
- summary line (right after the existing `check:` line): `baseline check: exit=${exit}` + ` (Check was already red before the executor)` when `exit !== 0 && checkExit !== 0 && checkExit !== "skipped"` + `   baseline wrote: ${touched.join(", ")}` when `touched.length`; timed out → `baseline check: timed out`
- no baseline for: `isFix`, `recon`, or an empty `check`

## Files
may change: `runner/run-card.mjs`, `runner/test-run-card.mjs`
read-only: `runner/snapshot.mjs`, `runner/executor.mjs`, `runner/review.mjs`, `runner/commit.mjs`, `runner/card.mjs`, `runner/lib.mjs`, `runner/acceptance.mjs`, `SKILL.md`, `HANDOFF.md`

## Steps (N = 4)
1. `runner/run-card.mjs`, section `// 3. Snapshot` (right after `state.readOnlyBefore = ...; save(state);`), add a block
   guarded by `if (!isFix && !recon && check)`:
   - run `runBash(\`{\n${check}\n} > ${q(baselineLog)} 2>&1\`, { cwd: repoAbs, timeoutMin: Math.min(30, remainingMin()), exitPath: null })`, the same call shape the `// 6. Check` section uses;
   - read-only guard: `const roDiff = getReadOnlyDiff(state.readOnlyBefore, readOnlyPaths, { repoAbs, normLiveDir, cardDirNorm });` → if non-null: `state.outcome = "readonly_violated"; state.readOnlyChanged = roDiff;`;
   - files it wrote: `const afterBase = snapshot(repoAbs, isGit);` then list the paths whose entry differs from `state.before` (missing on one side, or different `st`/`hash`) — compare exactly the way `scopeCheck` does, skipping `exemptPaths`; if any, set `state.before = afterBase`;
   - store `state.baselineCheck` as in Parameters and `save(state)`.
   Define `baselineLog` next to `checkLog` (section 2).
2. `runner/run-card.mjs`, section `// 4. Executor`: wrap the `await runExecutor({...})` call in `if (!state.outcome) { ... }` so a baseline read-only violation stops before the executor. Check that every later section already skips on a set `state.outcome` (sections 5–7 do: `if (!state.outcome)`); the stream-file cleanup before the executor stays unconditional.
3. `runner/run-card.mjs`, summary: add the `baseline check:` line from Parameters right after the `check:` line (and after the check-log tail, if that is printed between them, keep the baseline line directly under `check:`).
4. `runner/test-run-card.mjs`: add Case BL after the last existing case, same style (`resetRepo`, `writeCard`, `runCard`, `readState`, `passedCount++`), a distinct `--name` per sub-case:
   - (a) Check `test -f made.txt` (the card's Check), fake exec creates `made.txt` (listed in `## Files`), risk low → outcome `passed_no_review`, `state.baselineCheck.exit !== 0`, summary stdout has `baseline check: exit=1` and NOT `already red`;
   - (b) Check `exit 3`, risk low → `check_failed`, stdout has `(Check was already red before the executor)`;
   - (c) Check that writes into a read-only path listed in the card (e.g. `echo x >> data/r.txt`, with `data/` read-only) → outcome `readonly_violated`, and the fake exec's marker file (e.g. `exec-ran.txt`) does not exist;
   - (d) Check `echo x > .cache-baseline && true` with fake exec touching only an allowed file → `.cache-baseline` is in `state.baselineCheck.touched` and NOT in `state.outOfScope` (the snapshot was retaken);
   - (e) `--recon` and a `--fix 1` round → `state.baselineCheck` is undefined (fix: reuse an existing passed case's state, append `## Fix 1` the way existing fix cases do).
   If an existing case starts failing only because its Check now runs twice, stop and report it instead of changing that case.

Bypass paths: `--fix` and `--recon` skip the baseline by design (Parameters); `--commit` never reaches section 3; an empty Check skips it. The read-only guard runs whatever the baseline's exit, including a timeout.

## Check
`node runner/test-run-card.mjs`

## Don't
- No commits, no other files, no refactors beyond the steps; reuse `runBash`, `snapshot`, `getReadOnlyDiff`, `q` instead of copying them.
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.

## Acceptance
- verdict: accepted
- files: runner/run-card.mjs, runner/test-run-card.mjs
- check: `node runner/test-run-card.mjs` → 33/33 passed (re-run by Claude after the fix; the run itself ended check_failed at Case T)
- tokens:
  - round 1: exec gemini-3.8-flash-high: fresh 517k, cached 4602k, out 79k (16.1 m) · review gpt-6.1-sol run by hand (the runner skips review after a failed Check)
- review findings: 0 real / 1 false positive (untracked `agy-fallback`, Claude's switch file from deepseek-role → now in .gitignore) / K missed 0 (medium, gpt-6.1-sol)
- claude fix: card design bug — retaking `before` after the baseline hid a Check that writes outside ## Files (Case T failed). Dropped the retake; baseline-written files are only listed in `baselineCheck.touched`; BL(d) now expects `.cache-baseline` in outOfScope. agy did not stop and report as the card asked when an existing case failed.
