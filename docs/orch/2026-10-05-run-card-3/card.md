# run-card-3 — per-run agy tokens, --fix N, Acceptance draft, --commit

## Goal
(1) `ledger.mjs` reports agy tokens per run (sum of `step_update` usages), not the conversation-cumulative `result`
usage, and has `--json`; (2) `run-card.mjs --fix N` runs a card's `## Fix N` (Check + files check, no review) and
prints the fix diff; (3) a passing run appends `## Acceptance (draft)` to the card; (4) `run-card.mjs --commit`
commits only the card's files. `node runner/test-run-card.mjs` prints `16/16 passed`.

## Risk
medium

## Parameters
- live dir for ledger.mjs: env `ORCH_RUNNER_LIVE_DIR`, default `<homedir>/.claude/agent-live` (same as run-card)
- ledger `--json` output: one JSON array on stdout, items `{ role, model, fresh, cached, out, file }` (raw token counts, not k)
- max fix rounds: 2; `--fix N` requires N = (number of recorded fixes) + 1
- new outcome: `fix_passed`; fix runs never run the review
- fix diff in the summary: first 150 lines, then `(truncated, full diff: <path>)`
- fix files in state dir: `<name>.fix<N>.base/` (copies), `<name>.fix<N>.diff`
- Acceptance draft heading exactly `## Acceptance (draft)`; placeholders exactly `TODO`
- review-log line format: `- <yyyy-mm-dd> <name>: <first line of ## Goal> (<taskDir>/card.md)`

## Files
may change: `runner/run-card.mjs`, `runner/test-run-card.mjs`, `ledger.mjs` / read-only: everything else, including
`SKILL.md`, `cost.mjs`, `HANDOFF.md`

## Steps (N = 7)
Edit the existing code in place; keep its helpers (`getSection`, `snapshot`, `runBash`, `save`, `q`, `statTree`,
`getReadOnlyDiff`, `lintCard`) and style. No new files except what the test creates in its temp dirs.

1. **ledger.mjs.** (a) Live dir from `ORCH_RUNNER_LIVE_DIR` if set. (b) agy streams: sum `usage` found in
   `event === "step_update"` lines (the usage object sits somewhere inside the event; find it the same way for every
   line, e.g. `e.usage ?? e.step?.usage ?? …` — check ONE line of `~/.claude/agent-live/agy-run-card-2.jsonl` that
   contains `"usage"` with `grep -m1` to see where); if a stream has no step usage, fall back to the `result` usage as
   now. Fields: fresh = `input_tokens`, cached = `cache_read_tokens`, out = `output_tokens`. codex unchanged.
   (c) `--json` anywhere in argv → print the JSON array (Parameters) instead of text lines; the name is the other arg.
   Expected after the change: `node ledger.mjs run-card` prints agy fresh 266k, cached 3058k, out 14k.
2. **run-card: ledger as data.** Replace the ledger call in section 8 with `node ledger.mjs <name> --json`
   (with `ORCH_RUNNER_LIVE_DIR` passed through in env), store the array in `state.ledger` (`[]` on failure), and print
   the same text lines as before from it (`<role> <model>: fresh <k>, cached <k>, out <k>  (<file>)`). After the
   executor, store `state.conversationId` = `.result.conversation_id` from the agy result line (null otherwise).
3. **`--fix N` (args).** `--fix <N>` with `--card`, `--name`, `--repo`; `--executor`/`--risk` optional and taken from
   the state file `<name>.json` (if given they must match it). Errors → exit 2: no state file; N not an integer;
   N ≠ `(state.fixes?.length ?? 0) + 1`; N > 2; the card has no line exactly `## Fix <N>` (find it directly, not with
   `getSection`, which would match the first `## Fix`). Lint is not run for fixes.
