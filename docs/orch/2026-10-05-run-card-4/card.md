# run-card-4 — executor syntax self-check, shared lib, run-long.mjs, non-git folders, stats.mjs

## Goal
(1) Executor prompts ask for a syntax-only self-check of changed files; (2) `q` and `runBash` live in
`runner/lib.mjs` and are imported by both scripts; (3) `runner/run-long.mjs` launches a long computation with an
output-dir guard, a stream/exit file pair and a timeout; (4) `run-card.mjs` works in a folder that is not a git
repository; (5) `runner/stats.mjs` summarises all state files. `node runner/test-run-card.mjs` prints `19/19 passed`.

## Risk
medium

## Parameters
- syntax self-check sentence (exact, appended to the normal and fix executor prompts, before `<progress line>`):
  `Before replying, run a syntax-only check on every file you changed (e.g. node --check <file>, python -m py_compile <file>); this is not the Check.`
- run-long default timeout: 110 minutes (`--timeout-min` overrides); stream `<live>/run-<name>.jsonl`, exit file
  `<live>/run-<name>.exit` (`interrupted` on timeout), summary prints the last 20 lines of the stream
- run-long exit code: 2 for bad args or an existing output dir without `--resume` / a missing one with `--resume`; else 0
- non-git snapshot: every file under the repo folder except inside `.git` and `node_modules` directories; value
  `{ st: "", hash: "<size>:<mtimeMs>" }`
- stats grouping key: `<executor>/<risk>`; columns: cards, outcomes (count per outcome), fixes (total), avg exec
  minutes (1 decimal), avg exec fresh / cached / out tokens (k, from exec rows of `state.ledger`)

## Files
may change: `runner/lib.mjs` (new), `runner/run-long.mjs` (new), `runner/stats.mjs` (new), `runner/run-card.mjs`,
`runner/test-run-card.mjs` / read-only: everything else, including `SKILL.md`, `ledger.mjs`, `cost.mjs`, `HANDOFF.md`

## Steps (N = 6)
Keep existing helpers and style; node stdlib only.

1. **Syntax self-check.** In `run-card.mjs`, append the exact sentence (Parameters) to the normal and the fix executor
   prompts (lines ~739 and ~743), right before `${progressLine}`. Not to the recon prompt.
2. **`runner/lib.mjs`.** Move `q` (line 8) and `runBash` (~line 684, including its tree-kill on timeout) unchanged
   into `runner/lib.mjs` as named exports; `run-card.mjs` imports them (`import { q, runBash } from "./lib.mjs";`) and no
   longer defines them. Everything else in run-card stays where it is.
3. **`runner/run-long.mjs`.** Usage:
   `node runner/run-long.mjs --name <name> --out <output dir> [--resume] [--timeout-min <n>] -- <command…>`
   (everything after `--` is joined with spaces into one bash command). `name` must match `/^[\w.-]+$/`.
   - Without `--resume`: `--out` must not exist → else print `output dir exists: <path> (never cleared or reused; pass --resume only if the script checks its saved run parameters)` and exit 2. Then remove old `<live>/run-<name>.{jsonl,progress,exit}`.
   - With `--resume`: `--out` must exist → else exit 2. Old stream files are kept; the stream is appended (`>>`).
   - Run `{\n<command>\n} >> <q(stream)> 2>&1` (`>` instead of `>>` when not resuming) with `runBash` from lib.mjs,
     cwd = current directory, `exitPath` = the exit file, the timeout from Parameters.
   - Print `RUN-LONG <name> exit=<code or interrupted> <minutes>m`, then the last 20 lines of the stream. Exit 0.
   The live dir follows `ORCH_RUNNER_LIVE_DIR` like run-card.
