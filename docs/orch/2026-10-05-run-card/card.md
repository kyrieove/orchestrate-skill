# run-card — one node script runs executor → Check → Files check → ledger → review for one orchestrate card

## Goal
`node runner/run-card.mjs --card <abs card.md> --name <name> --executor agy|luna|sol --risk low|medium|high --repo <abs repo>`
runs the whole middle of an orchestrate card without Claude: executor, the card's Check (run by the script, not the
executor), touched-files check against the card's `## Files`, `ledger.mjs`, and the risk-tiered codex review. It prints a
short summary to stdout and exits; it keeps one state JSON per card. `node runner/test-run-card.mjs` passes all 6 cases.

## Risk
medium

## Parameters
- default executor timeout: 100 minutes; `--timeout-min <number>` overrides (fractions allowed, the test uses 0.05)
- Check timeout: 30 minutes
- live dir: env `ORCH_RUNNER_LIVE_DIR`, default `<homedir>/.claude/agent-live`; state dir: `<live dir>/orch-runner`
- state file: `<state dir>/<name>.json`; check log: `<state dir>/<name>.check.log`
- agy: `C:/Users/ASUS/AppData/Local/agy/bin/agy.exe`, `--model gemini-3.8-flash-high --dangerously-skip-permissions --output-format stream-json`
- codex models: luna = `gpt-6-luna`, sol = `gpt-6.1-sol`; review `-c model_reasoning_effort=medium`
- reviewer: executor luna or sol → `gpt-6.1-sol`; else medium → `gpt-6-luna`, high → `gpt-6.1-sol`; low → no review
- summary: executor reply cut to its last 15 lines; check output tail 20 lines (only when exit ≠ 0)
- script exit code: 0 whenever it reached an outcome (any outcome); 2 for bad arguments, missing card, or repo not a git work tree
- outcomes (exactly these strings): `review_pass`, `review_fail`, `review_error`, `passed_no_review`, `check_failed`,
  `out_of_scope`, `blocked`, `failed`, `interrupted`
- test seams: env `ORCH_RUNNER_FAKE_EXEC` (a bash command that replaces the executor command) and
  `ORCH_RUNNER_FAKE_REVIEW` (a bash command that replaces the review command)

## Files
may change: `runner/run-card.mjs` (new), `runner/test-run-card.mjs` (new) / read-only: everything else, including
`SKILL.md`, `ledger.mjs`, `cost.mjs`, `HANDOFF.md`, and `~/.claude/agent-live` (except what the test itself creates
under its own temp dirs)

## Steps (N = 8)
Node stdlib only (`node:child_process`, `node:fs`, `node:path`, `node:os`, `node:crypto`), ESM, no dependencies.
All child commands run through Git Bash: `spawn("bash", ["-c", cmd], { cwd: repo })`. Quote every interpolated value with
`const q = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";`. Paths passed to bash use forward slashes.

1. **runner/run-card.mjs → args + card parsing.** Parse `--card --name --executor --risk --repo --timeout-min`
   (`name` must match `/^[\w.-]+$/`). Read the card. Extract:
   - `check`: in the section `## Check` (text up to the next line starting with `## `), the first fenced code block's
     content if there is one, else the first `` `inline` `` span. None → print an error, exit 2.
   - `mayChange`: in the section `## Files`, the text before the first case-insensitive `read-only`; every backticked
     span in it, with any trailing ` (new)` text ignored. An entry ending in `/` matches every path under it; otherwise exact match.
   - `cardSha`: sha256 of the card bytes.
   - `taskDir`: card's directory relative to repo (forward slashes); exempt paths: `<taskDir>/card.md`, `<taskDir>/review.md`.
   Check `git -C <repo> rev-parse --is-inside-work-tree` → not "true" → exit 2.
