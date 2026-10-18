# check-freshness — `--commit` refuses files that changed after the last Check; `--recheck` re-runs it

## Goal
Every Check the runner runs records the content of the files the task touched. `--commit` compares the working tree
with that record and refuses when any of them changed since (e.g. Claude edited a file after the review) or when the
last Check failed. A new `--recheck --name <name>` re-runs the card's Check on the current tree and refreshes the
record, so Claude's own fixes can be committed after one command. All existing tests pass; the new cases pass.

## Risk
medium — shared tooling (reviewer sol via `--reviewer sol`).

## Parameters
- state field: `state.checkedHashes` = `{ [path]: <snapshot entry> | null }` over the union of `state.allTouched` and `state.touched`, entries taken from the snapshot made right after the Check (`null` = path not in the snapshot)
- commit comparison: for each path the commit will stage except `card.md`, `review.md` and `docs/review-log.md`, `JSON.stringify(now[p] ?? null) !== JSON.stringify(state.checkedHashes[p] ?? null)` → changed; `now = snapshot(repoAbs, true)`
- skip the comparison when `state.checkedHashes` is absent (old state files, recon runs)
- refusal texts (stderr, exit 2): `commit refused: files changed after the last Check: <comma list> — run --recheck --name <name>` and `commit refused: the last Check failed (exit <n>) — fix it and run --recheck --name <name>` (the latter when `state.checkResult?.exit` is a number other than 0)
- `--recheck` stdout: one line `recheck: exit=<n>` (plus the last 20 lines of the check log when non-zero); process exit 0 when the Check passed, 1 otherwise; `state.recheck = { exit, at: <ISO time> }`; `state.outcome` is not changed
- `--recheck` refuses (exit 2) when the state file is missing, `state.git === false`, or `state.check` is empty

## Files
may change: `runner/run-card.mjs`, `runner/commit.mjs`, `runner/card.mjs`, `runner/test-run-card.mjs`
read-only: `runner/snapshot.mjs`, `runner/lib.mjs`, `runner/executor.mjs`, `runner/review.mjs`, `runner/acceptance.mjs`, `SKILL.md`, `HANDOFF.md`

## Steps (N = 5)
1. `runner/card.mjs` → `parseArgs`: add `"recheck"` to `booleanFlags`.
2. `runner/run-card.mjs`, section `// 6. Check`: after the post-Check `scopeCheck()` call, set `state.checkedHashes` as in Parameters from `state.after` (scopeCheck has just refreshed it) and `save(state)`. This section runs for normal and `--fix` rounds alike; make sure both reach it (the timeout branch records nothing). If `state.allTouched` is only updated later in the file, take the union with whatever it holds at that point plus `state.touched` — read the code and say in your reply where `allTouched` gets updated.
3. `runner/commit.mjs`:
   - in `runCommit`, after the existing outcome/verdict gate and after `stagedTouched` is computed, before `git add`: the failed-Check refusal, then the changed-files comparison (Parameters). Import `snapshot` from `./snapshot.mjs`.
   - export `async function runRecheck(args, { stateDir })`: validate `--name` the way `runCommit` does, load the state file, refuse per Parameters, run `{\n${state.check}\n} > ${q(checkLog)} 2>&1` with `runBash` (cwd `state.repo`, `timeoutMin` 30, `exitPath: null`) where `checkLog` = `path.posix.join(stateDir, \`${name}.check.log\`)` (the same file the normal run writes), then set `state.checkResult = { exit, log: checkLog }`, recompute `state.checkedHashes` over the same path union from a fresh `snapshot(state.repo, true)`, set `state.recheck`, write the state file the way `runCommit` does (tmp + rename), print the stdout line and `process.exit(exit === 0 ? 0 : 1)`. A timeout counts as exit `null` → print `recheck: timed out`, exit 1.
4. `runner/run-card.mjs`: right after `if (args.commit) runCommit(args, { stateDir });` add `if (args.recheck) await runRecheck(args, { stateDir });` and import it.
5. `runner/test-run-card.mjs`: add Case FR after the last case, same style, distinct `--name` per sub-case; the card's Check is `grep -q ok a.txt` with `a.txt` in `## Files`:
   - (a) fake exec writes `ok` to `a.txt`, risk low → `passed_no_review`, `state.checkedHashes["a.txt"]` set; write Acceptance `- verdict: accepted`; then append a line to `a.txt` → `--commit` exits 2 with `files changed after the last Check: a.txt`; `--recheck` → exit 0, stdout `recheck: exit=0`; `--commit` → exit 0.
   - (b) same start; overwrite `a.txt` with `bad` → `--recheck` exits 1 with `recheck: exit=1`; `--commit` exits 2 with `the last Check failed (exit 1)`.
   - (c) fake exec writes `bad` → `check_failed`; Acceptance `- verdict: accepted` + `- claude fix: wrote ok` but no recheck → `--commit` exits 2 with `the last Check failed`; write `ok`, `--recheck` → 0, `--commit` → 0.
   - (d) `--recheck` with an unknown name → exit 2.
   Existing cases O and O5 must still pass unchanged; if one fails, stop and report instead of changing it.

Bypass paths: `--commit` has one entry (`runCommit`); both new refusals sit before `git add` and before the review-log append, so a refusal leaves the repo untouched. `--fix` rounds re-run the Check through section 6 and refresh the record. Recon runs have no Check and no record (skipped). A Claude edit after review is caught by the hash comparison whatever the outcome.

## Check
`node runner/test-run-card.mjs`

## Don't
- No commits, no other files, no refactors beyond the steps; reuse `snapshot`, `runBash`, `q`, `getSection` instead of copying them.
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.

## Acceptance
- verdict: accepted
- files: runner/card.mjs, runner/commit.mjs, runner/run-card.mjs, runner/test-run-card.mjs
- check: `node runner/test-run-card.mjs` → 34/34 passed; after the fix re-run through `--recheck`
- tokens:
  - round 1: exec gemini-3.8-flash-high: fresh 424k, cached 3637k, out 60k (12.1 m) · review gpt-6.1-sol: fresh 39k, cached 160k, out 1k
- review findings: 1 real / 0 false positive / K missed 0 (medium, gpt-6.1-sol)
- claude fix: commit also refuses when the last --recheck did not pass (a timed-out recheck left exit null and slipped past the numeric gate)