4. **Non-git folders in `run-card.mjs`.** Replace the "not a git work tree → exit 2" check (~line 361) with
   `const isGit = …`; store `state.git = isGit`. When not git:
   - `snapshot()` returns the non-git snapshot (Parameters) — build it with `fs.readdirSync(…, { withFileTypes: true })`
     recursively, keys repo-relative with forward slashes; the touched/out-of-scope logic then works unchanged.
   - review command: add `--skip-git-repo-check`, and the prompt is the normal one with its first two sentences
     (`Review the working-tree changes … the code the diff touches.`) replaced by
     `Review the changes against <abs card>. This folder is not a git repository; the task changed exactly these files: <touched, comma-separated>. Read only those files and the card.`
     and the sentence about files that "already had uncommitted changes" left out.
   - fix diff: unchanged (`git diff --no-index` works outside a repo).
   - `--commit`: when `state.git === false`, refuse with `not a git repository; nothing to commit` and exit 2.
   - summary `diff:` line: `n/a (not git)`.
5. **`runner/stats.mjs`.** `node runner/stats.mjs`: read every `<live>/orch-runner/*.json` (skip files that fail to
   parse), group by `<executor>/<risk>`, print one line per group with the columns in Parameters, e.g.
   `agy/medium  cards 3  outcomes review_pass:1 review_fail:2  fixes 1  exec 6.1m  fresh 860k cached 7200k out 80k`,
   sorted by group key, then `total cards <n>`. Live dir from `ORCH_RUNNER_LIVE_DIR`.
6. **Tests** (`runner/test-run-card.mjs`), all 16 existing cases keep passing; add (final line `19/19 passed`):
   - Q (run-long): (a) `--out` = an existing temp dir, no `--resume` → exit 2 and no stream file; (b) a fresh
     `--out` path (not created), command `echo hello` → exit 0, exit file `0`, stream contains `hello`; (c) fresh out,
     command `sleep 8`, `--timeout-min 0.05` → exit file `interrupted` within 6 s.
   - R (non-git): a temp folder (no `git init`) with `a.txt`, a card at `docs/orch/t/card.md` listing `a.txt`, `b.txt`;
     fake exec `echo x > b.txt; echo 'STATUS: done'`, risk low → `passed_no_review`, `touched` = `["b.txt"]`; then fake
     exec `echo y > c.txt; echo 'STATUS: done'` on a new name → `out_of_scope` with `c.txt`.
   - S (stats): write three state JSONs into a temp live dir's `orch-runner/` (two `agy`/`medium`, one `sol`/`high`,
     with `exec.seconds`, `outcome`, `ledger` exec rows and one with `fixes: [{n:1}]`) → output has a line starting
     `agy/medium` containing `cards 2` and `fixes 1`, a line starting `sol/high` containing `cards 1`, and `total cards 3`.

## Check
`node runner/test-run-card.mjs`

## Don't
No commits, no other files, no refactors beyond the steps; don't edit SKILL.md, ledger.mjs, cost.mjs or HANDOFF.md.
Don't install packages. Don't run real agy/codex executors from the test.
"Run scripts in the foreground and wait; before replying, stop any background task still running."
"Reuse existing functions; don't copy existing logic." "No rm, no git push, no git checkout . / restore . / reset --hard."
(The test's `git reset --hard` / `git clean` / commits inside its own temp repo are the only exception.)

## Acceptance
- verdict: accepted
- runner outcome: review_fail (1 finding); Check 19/19 passed in the runner
- Claude fixed directly: review finding (`run-long --resume` accepted a regular file → require a directory); plus a bug found by running `stats.mjs` on real state files: token averages divided by all cards, including older states whose ledger is text → average only over cards with numeric ledger rows
- files: `runner/lib.mjs`, `runner/run-long.mjs`, `runner/stats.mjs`, `runner/run-card.mjs`, `runner/test-run-card.mjs`
- check: `node runner/test-run-card.mjs` → 19/19 passed after the fixes
- tokens: exec gemini-3.8-flash-high: fresh 667k, cached 6509k, out 71k · review gpt-6-luna: fresh 37k, cached 102k, out 2k
- review findings: 1 real / 0 false positive / 1 missed (stats averaging, found by Claude on real data) (medium, gpt-6-luna)
- K missed backfill (retro 2026-10-05): 2 (found after acceptance): codex executor lacked --skip-git-repo-check outside git; run-long read the whole log for its tail — /rv sol, fixed 834eeee
