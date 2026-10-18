# scope-fp — runner stops calling other writers' files the executor's fault; full reply saved; --review-only

## Goal
From the 2026-10-06/07 brain-analysis session (3 false `out_of_scope`, 1 false `readonly_violated`, a truncated recon
reply, a refused `## Fix 1 (N = 3)`):
- other tasks' `docs/orch/*/card.md|review.md|reply.md` never count as touched;
- a path inside the `## Files` may-change list of a **concurrent** run on the same repo is reported as `concurrent`, not out of scope / read-only violation;
- the executor's full final reply is saved to `<card dir>/reply.md` and the summary points to it;
- `## Fix N` matches with trailing text (`## Fix 1 (N = 3)`);
- `--review-only --name X` runs just the tier's review on the current tree from saved state;
- `--commit` accepts an `out_of_scope` run when Acceptance has a `- scope override: <reason>` line and a `--recheck` and `--review-only` after it passed.
`node runner/test-run-card.mjs` passes with new cases for each.

## Risk
medium (shared tooling; reviewer is sol anyway)

## Parameters
- exempt pattern (repo-relative, `/` separators): `^docs/orch/[^/]+/(card|review|reply)\.md$`
- a run is **concurrent** when its state file in the same `stateDir` (not this run's own name) has the same `repo` and either
  has no `outcome` yet or its state file mtime is later than this run's `startedAt`
- reply file: `<directory of the card>/reply.md`, written whenever `state.exec.reply` is set (recon or not); overwritten per round
- fix heading regex: `^## Fix ${N}(\s|$)` on the trimmed line (both where the heading is checked and where the section is extracted)
- scope-override line regex in `## Acceptance`: `^- scope override: .+`

## Files
may change: `runner/run-card.mjs`, `runner/card.mjs`, `runner/commit.mjs`, `runner/review.mjs`, `runner/test-run-card.mjs`, `SKILL.md`
read-only: `runner/run-long.mjs`, `runner/stats.mjs`, `runner/executor.mjs`, `runner/snapshot.mjs`, `runner/lib.mjs`, `runner/acceptance.mjs`

## Steps (N = 7)

1. Read `runner/run-card.mjs` (`scopeCheck` ~l.495, the read-only guard ~l.385 and ~l.590, the fix heading check l.165,
   the summary ~l.820), `runner/commit.mjs` (`runCommit`, `runRecheck`), `runner/review.mjs` (`runReview`), `runner/card.mjs`
   (`parseArgs`, `getSection`), and `SKILL.md` (the orchestrate skill text).
2. Exemption: in `scopeCheck`, skip paths matching the exempt pattern (like `exemptPaths`). The same pattern must not
   trigger `readonly_violated`.
3. Concurrent attribution: one helper `concurrentClaims(stateDir, self)` returning `[{name, mayChange}]` per Parameters.
   In `scopeCheck`, a touched path allowed by a concurrent run's `mayChange` (same matching rule as own `mayChange`) goes to
   `state.concurrent = [{path, name}]` instead of `outOfScope`. In the read-only guard(s), a changed read-only path that a
   concurrent run on **any** repo may change (compare absolute paths) also goes to `state.concurrent` instead of a violation.
   Summary prints `concurrent: <path> (<name>), ...` when non-empty. Every path that sets `out_of_scope` or
   `readonly_violated` (initial run, `--fix`, `--recheck`) goes through this.
4. Reply: after the executor returns (initial run and `--fix`), write `state.exec.reply` to `reply.md` per Parameters;
   the summary keeps its tail but adds `full reply: <path>`. `--commit` stages `reply.md` with `card.md` and `review.md`.
5. Fix heading: replace the exact-match check (l.165) and any fix-section lookup with the regex in Parameters.
6. `--review-only --name X`: in `parseArgs` accept the flag; in `run-card.mjs` dispatch it like `--recheck` (saved state:
   card, repo, executor, risk, reviewer tier); call `runReview` with the same inputs the main flow uses; write `review.md`;
   set `state.outcome` to `review_pass`/`review_fail` only if the current outcome is `out_of_scope`, `review_error`, or
   `review_pending`, else leave it and record `state.reviewOnly = {verdict, at}`; print a 3-line summary. In `runCommit`,
   allow `verdict: accepted` for an `out_of_scope` outcome only when the Acceptance has the scope-override line, the last
   recheck passed, and `state.reviewOnly.verdict === "PASS"` (or the outcome is now `review_pass`).
7. Tests in `runner/test-run-card.mjs`, reusing its existing temp-repo / fake-executor / fake-reviewer helpers: (a) a fake
   executor that also writes `docs/orch/other/card.md` → not out of scope; (b) a second state file with the same repo, no
   outcome, `mayChange` covering a file the fake executor does not own but which changes → `concurrent`, not out of scope;
   (c) `## Fix 1 (N = 2)` is accepted by `--fix 1`; (d) `reply.md` exists after a run and holds the full reply; (e)
   `--review-only` on an `out_of_scope` state with a fake PASS reviewer → `review_pass`; then `--commit` with a
   scope-override line succeeds. Finally update `SKILL.md` (orchestrate): in the outcome table row `out_of_scope` add one
   line: false positive → add `- scope override: <reason>`, run `--recheck` and `--review-only`, then `--commit`; mention
   `reply.md` where the folder contents are described ("holds only card.md and review.md" → also reply.md). Run
   `node --check` on each changed `.mjs`. Do not run the Check yourself.

## Check
`node runner/test-run-card.mjs`

## Don't
- No commits, no other files, no refactors beyond the steps.
- "Run scripts in the foreground and wait; before replying, stop any background task still running."
- "Reuse existing functions; don't copy existing logic."
- "No rm, no git push, no git checkout . / restore . / reset --hard."

## Fix 1
1. `runner/test-run-card.mjs` ~l.500 (case-m `--commit`): the run now writes `docs/orch/t/reply.md` and `--commit` stages it
   (card step 4), so the expected committed list is
   `["a.txt", "b.txt", "c.txt", "docs/orch/t/card.md", "docs/orch/t/reply.md"]`. Update that assertion only.
2. Search the test file for any other exact committed/touched-file list that a run producing `reply.md` now changes and
   update it the same way; change no runner code. `node --check runner/test-run-card.mjs`. Do not run the Check.

## Acceptance
- verdict: accepted (finished by codex directly; Claude out of quota)
- check: node runner/test-run-card.mjs → exit 0
