# run-card-5 — audit fixes (post-Check scope check, linked read-only dirs, one deadline, fix base dirs) + shorter code

## Goal
Four bugs from sol's whole-repo audit are fixed and covered by tests, and the runner code is shorter with the same
behaviour: files the Check creates are scope-checked; the read-only guard follows symlinks/junctions; all stages share
one deadline; fix baselines include existing files under allowed directories; the test file uses one helper to run
the runner. `node runner/test-run-card.mjs` prints `23/23 passed`.

## Risk
medium

## Parameters
- overall deadline: `--timeout-min` (default 100) is now the budget for the whole run (executor + Check + review +
  retry); each stage gets `remaining = deadline - now` minutes; the Check additionally capped at 30 minutes; a stage
  started with `remaining <= 0` is not started and the outcome is `interrupted`
- linked read-only entries: follow with `fs.statSync` (follows links); skip an entry whose `fs.realpathSync` was already
  visited (cycle guard)
- test helper name: `runCard(name, { risk, env, args, card })`, returns the `spawnSync` result

## Files
may change: `runner/run-card.mjs`, `runner/test-run-card.mjs`, `runner/stats.mjs` / read-only: everything else,
including `SKILL.md`, `ledger.mjs`, `cost.mjs`, `HANDOFF.md`, `runner/lib.mjs`, `runner/run-long.mjs`

## Steps (N = 8)
Keep behaviour of every existing case; keep existing helpers (`getSection`, `snapshot`, `statTree`,
`getReadOnlyDiff`, `runBash`, `save`, `lintCard`, `isJunkPath`) and style.

1. **Scope check after the Check** (`run-card.mjs`, section 6 "Check", ~line 861, and section 5 ~line 810).
   Move the body of section 5 that computes `touched`, `outOfScope`, `junk` from `state.before` and a fresh
   `snapshot()` into a function `scopeCheck()` that sets `state.after`, `state.touched`, `state.outOfScope`,
   `state.junk` and returns `outOfScope`. Section 5 calls it as before (card-modified check stays there). In section 6,
   after the Check has run (whatever its exit, also on timeout) and before the existing read-only comparison, call
   `scopeCheck()` again; if it returns paths and the outcome is not already set by a read-only violation, outcome
   `out_of_scope` (it overrides `check_failed`, because files outside the card are the first thing the user must see).
   Fix runs (`--fix`) use the same path. Bypass paths: executor timeout/failed/blocked never reach the Check — fine.
2. **Linked read-only entries** (`statTree`, ~line 633). In `walk`, for an entry that is a symbolic link (or
   `!entry.isFile() && !entry.isDirectory()`), use `fs.statSync(fullPath)` to decide file vs directory. Keep a `Set` of
   `fs.realpathSync` of every directory walked (the roots too); skip a directory whose real path is in it.
   The existing exclusions (`.git`, `normLiveDir`, `cardDirNorm`) stay.
3. **One deadline.** `const deadline = Date.now() + timeoutMin * 60000` right after `timeoutMin` is parsed (~line 336).
   Helper `const remainingMin = () => (deadline - Date.now()) / 60000;`. Executor (~739), review (~939) and retry
   (~958) pass `timeoutMin: remainingMin()`; the Check (~867) passes `Math.min(30, remainingMin())`. Before starting
   each of those four, if `remainingMin() <= 0`: outcome `interrupted`, `state.interruptedAt = "<stage>"`, skip the rest.
4. **Fix base copies include directories** (~line 480). For a `mayChange` entry that is an existing directory, add every
   file under it (recursive, skip `.git` and `node_modules`; repo-relative, forward slashes) to `basePathsSet`.
5. **Review attempts as a loop** (section 7, ~line 931–970). Replace the duplicated review command / verdict read with
   `for (let attempt = 0; attempt < 2; attempt++)`: attempt 0 redirects `>`, attempt 1 `>>` and deletes `review.md`
   first; break unless the reviewer exited 0 with no VERDICT first line; `state.review.retried = attempt === 1`.
   Same outcomes as now.
6. **Executor reply in one loop** (~line 748). One reverse loop over the stream's JSON lines: agy → the `result` event's
   reply, codex → the first `item.type === "agent_message"` from the end; the existing fallback (last 15 non-empty
   lines) stays.
7. **stats.mjs** (~line 52): accumulate per group directly (`g.cards++`, `g.fixes += …`, sums, `g.tokenCards++` when
   the card has numeric exec rows, outcome counts) instead of storing per-card arrays and reducing. Same output.
8. **Tests** (`test-run-card.mjs`): add `runCard(name, { risk, env, args, card })` (Parameters) and use it in every
   existing case that runs `run-card.mjs` (assertions unchanged). Add cases (final line `23/23 passed`):
   - T: fake exec only writes `b.txt` (allowed); Check `node -e "require('fs').writeFileSync('z.txt','1')"` →
     `out_of_scope` with `z.txt` in `outOfScope`.
   - U: the read-only dir `data/` contains a directory symlink `data/link` → a temp dir outside the repo holding `f.txt`
     (create with `fs.symlinkSync(target, link, "junction")`); fake exec appends to `<target>/f.txt` →
     `readonly_violated`.
   - V: `--timeout-min 0.1`, fake exec `sleep 4; echo 'STATUS: done'`, Check `sleep 4` (bash) → finishes within 12 s with
     outcome `interrupted` (the Check got only the remaining ~2 s).
   - W: card Files `` may change: `src/` ``, repo commits `src/old.txt` = "a"; round 1 fake exec writes `src/new.txt`
     (risk low → `passed_no_review`); append `## Fix 1`; `--fix 1` fake exec `echo b > src/old.txt` → the fix diff
     contains `-a` and `+b` for `src/old.txt` (not a whole-file add).

## Check
`node runner/test-run-card.mjs`

## Don't
No commits, no other files, no refactors beyond the steps; don't edit SKILL.md, ledger.mjs, cost.mjs, HANDOFF.md,
lib.mjs or run-long.mjs. Don't install packages. Don't run real agy/codex executors from the test.
"Run scripts in the foreground and wait; before replying, stop any background task still running."
"Reuse existing functions; don't copy existing logic." "No rm, no git push, no git checkout . / restore . / reset --hard."
(The test's `git reset --hard` / `git clean` / commits inside its own temp repo are the only exception.)

## Acceptance
- verdict: accepted (first card through the full runner path: review_pass, draft filled by the runner, committed with --commit)
- files: runner/run-card.mjs, runner/stats.mjs, runner/test-run-card.mjs
- check: `node runner/test-run-card.mjs` → exit 0 (run by run-card)
- tokens:
  - round 1: exec gemini-3.8-flash-high: fresh 764k, cached 9343k, out 94k  (agy-run-card-5.jsonl) · review gpt-6-luna: fresh 32k, cached 104k, out 1k  (codex-review-run-card-5.jsonl)
- review findings: 0 real / 0 false positive / 0 missed (medium, gpt-6-luna)
- check re-run by Claude: 23/23 passed, no temp dirs left
- size: run-card.mjs 1211 → 1278, test 813 → 842, stats 99 → 97. The four fixes added more than the simplifications removed; sol's "-207 lines" estimate did not hold (the test helper saved far less than 150 lines)
