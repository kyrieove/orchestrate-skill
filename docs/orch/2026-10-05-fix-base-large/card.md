# fix-base-large — --fix copies only small tracked files as its base; large or git-ignored files get a stat record

## Goal
`run-card.mjs --fix N` no longer copies every file under a may-change directory. Files over 1 MiB, and in a git repo
git-ignored files, are recorded by size + mtime instead of copied; the fix diff lists each such file that changed
as one line. `node runner/test-run-card.mjs` prints `24/24 passed`.

## Risk
medium

## Parameters
- size cap: `MAX_BASE_BYTES = 1024 * 1024` (a file larger than this is stat-only)
- git-ignored test (git repos only): one `git check-ignore --stdin` call over all base paths, cwd = repo; paths it
  prints are stat-only. Not a git repo → no ignore test.
- stat record: `state.fixBaseStats = { "<rel path>": { size, mtimeMs } }` for this round (overwritten each fix round)
- diff line for a stat-only file whose size or mtimeMs differs (or that appeared / disappeared), appended after the
  `git diff --no-index` pieces: `# large or ignored file changed (not diffed): <rel path> (size <before> → <after> bytes)`
  (`<before>`/`<after>` = `-` when missing)
- small, tracked files: copied and diffed exactly as now

## Files
may change: `runner/run-card.mjs`, `runner/test-run-card.mjs` / read-only: everything else, including `SKILL.md`,
`runner/snapshot.mjs`, `runner/lib.mjs`, `runner/executor.mjs`, `runner/review.mjs`, `runner/run-long.mjs`

## Steps (N = 3)
Edit the existing code in place; keep its structure and style.

1. `runner/run-card.mjs`, the `if (isFix) { … }` block that builds `basePaths` (after `basePaths = Array.from(basePathsSet).sort();`):
   - in a git repo (`isGit`), run
     `spawnSync("git", ["check-ignore", "--stdin"], { cwd: repoAbs, input: basePaths.join("\n"), encoding: "utf8" })`
     and make `const ignored = new Set(stdout.split(/\r?\n/).filter(Boolean))` (exit 1 = none ignored: empty set; use
     `stdout ?? ""`). Not a git repo → empty set.
   - in the copy loop, for each existing file: if `ignored.has(p)` or `fs.statSync(src).size > MAX_BASE_BYTES`, put
     `{ size, mtimeMs }` into a `stats` object under `p` and do not copy; otherwise copy as now.
   - after the loop: `state.fixBaseStats = stats; save(state);`. Declare `MAX_BASE_BYTES` once near the top of the file
     with the other constants (or right above this block if there are none).
   - `state.touched` paths are added to `basePaths` before the copy loop as now, so they get the same rule.
2. `runner/run-card.mjs`, the fix-diff block (`if (isFix) { const diffPathsSet = … }`): skip paths that are keys of
   `state.fixBaseStats` in the `git diff --no-index` loop. After the loop, for each key of `state.fixBaseStats`
   (sorted), stat the repo file now (missing → no size) and when size or mtimeMs differs, or it appeared/disappeared,
   push the Parameters diff line plus `"\n"` to `diffPieces` before `fixDiffContent = diffPieces.join("")`.
   A touched path that was missing at base time and is not in `fixBaseStats` keeps the existing `/dev/null` diff path.
3. `runner/test-run-card.mjs`: add Case X after Case W, copying Case W's shape (resetRepo, card with
   may change `src/`, round 1 with `passed_no_review`, append `## Fix 1`, `--fix 1`):
   - before round 1 commit `src/old.txt` = `"a\n"` and also write (not commit) `src/big.bin` = 2 MiB of `"x"`
     (`"x".repeat(2 * 1024 * 1024)`) and add `src/big.bin` to the temp repo's `.gitignore` (commit the `.gitignore`)
   - fix fake exec: `echo b > src/old.txt; echo y >> src/big.bin; echo 'STATUS: done'`
   - assert: outcome `fix_passed`; the base dir `<state dir>/case-x.fix1.base/src/big.bin` does not exist (use the same
     state-dir variable the file already uses for `readState`); `diffText` contains `-a` and `+b` and contains
     `# large or ignored file changed (not diffed): src/big.bin`
   - `passedCount++`; change both `23` literals in the final summary to `24` (the `if` and the error message)
     and `"23/23 passed"` to `"24/24 passed"`.

## Check
`node runner/test-run-card.mjs`

## Don't
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.
- No commits, no other files, no refactors beyond the steps. `runner/run-long.mjs` and `runner/test-run-card.mjs`
  already have uncommitted user changes: keep them.

## Acceptance
- verdict: accepted (codex out of quota; executor and review on wb by user choice, 2026-10-05)
- files: runner/run-card.mjs, runner/test-run-card.mjs
- check: `node runner/test-run-card.mjs` → exit 0 (run by run-card)
- tokens:
  - round 1: exec deepseek-v4.1-flash: fresh 0k, cached 0k, out 0k  (codex-fix-base-large.jsonl) · review deepseek-v4.1-flash: fresh 0k, cached 0k, out 0k  (codex-review-fix-base-large.jsonl)
- review findings: 0 real / 0 false positive / 0 missed; 2 bloat notes accepted (double statSync, unreachable `?? "-"`) (medium, deepseek-v4.1-flash)
