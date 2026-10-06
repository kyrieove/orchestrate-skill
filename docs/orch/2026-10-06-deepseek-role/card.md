# deepseek-role — wb stops reviewing and becomes agy's fallback; the review tier can only go up

## Goal
1. Reviews only ever run on codex. The runner never sends a review to wb (DeepSeek). If codex's quota is used up when the review starts, or the review dies with quota text, the outcome is `review_pending`, not wb and not `review_error`.
2. The reviewer floor: sol when the executor is luna or sol, when risk is high, or when `--reviewer sol` is given; otherwise luna. `--reviewer luna` can no longer lower it. When it asked for luna but the floor is sol, `state.review.raised = true`.
3. wb is now the fallback for agy, not for codex. File `agy-fallback`: `on` → agy cards run on wb; `off` → always agy; anything else or missing = `auto` → wb only while the antigravity quota (5h or 7d) is full, checked once at dispatch. luna and sol never fall back: if codex's quota is full, the runner exits 2 before starting.
4. All 28 existing test cases still pass after their wb-review expectations are updated as below, plus the new cases.

## Risk
high — shared tooling that every later card runs through. Key point Claude will re-check by hand: a high-risk run with `--reviewer luna` records `gpt-6.1-sol`; a review with the quota full ends `review_pending` without starting codex.

## Parameters
- fallback file: env `ORCH_AGY_FALLBACK_FILE`, default `C:/Users/ASUS/.claude/skills/orchestrate/agy-fallback`
- quota script: env `ORCH_QUOTA_SCRIPT`, default `D:/2/dev/token-weather-quotas/hooks/quota.mjs`; its JSON has keys `codex` and `antigravity`, each `{ five: { pct, resetMs }, week: { pct, resetMs } }`; "full" means `pct >= 100` in either window
- quota text in a dead review stream (case-insensitive): `/usage limit|quota|rate.?limit|\b429\b/`
- WB model stays `deepseek-v4.1-flash` (`WB_MODEL` in lib.mjs)
- new outcome name: `review_pending`; `state.review.verdict = "pending"`, `state.review.reason` = `"codex quota used up"`

## Files
may change: `runner/lib.mjs`, `runner/executor.mjs`, `runner/review.mjs`, `runner/run-card.mjs`, `runner/acceptance.mjs`, `runner/test-run-card.mjs`
read-only: `SKILL.md`, `HANDOFF.md`, `runner/card.mjs`, `runner/commit.mjs`, `runner/snapshot.mjs`, `runner/stats.mjs`, `runner/run-long.mjs`

## Steps (N = 6)
1. `runner/lib.mjs`: replace `CODEX_FALLBACK_FILE`, `codexMode`, `codexQuota`, `codexFallback` with:
   ```js
   export const AGY_FALLBACK_FILE = process.env.ORCH_AGY_FALLBACK_FILE || "C:/Users/ASUS/.claude/skills/orchestrate/agy-fallback";
   export function agyMode() { /* same body as the old codexMode, reading AGY_FALLBACK_FILE */ }
   // key: "codex" | "antigravity". Returns { five, week, full } or null when the script is missing or fails.
   export function quotaOf(key) { /* the old codexQuota body, reading quota[key] instead of quota.codex */ }
   export function agyFallback() { const m = agyMode(); return m === "on" || (m === "auto" && quotaOf("antigravity")?.full === true); }
   ```
   Keep the comments short and update them to the new meaning.
2. `runner/executor.mjs`: import `agyFallback` instead of `codexFallback`. Before the `if (process.env.ORCH_RUNNER_FAKE_EXEC)` chain compute `state.execViaWb = !process.env.ORCH_RUNNER_FAKE_EXEC && executor === "agy" && agyFallback();`. Reorder the chain to: fake → `executor === "wb" || state.execViaWb` (the existing wb command) → `executor === "agy"` → codex. The codex branch no longer checks any fallback. Fix rounds take the same path (the value is recomputed each run).
3. `runner/review.mjs`:
   - reviewer: `const floorSol = executor === "luna" || executor === "sol" || risk === "high" || args.reviewer === "sol"; reviewer = floorSol ? "gpt-6.1-sol" : "gpt-6-luna";` and `if (args.reviewer === "luna" && floorSol) state.review.raised = true` (set after `state.review = {...}` is created).
   - delete the wb review path entirely: the `wb` variable, `preReview`, the wb `reviewCmd` branch, the wb result-to-review.md block, and the `if (preReview) {...}` block at the end; drop the now-unused imports.
   - right after `state.review = { model: reviewer, verdict: null }`: if `quotaOf("codex")?.full` → `state.outcome = "review_pending"; state.review.verdict = "pending"; state.review.reason = "codex quota used up"; save(state); return;`. This check runs before the `ORCH_RUNNER_FAKE_REVIEW` branch, so tests can hit it.
   - where `reviewRes.exit !== 0` sets `review_error`: first read the review stream (if it exists), and if it matches the quota regex from Parameters, set `review_pending` / `"pending"` / reason `"codex quota used up"` instead. Every other non-zero exit stays `review_error`.