2. **State file.** `save(state)` writes `<state dir>/<name>.json` atomically (write `<file>.tmp`, then `renameSync`).
   Fields: `name, card, cardSha, executor, risk, repo, check, mayChange, startedAt, stage, outcome, before, after,
   touched, outOfScope, exec: {exit, status, seconds, reply}, checkResult: {exit, log}, review: {model, verdict},
   ledger, cardModified`. Save after every stage change. Stages in order: `executing`, `checking-files`, `checking`,
   `reviewing`, `done`.
3. **Snapshot.** `snapshot()`: run `git -C <repo> status --porcelain=v1 -z --untracked-files=all`; for each entry
   take status (first 2 chars) and path (for renames `R`/`C`, the new path; with `-z` the old path is the next NUL field — skip it).
   For each path that exists as a file, `git -C <repo> hash-object -- <path>` (one call with all paths is fine:
   `git hash-object -- p1 p2 …` prints one hash per line in order). Result: `{ [path]: { st, hash } }` (`hash: null` if deleted).
   Take `before` before clearing streams. Then clear this name's old streams once:
   `rm -f` equivalent via `fs.rmSync(..., {force:true})` on `<live>/{agy,codex,codex-review}-<name>.{jsonl,progress,exit}`.
4. **Executor.** Prompt (exactly):
   `Read <abs card> and carry out every step exactly; run only the commands the Steps name; do NOT run the Check — the runner runs it after you exit; do not commit. Reply: first line exactly STATUS: done, STATUS: blocked or STATUS: failed; then files changed and anything you could not do. <progress line>`
   where `<progress line>` is copied verbatim from SKILL.md's "Progress line —" paragraph (the quoted instruction text,
   from `after starting, append` through `to learn the format.`), with the path filled in as `<live>/<agy|codex>-<name>.progress`.
   Commands (stream file `S`, exit file `E`):
   - agy: `<agy.exe> -p <q(prompt)> <agy flags> > <q(S)> 2>&1` with `S = <live>/agy-<name>.jsonl`
   - luna/sol: `{ echo '{"model":"<model>"}'; codex exec --approve-for-me -m <model> -C <q(repo)> --json <q(prompt)> < /dev/null; } > <q(S)> 2>&1`
     with `S = <live>/codex-<name>.jsonl`
   - if `ORCH_RUNNER_FAKE_EXEC` is set: `{ <that command>; } > <q(S)> 2>&1` (S as for agy)
   On exit write the exit code to `E` (`<S without .jsonl>.exit`). **Timeout**: after `timeoutMin` kill the whole tree —
   win32: `spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)])`; else spawn with `detached: true` and
   `process.kill(-child.pid, "SIGKILL")`. Then outcome `interrupted`, write `interrupted` to `E`, go to step 8.
   **Reply**: agy → parse the last line of S as JSON (`event === "result"`), take the reply text under `.result`;
   codex → the last agent message in the `--json` events. Find the exact field names with `tail -n 3` of ONE existing
   `~/.claude/agent-live/agy-*.jsonl` and ONE `codex-*.jsonl` (not `codex-review-*`); look at nothing else there.
   If parsing fails (or fake exec), the reply is the last 15 non-empty lines of S.
   `status` = match of `/^STATUS:\s*(done|blocked|failed)\b/m` in the reply, else `"missing"`.
   Exit ≠ 0 or status `failed` → outcome `failed`; status `blocked` → `blocked`; both go to step 8.
   Status `missing` with exit 0 → continue (the Check is the evidence), and show `status=missing` in the summary.
5. **Touched files.** `after = snapshot()`. `touched` = every path in `before ∪ after` whose `st` or `hash` differs
   (a path in only one of them counts), minus the 2 exempt paths. `outOfScope` = touched paths not matched by `mayChange`.
   Non-empty → outcome `out_of_scope`, go to step 8 (no Check, no review). `cardModified` = sha256 of the card now ≠ `cardSha`.
