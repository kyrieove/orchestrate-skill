# orchestrate — lessons

The dates, incidents and measured costs behind the rules in [SKILL.md](SKILL.md). SKILL.md states the rules on
their own; read this file when a rule looks arbitrary, or to check whether it still holds. Sections follow SKILL.md.

## Why this shape / Who writes

- 2026-10-01: a goal-only agy card burned 2.2 M fresh + 18 M cached input tokens. Why design stays with Claude.
- 2026-10-04: dispatching a 1-line edit cost Claude 3–5k output tokens (card, dispatch, acceptance). Why small edits are written directly.

## Code worker and executor choice

- 2026-10-04: sol spent 4.5 M tokens executing the Cartool port; a typical agy card costs 0.2–0.3 M. Why heavy work goes to the code worker, not sol.
- 2026-10-05 (user): after 4 cards the user rated wb above agy. Why `/orch` once asked which code worker to use (from 2026-10-18 Claude picks and states the reason, ADR-0003).
- 2026-10-06 (user): wb is agy's fallback only, never a reviewer; always flash, never another DeepSeek model.
- 2026-10-01 (user): luna and sol need no permission prompt.

## Executor fails / Reviewer out of quota

- 2026-10-01: Claude's line-by-line review passed a card; the later sol review found 2 real bugs in it. Why a `review_pending` card is not replaced by a Claude read.

## Review

- 2026-09-24: agy passed all 5 self-checks, but an lme4 Gamma-identity GLMM underestimated the RT standard error about 5× and produced a false positive. Why the high tier: neither a self-check nor a conformance review catches a wrong number; only an independent recompute does.
- 2026-10-04 (user decision): checking a diff against a card needs no top model, so sol quota is spared.
- 2026-10-04: a subagent reported that Cartool's derivative criteria had no source; the Cartool repo has them. Why lookup claims are verified once at the primary source.
- 2026-10-05 (runner): luna found 0–1 issues per card, sol 5, and later audits 11 more. Why shared tooling takes sol even at medium risk.
- 2026-10-11 (user): an LLM review finds something new every round, so "no findings" is never the stop signal. Why findings carry P0–P3 and a confirming code line, and why review rounds are capped at two.

## Flow

- 2026-10-01: 2 of 6 cards failed review because a cache hit returned before the new check. Why a card must list every path that can bypass a new check.
- 2026-10-04: agy on v16 re-reads its context on every poll while it waits; its first run cost about 6.4 M fresh + 17.7 M cached. Why long runs go to `run-long.mjs` in the background.
- 2026-10-05: an executor fix round (`--recheck` with an executor fix) cost about 0.3 M fresh + 3 M cached tokens.
- 2026-10-05: a fresh Fix 1 cost 103k fresh tokens; a continued session cost 799k. Why `--fix` runs in a new session unless you drop `--fresh`.
- 2026-10-04 (user): change the Modes table after 10–15 cards, from `stats.mjs` and the Acceptance rows, not from impressions.

## Research data outside git

- 2026-09-24 (user, hard requirement): any script expected to run more than 10 minutes must checkpoint and resume.

## Commands (manual fallback)

- 2026-10-04: in a test, agy spent 165k input + 479k cached tokens exploring `agent-live/` for a 1-line edit. Why the progress-line instruction says not to inspect that directory.
- 2026-10-04: a progress count at the end of Y was cropped on a narrow lane, which made the lane look frozen. Why the changing count goes first in Y.
- 2026-10-04: codex with stdin left open printed "Reading additional input from stdin..." and hung. Why `< /dev/null` is required.
- 2026-10-04: without the before-snapshot paths, sol failed a card for the user's own earlier edits. Why step 3's paths go into the review prompt.