4. **`--fix N` (run).** Order:
   a. `state.rounds` (array, create if missing): if empty, push `{ round: "1", ledger: state.ledger }` first.
   b. Base copies: for every path in `mayChange` that is an existing file plus every path in `state.touched`, copy it
      to `<stateDir>/<name>.fix<N>.base/<path>` (mkdir -p; a path that does not exist is recorded as absent).
   c. Fresh git `before` snapshot and read-only `before` (reuse the same functions); clear only this executor's
      `.progress` and `.exit` (not the review files).
   d. Executor prompt: `Read <abs card> and carry out ## Fix <N> exactly; run only the commands it names; do NOT run the Check — the runner runs it after you exit; do not commit. Reply: first line exactly STATUS: done, STATUS: blocked or STATUS: failed; then files changed and anything you could not do. <progress line>`
      agy: add `--conversation <state.conversationId>` when it is set and `--fresh` was not given; luna/sol: a fresh
      `codex exec` as for a normal run. Same stream file as the normal run (overwritten with `>`).
   e. Then exactly the normal sections: timeout/failed/blocked handling, read-only comparison, touched files (against
      the fix's own `before`), Check, read-only comparison after Check. No review: if nothing set an outcome →
      `fix_passed`.
   f. Fix diff: for each base path, `git diff --no-index -- <base copy or /dev/null> <repo path or /dev/null>`
      (exit 1 just means "differs"); also include any touched path not in the base list. Write the concatenation to
      `<name>.fix<N>.diff`; the summary prints its first 150 lines, then the truncation line when longer.
   g. Ledger rows for this run → push `{ round: "Fix <N>", ledger, outcome, fresh: <bool --fresh> }` to `state.rounds`
      and `{ n: N, outcome }` to `state.fixes`. Save.
5. **Acceptance draft.** When the outcome is `review_pass`, `passed_no_review`, `fix_passed` or `recon_done`: remove
   an existing `## Acceptance (draft)` section from the card (from that heading to the next `## ` heading or end of
   file) and append:
   ```
   ## Acceptance (draft)
   - verdict: TODO (accepted / review pending / rejected)
   - files: <all touched paths over every round, comma-separated, or ->
   - check: `<check>` → exit <exit> (run by run-card)
   - tokens:
     - round 1: <ledger text rows joined by " · ">
     - Fix <N>: <…>   (one line per entry of state.rounds; when state.rounds is empty, just `round 1` from state.ledger)
   - review findings: TODO N real / M false positive / K missed (<risk>, <reviewer or "no review">)
   ```
   Card edits by the runner happen only after every check of that run is finished, so they never count as touched.
6. **`--commit`.** `node run-card.mjs --commit --name <name> --message <msg>` (repo and card from the state file).
   Refuse (exit 2, reason on stderr) when: no state file; the card still contains `## Acceptance (draft)` or the word
   `TODO` inside its `## Acceptance` section; there is no `## Acceptance` section. Files to stage: (all touched paths over
   every round) ∩ `mayChange`, plus `<taskDir>/card.md`, plus `<taskDir>/review.md` if it exists. If
   `<repo>/docs/review-log.md` exists, append the review-log line (Parameters) and stage it too. Run
   `git -C <repo> add -- <files>` then `git -C <repo> commit -m <msg> -- <files>` (pathspec, so nothing else staged is
   committed). Print the new `git rev-parse --short HEAD`, store it as `state.commit`, save, exit 0.
7. **Tests** (`runner/test-run-card.mjs`), all 12 existing cases keep passing; add (final line `16/16 passed`):
   - M (fix): case-A-like run (passes, risk low) → card gets `## Acceptance (draft)`; append `## Fix 1` to the card
     (commit nothing), run `--fix 1` with fake exec `echo y > b.txt; echo 'STATUS: done'` → `fix_passed`,
     `state.fixes.length === 1`, the `.fix1.diff` file contains `+y`, and the card has exactly one
     `## Acceptance (draft)` whose tokens part has a `Fix 1` line.
   - N (fix guards): right after M, `--fix 3` → exit 2; on a fresh name with no state file `--fix 1` → exit 2.
   - O (commit): after M, `--commit` refuses (exit 2) while the draft heading is there; then replace the draft section
     by `## Acceptance` + `- verdict: accepted`, create an unrelated untracked `z.txt`, run `--commit --message t`
     → exit 0 and `git show --name-only --format= HEAD` lists exactly `a.txt`, `b.txt`, `docs/orch/t/card.md`.
   - P (ledger): write `agy-ledgertest.jsonl` into the temp live dir with an `init` line, two `step_update` lines carrying
     usage `{input_tokens: 100, cache_read_tokens: 1000, output_tokens: 10}` each (same shape as the real stream), and a
     `result` line with cumulative usage `{input_tokens: 999999, …}`; `node ledger.mjs ledgertest --json` with
     `ORCH_RUNNER_LIVE_DIR` → `fresh 200, cached 2000, out 20`.

## Check
`node runner/test-run-card.mjs`

## Don't
No commits, no other files, no refactors beyond the steps; don't edit SKILL.md, cost.mjs or HANDOFF.md.
Don't install packages. Don't run real agy/codex executors from the test.
"Run scripts in the foreground and wait; before replying, stop any background task still running."
"Reuse existing functions; don't copy existing logic." "No rm, no git push, no git checkout . / restore . / reset --hard."
(The test's `git reset --hard` / `git clean` / commits inside its own temp repo are the only exception.)

## Acceptance
- verdict: accepted
- runner outcome: check_failed (agy reported STATUS: done; the file did not even load). No review was spent on it.
- Claude fixed directly (all mechanical): 3 duplicate top-level declarations (`liveDir`, `normLiveDir`, `stateDir`) left after agy hoisted them; draft-heading regex `\(draft\)\b` never matches at end of line → `\(draft\)\s*$` (2 places); then review finding 1: `--commit` validates `--name` like normal runs
- files: `ledger.mjs`, `runner/run-card.mjs`, `runner/test-run-card.mjs`
- check: `node runner/test-run-card.mjs` → 16/16 passed (Claude, after the fixes); `node ledger.mjs run-card` now reports the per-run agy numbers (266k / 3058k / 14k)
- tokens: exec gemini-3.8-flash-high: fresh 973k, cached 7393k, out 103k · review gpt-6-luna (dispatched manually after the fixes): see ledger
- review findings: 1 real / 0 false positive / 0 missed (medium, gpt-6-luna); plus 2 bugs caught by the runner's Check before review
- lesson: with the Check owned by the runner, the executor ships unverified code; card 4 adds a cheap syntax self-check (`node --check`) to the executor prompt
- K missed backfill (retro 2026-10-05): 4 (found after acceptance): --commit failed on a never-tracked file removed by a fix; fix-round ledger charged the old review; --fix accepted a different card/repo — /rv sol, fixed 834eeee; fix base copies skipped files under allowed directories — audit sol, fixed 2177aee