4. `runner/run-card.mjs`:
   - import `quotaOf` instead of `codexMode, codexQuota`.
   - the precheck: `const needsCodex = !args.commit && ["luna", "sol"].includes(executor);` then `const quota = needsCodex ? quotaOf("codex") : null;` and when `quota?.full` print `codex quota used up (5h X%, 7d Y%, resets <when>): wait for the reset or pick another executor` (same number/date formatting as now) and `process.exit(2)`. Reviews are not prechecked any more (they go `review_pending` instead). Update the comment above it.
   - summary `executor:` line: `→ wb deepseek-v4.1-flash (agy fallback)` instead of `(codex fallback)`.
   - summary `review:` line: when `state.review.verdict === "pending"` print `review: pending ${state.review.model} (${state.review.reason})`; when `state.review.raised` append ` (luna requested, floor sol)`.
5. `runner/acceptance.mjs`: add `"review_pending"` to `draftOutcomes`, and when the outcome is `review_pending` the verdict line of the draft reads `- verdict: review pending (codex quota used up) — TODO accept provisionally` instead of the usual TODO.
6. `runner/test-run-card.mjs`: env `ORCH_CODEX_FALLBACK_FILE` → `ORCH_AGY_FALLBACK_FILE` (`${tempLive}/agy-fallback`) everywhere. Then:
   - Case Y → agy-fallback `on` + `--executor agy`, risk medium, fake codebuddy for exec, `ORCH_RUNNER_FAKE_REVIEW` for the review: `review_pass`, exactly 1 codebuddy call with `--model deepseek-v4.1-flash`, `state.execViaWb === true`, `state.review.model === "gpt-6-luna"`.
   - Case Q → `--executor luna` with the codex-full quota script and no fallback file: exit 2, stderr has `codex quota used up (5h 100%, 7d 40%` and `pick another executor`, no state file.
   - Case Q2 → `--executor agy` (fake exec), risk medium, codex-full quota script: exit 0, outcome `review_pending`, `review.verdict === "pending"`, the fake review never ran (its marker file absent), summary stdout contains `review: pending`.
   - Case Q3 → risk medium, quota script missing, `ORCH_RUNNER_FAKE_REVIEW` = `echo 'Error: usage limit reached'; exit 1`: outcome `review_pending`.
   - Case Q4 (new) → agy-fallback absent (= auto), quota script reporting `antigravity` 5h at 100% and codex at 10%, `--executor agy`, risk low, fake codebuddy exec: `state.execViaWb === true`, 1 codebuddy call.
   - Case Q5 (new) → risk high, `--reviewer luna`, fake exec + fake review PASS: `state.review.model === "gpt-6.1-sol"`, `state.review.raised === true`, summary contains `floor sol`.
   - Case R (wb review guard) → delete it (there is no wb review any more). Case Z unchanged.
   Keep each case's existing style (resetRepo, writeCard, runCard, readState, passedCount++).

Bypass paths for the new checks: fix rounds (`--fix N`) run no review, so they cannot reach the quota check — fine; `--recon` runs no review — fine; the `ORCH_RUNNER_FAKE_EXEC` path must not set `execViaWb` (step 2 covers it); the second review attempt (retry loop) must also go `review_pending` on quota text (step 3's check sits where every attempt's non-zero exit lands).

## Check
`node runner/test-run-card.mjs`

## Don't
- No commits, no other files, no refactors beyond the steps; reuse `wbCmd`, `WB_MODEL`, `runBash`, `snapshot` instead of copying them. Do not edit SKILL.md or HANDOFF.md (Claude does).
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.

## Acceptance
- verdict: accepted. Claude 复核：读了 review.mjs diff（floorSol 只升不降、配额满在 fake review 前返回 review_pending）；自修 1 处：配额正则只查流末尾 2000 字符，避免审查正文里的 "quota" 误判；复跑 31/31 通过
- files: runner/acceptance.mjs, runner/executor.mjs, runner/lib.mjs, runner/review.mjs, runner/run-card.mjs, runner/test-run-card.mjs
- check: `node runner/test-run-card.mjs` → exit 0 (run by run-card)
- tokens:
  - round 1: exec gemini-3.8-flash-high: fresh 301k, cached 2041k, out 56k  (agy-deepseek-role.jsonl) · review gpt-6.1-sol: fresh 54k, cached 163k, out 1k  (codex-review-deepseek-role.jsonl)
- review findings: 0 real / 0 false positive / 1 bloat 未改（测试 fake codebuddy 残留审查分支，无害）/ K missed 0 (high, gpt-6.1-sol)