6. **Check.** `bash -c <check>` in repo, stdout+stderr to the check log, 30-minute timeout (same tree kill).
   Record exit. Exit ≠ 0 → outcome `check_failed`, go to step 8. The check command is the one parsed in step 1, never re-read.
7. **Review.** Risk low → outcome `passed_no_review`. Else pick the reviewer (Parameters). Command:
   `{ echo '{"model":"<reviewer>"}'; codex exec -s read-only -m <reviewer> -c model_reasoning_effort=medium -C <q(repo)> -o <q(abs taskDir/review.md)> --json <q(reviewPrompt)> < /dev/null; } > <q(<live>/codex-review-<name>.jsonl)> 2>&1`
   then exit code → `<live>/codex-review-<name>.exit`. `reviewPrompt` = the quoted prompt string of SKILL.md's
   **codex conformance review** command, copied verbatim, with `<abs card.md>` filled in and
   `<paths from the before snapshot>` = the `before` paths joined by `, ` (or `none`). If `ORCH_RUNNER_FAKE_REVIEW` is
   set, run `{ <that command>; }` (cwd repo) instead, same stream/exit files. Then read `review.md`: first line exactly
   `VERDICT: PASS` → `review_pass`; `VERDICT: FAIL` → `review_fail`; missing file or other first line → `review_error`.
   Use the same executor timeout for the review.
8. **Ledger + summary.** Run `node <dir of run-card.mjs>/../ledger.mjs <name>`; stdout → `ledger` (on failure `"n/a"`).
   Stage `done`, save. Print (≤ ~45 lines, nothing else on stdout):
   ```
   ORCH-RUNNER <name> outcome=<outcome> risk=<risk>
   executor: <executor> exit=<exit> status=<status> <minutes>m
   touched: <paths or ->   out of scope: <paths or ->   card modified: <yes/no>
   check: exit=<exit or skipped> `<check>`
   <check tail, only if exit ≠ 0>
   review: <model or skipped> <first line of review.md or ->
   <review.md lines 2.. , at most 12 lines>
   diff: <git diff --stat output, last line only>
   tokens:
   <ledger lines>
   reply:
   <reply, last 15 lines>
   state: <state file path>
   ```
   Exit 0.

## Steps for the test (part of step 8's deliverable)
**runner/test-run-card.mjs**: builds a temp git repo in `os.tmpdir()` (`git init`, set local user.name/email, commit
`a.txt` = "1"), sets `ORCH_RUNNER_LIVE_DIR` to another temp dir, writes a card at `docs/orch/t/card.md` (commit it) with
`## Files` listing `` `a.txt` `` and `` `b.txt` `` and a `## Check` inline span, runs `run-card.mjs` with `spawnSync(process.execPath, …)`,
reads the state JSON, and asserts with `node:assert`. Before each case reset the repo (`git reset --hard`, `git clean -fd`) —
inside the temp repo only. Cases:
- A: write "2" to `a.txt` (pre-dirty), fake exec `echo 3 > a.txt; echo x > b.txt; echo 'STATUS: done'`, check
  `node -e "process.exit(0)"`, risk low → `passed_no_review`; `touched` contains `a.txt` and `b.txt` (proves the hash catches the second edit of a pre-dirty file).
- B: fake exec creates `c.txt` → `out_of_scope`, `outOfScope` = `["c.txt"]`, `checkResult` not run.
- C: check `node -e "process.exit(3)"` → `check_failed`, exit 3.
- D: fake exec `echo 'STATUS: blocked'` (exit 0) → `blocked`, Check not run.
- E: fake exec `sleep 8; echo x > marker.txt`, `--timeout-min 0.05` → `interrupted` within 6 s; then wait 7 s and assert
  `marker.txt` does not exist (the descendant was killed).
- F: risk medium, fake review `printf 'VERDICT: PASS\n' > docs/orch/t/review.md` → `review_pass`; `review.md` not in `touched`.
Print `6/6 passed` at the end; any failure exits non-zero. Remove both temp dirs at the end.

