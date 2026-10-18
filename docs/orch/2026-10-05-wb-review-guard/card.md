# wb-review-guard — a wb review that changes the repo fails; two small runner cleanups

## Goal
A wb review (CodeBuddy has no read-only sandbox) that creates, changes or deletes any repo file other than the task's
`review.md` ends with outcome `review_error`, the changed paths recorded in `state.review.wrote`. Two leftovers from the
fix-base card are cleaned up. `node runner/test-run-card.mjs` prints `28/28 passed`.

## Risk
medium

## Parameters
- guard applies only when the review ran on wb (the `wb` const in `runReview`); codex reviews are unchanged
- exempt path: the task's own `review.md` (`<taskDir>/review.md`, repo-relative, forward slashes), which the runner writes
- on a change: `state.outcome = "review_error"`, `state.review.verdict = "error"`, `state.review.wrote = [sorted paths]`
- test count: 27 → 28

## Files
may change: `runner/review.mjs`, `runner/run-card.mjs`, `runner/test-run-card.mjs` / read-only: everything else,
including `SKILL.md`, `runner/lib.mjs`, `runner/snapshot.mjs`, `runner/executor.mjs`, `ledger.mjs`

## Steps (N = 4)
Edit the existing code in place; keep its structure and style.

1. `runner/review.mjs`: import `snapshot` from `./snapshot.mjs`. In `runReview`, right after `const wb = codexFallback();`
   (and its `if (wb) reviewer = WB_MODEL;`), add `const preReview = wb ? snapshot(repoAbs, isGit) : null;`
   (`repoAbs` and `isGit` are already destructured from `ctx`; if one is not, add it to the destructuring — `run-card.mjs`
   passes both). After the attempts loop ends (after the closing `}` of `for (let attempt …)`), add:
   ```js
   if (preReview) {
     const post = snapshot(repoAbs, isGit);
     const own = path.posix.join(taskDir, "review.md").replaceAll("\\", "/");
     const wrote = [...new Set([...Object.keys(preReview), ...Object.keys(post)])]
       .filter((p) => p !== own && JSON.stringify(preReview[p]) !== JSON.stringify(post[p])).sort();
     if (wrote.length) {
       state.outcome = "review_error";
       state.review.verdict = "error";
       state.review.wrote = wrote;
       save(state);
     }
   }
   ```
   If `taskDir` is absolute rather than repo-relative, make `own` repo-relative with `path.posix.relative(repoAbs, …)`.
2. `runner/run-card.mjs` (fix-base copy loop, around `if (fs.existsSync(src) && fs.statSync(src).isFile()) { const st = fs.statSync(src);`):
   stat once — `const st = fs.existsSync(src) ? fs.statSync(src) : null; if (st?.isFile()) { … }` and drop the second
   `fs.statSync(src)`. In the fix-diff stat loop change `const before = rec.size ?? "-";` to `const before = rec.size;`.
3. `runner/test-run-card.mjs`: in the setup, delete the two lines `delete wbEnv.ORCH_RUNNER_FAKE_EXEC;` and
   `delete wbEnv.ORCH_RUNNER_FAKE_REVIEW;` (baseEnv never carries those keys). Keep Case Y's `fs.rmSync(… codex-fallback …)`
   (Case Q relies on the switch being off).
4. `runner/test-run-card.mjs`: Case R after the last existing case — a second fake bin whose `codebuddy` behaves like the
   existing one but, on the review branch (`*disallowedTools*`), first runs `echo x > wrote.txt` (cwd is the repo). Build it
   the same way as the existing fake (same `stream(...)` helper), in its own `fs.mkdtempSync` dir, cleaned in `finally`.
   `resetRepo(); writeCard(undefined, "medium");` switch file `on` (as Case Y does); run
   `runCard("case-r", { risk: "medium", env: { ...wbEnv, PATH: \`${fakeBin2}${path.delimiter}${process.env.PATH}\` }, args: ["--executor", "luna"] })`.
   Assert: exit 0; outcome `review_error`; `state.review.wrote` deep-equals `["wrote.txt"]`. Remove the switch file.
   `passedCount++`; change the final summary from 27 to 28 (the `if`, the error message and `"27/27 passed"`).

## Check
`node runner/test-run-card.mjs`

## Don't
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.
- No commits, no other files, no refactors beyond the steps. Never touch `~/.claude/skills/orchestrate/codex-fallback` or
  run `D:/2/dev/token-weather-quotas/hooks/quota.mjs`.

## Acceptance
- verdict: accepted (review on wb, codex out of quota; sol re-review pending once codex returns)
- files: runner/review.mjs, runner/run-card.mjs, runner/test-run-card.mjs
- check: `node runner/test-run-card.mjs` → exit 0 (run by run-card)
- tokens:
  - round 1: review deepseek-v4.1-flash: fresh 0k, cached 0k, out 0k  (codex-review-wb-review-guard.jsonl) · exec deepseek-v4.1-flash: fresh 0k, cached 0k, out 0k  (codex-wb-review-guard.jsonl)
- review findings: 0 real / 0 false positive / 0 missed (medium, deepseek-v4.1-flash)
