# commit-gate — `--commit` refuses when the run's outcome and the Acceptance verdict disagree

## Goal
`run-card.mjs --commit` reads the Acceptance verdict and the state file's `outcome`, and commits only when they agree
(table in Parameters). Otherwise it exits 2 with one line `commit refused: outcome=<o>, verdict=<v>: <reason>` and
commits nothing. All existing test cases still pass; the new cases below pass.

## Risk
medium — shared tooling (reviewer sol via `--reviewer sol`).

## Parameters
- verdict regex on the `## Acceptance` section: `/^-\s*verdict:\s*(accepted|review pending|rejected)\b/im`; no match → verdict `missing`
- claude-fix regex on the same section: `/^-\s*claude fix:\s*\S/im`
- allowed pairs (anything else is refused):
  - `accepted` + outcome in `review_pass`, `passed_no_review`, `fix_passed`, `recon_done`
  - `accepted` + outcome in `review_fail`, `check_failed` only when the claude-fix line is present (Claude fixed the finding directly and re-ran the Check)
  - `review pending` + outcome `review_pending`
- reasons (exact text): `rejected cards are not committed` (verdict rejected); `no "- verdict:" line in ## Acceptance` (missing); `outcome does not allow this verdict` (every other refusal)
- `state.outcome` missing → treat as `"none"`

## Files
may change: `runner/commit.mjs`, `runner/test-run-card.mjs`
read-only: `runner/run-card.mjs`, `runner/card.mjs`, `runner/lib.mjs`, `runner/review.mjs`, `runner/executor.mjs`, `runner/acceptance.mjs`, `SKILL.md`, `HANDOFF.md`

## Steps (N = 3)
1. `runner/commit.mjs` → `runCommit`: right after the existing `TODO found in ## Acceptance section` check, add the gate:
   parse the verdict and the claude-fix line from `acceptanceSection` with the two regexes in Parameters, take
   `const outcome = state.outcome ?? "none"`, decide with the allowed pairs, and on refusal
   `console.error(\`commit refused: outcome=${outcome}, verdict=${verdict}: ${reason}\`); process.exit(2);`.
   Keep it as a few plain statements (one `Set` of pass outcomes, one of fixable outcomes); no new module, no helper
   exported. Nothing before this point writes anything, so the refusal leaves the repo and state file untouched.
2. `runner/test-run-card.mjs`, Case O: it writes `- verdict: accepted` after a case-m run; first confirm (read the
   state file in the test) that case-m's outcome is one of the pass outcomes so O still exits 0. Do not change O's
   assertions.
3. `runner/test-run-card.mjs`: add Case O5 right after Case O, same style (`resetRepo`, `writeCard`, `runCard`,
   `readState`, `passedCount++`):
   - (a) risk medium with `ORCH_RUNNER_FAKE_REVIEW` writing `VERDICT: FAIL` to `docs/orch/t/review.md` → outcome `review_fail`; replace the draft Acceptance with `## Acceptance\n- verdict: accepted\n`; `--commit --message t` → exit 2, stderr contains `commit refused: outcome=review_fail, verdict=accepted`, and `git rev-parse HEAD` is unchanged.
   - (b) same card, add the line `- claude fix: fixed the finding` → `--commit` exits 0.
   - (c) a fresh pass run (fake review PASS) with `- verdict: review pending` → exit 2 with `outcome does not allow this verdict`.
   - (d) a fresh pass run with `- verdict: rejected` → exit 2 with `rejected cards are not committed`.
   - (e) a fresh pass run whose Acceptance has no verdict line (just `## Acceptance\n- files: a.txt\n`) → exit 2 with `no "- verdict:" line`.
   Use a distinct `--name` per sub-case so the state files do not collide.

Bypass paths: `--commit` has a single entry (`runCommit`), and the gate sits before `git add`, the review-log append and the state write; the earlier exits (draft heading, missing section, TODO) stay before it. No other path commits.

## Check
`node runner/test-run-card.mjs`

## Don't
- No commits, no other files, no refactors beyond the steps; reuse `getSection` from `card.mjs`.
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.

## Acceptance
- verdict: accepted
- files: runner/commit.mjs, runner/test-run-card.mjs
- check: `node runner/test-run-card.mjs` → 32/32 passed (re-run by Claude after the fix)
- tokens:
  - round 1: exec gemini-3.8-flash-high: fresh 147k, cached 1420k, out 37k · review gpt-6.1-sol: fresh 26k, cached 91k, out 1k
- review findings: 1 real / 0 false positive / K missed 0 (medium, gpt-6.1-sol)
- claude fix: Case O now asserts case-m's outcome is one of the 4 pass outcomes (card step 2 had been skipped)