## Check
`node runner/test-run-card.mjs`

## Don't
No commits, no other files, no refactors beyond the steps; don't edit SKILL.md, ledger.mjs, cost.mjs or HANDOFF.md.
Don't install packages. Don't run real agy/codex executors from the test.
"Run scripts in the foreground and wait; before replying, stop any background task still running."
"Reuse existing functions; don't copy existing logic." "No rm, no git push, no git checkout . / restore . / reset --hard."
(The test's `git reset --hard` / `git clean` inside its own temp repo is the only exception.)

## Fix 1
Review (sol) found 5 real problems. Change only `runner/run-card.mjs` and `runner/test-run-card.mjs`. Steps (N = 5):
1. **Stale review** (step 7, around line 470): before launching the review, delete `<taskDir>/review.md` if it exists
   (`fs.rmSync(reviewMdAbs, { force: true })`). After it: reviewer exit ≠ 0 → outcome `review_error` regardless of any file.
   Test: in case F, pre-write `VERDICT: PASS` to `docs/orch/t/review.md`, use fake review `exit 1` → assert `review_error`;
   then keep the existing F (fake review writes PASS, exit 0) → `review_pass`. Count stays 6 cases (F covers both).
2. **Signal exit** (`runBash` close handler, ~line 278): `child.on("close", (code, signal) => …)`; when `code === null`
   (killed by a signal and not our timeout) the exit is `1` (write `1` to the exit file), never `0`. Remove `code ?? 0`.
3. **Command wrapping**: every `{ ${cmd}; }` that wraps a user/fake command (Check, `ORCH_RUNNER_FAKE_EXEC`,
   `ORCH_RUNNER_FAKE_REVIEW`) becomes `{\n${cmd}\n}` so a trailing comment or heredoc delimiter still works.
4. **Test cleanup** (test end, ~line 243): replace `process.exit(0)` / `process.exit(1)` with `process.exitCode = 0 / 1`
   so the `finally` block removes the temp dirs.
5. **Args** (~line 88): `--card`, `--name`, `--executor`, `--risk`, `--repo` must each be a non-empty string; otherwise
   print the error and exit 2 (before any `path.resolve`).
Check: `node runner/test-run-card.mjs` → `6/6 passed`, and afterwards no `run-card` temp dirs left (the test removes them).
Run the Check in the foreground and wait for it to finish before replying.

## Acceptance
- verdict: accepted (review FAIL → Fix 1; fix diff read by Claude, all 5 findings fixed; no second conformance review)
- files: `runner/run-card.mjs` (new), `runner/test-run-card.mjs` (new)
- check: `node runner/test-run-card.mjs` → 6/6 passed, re-run independently by Claude after round 1 and after Fix 1; temp dirs cleaned after Fix 1
- note: in round 1 agy replied "launched the Check and am waiting" (ran it in the background); Claude's own re-run is the evidence
- tokens:
  - round 1: exec gemini-3.8-flash-high: fresh 549k, cached 1801k, out 63k · review gpt-6.1-sol: fresh 30k, cached 106k, out 1k
  - Fix 1 (agy stream is cumulative over the conversation; Fix 1 alone ≈ fresh 266k, cached 3058k, out 14k): exec gemini-3.8-flash-high: fresh 815k, cached 4859k, out 77k
- review findings: 5 real / 0 false positive / 0 missed (medium, gpt-6.1-sol)
- K missed backfill (retro 2026-10-05): 3 (found after acceptance): worktree rename ( R) not parsed — /rv sol, fixed 834eeee; Check output never scope-checked — audit sol, fixed 2177aee; per-stage timeouts exceed the 2 h Bash limit — audit sol, fixed 2177aee
- K missed backfill (audit sol 2026-10-05 #2): 2 — staged rename drops the source path from scope check and commit (snapshot.mjs); reviewer gets HEAD-to-now diff for files already dirty before the task (review.mjs)
