---
name: orchestrate-codex
description: Codex as the orchestrator. The Codex session (gpt-6.1-sol) writes cards, accepts and commits; agy executes; wb (CodeBuddy, deepseek-v4.1-flash) is the independent read-only reviewer. Use when the user asks for orchestrate-codex, 让 codex 编排, codex 派活, or runs the orchestrator from Codex with wb as the review gate.
---

# orchestrate-codex — role swap of orchestrate

The authority is [../SKILL.md](../SKILL.md) (task cards, risk tiers, the runner, acceptance, fixes, parallel cards). Read it in full first. This file only lists what changes when **Codex is the orchestrator**. Anything not listed here is as written there.

## Roles

| orchestrate | here |
|---|---|
| Claude: writes the card, accepts, commits | the Codex session (`gpt-6.1-sol`). Every duty SKILL.md gives Claude is the Codex session's: reading the summary, the independent recompute at high risk, `--recheck`, `--commit`, the handoff |
| agy / wb / luna / sol: executor | **agy only**: always `--executor agy`. No luna or sol executor (the orchestrator is already sol); no `/orch` executor choice |
| codex `gpt-6.1-sol`: independent read-only review | **wb** (`deepseek-v4.1-flash`): always `--reviewer wb`, on every dispatch of every risk tier |

## Dispatch

```bash
node D:/2/dev/orch-runner/orchestrate/runner/run-card.mjs --card <abs card.md> --name <name> --executor agy --reviewer wb --risk low|medium|high --repo <abs repo> # agent-live/agy-<name>.jsonl agent-live/codex-review-<name>.jsonl agent-live/codex-plan-<name>.jsonl
```

`--reviewer wb` is stored in the state: `--fix N`, `--review-only` and `--commit` use it without being told again (`--fix` refuses a different `--reviewer`). The stream files keep the `codex-review-` / `codex-plan-` names so the token lanes and `ledger.mjs` find them.

## What differs in the review

- The review and, for high risk, the pre-execution plan review run `codebuddy -p … --model deepseek-v4.1-flash --effort high -y --output-format stream-json --tools "Read,Grep,Glob,Bash" --disallowedTools "Edit Write MultiEdit NotebookEdit"`. The runner takes the reply from the stream's `{"type":"result"}` line and writes `review.md` (or the plan file) itself.
- The runner compares the repo before and after the review. A reviewer that changed any file outside `docs/orch/` ends the run `review_error` (`review.reason` lists the files): read it, fix the cause, run `--review-only` again. No provisional acceptance.
- No codex quota check, no `review_pending`: wb does not use codex quota. A failing wb call is `review_error`.
- wb flash is a weaker reviewer than sol. The finding rules are unchanged: each finding carries a P0–P3 tag and the code line that confirms it; check every P0/P1 at its `file:line` before acting on it; drop a finding you cannot confirm. Two review rounds per card at most, as in SKILL.md.
- High risk still needs the independent recompute of the key number from the raw data by the orchestrator: a review, from any model, cannot catch a wrong number.

## Not used here

- `agy-fallback`: if the summary's `executor:` line says `agy → wb` (agy quota full), the executor and the reviewer are the same model, so the review is not independent. Do not accept on it: tell the user and wait (never replace the review with the orchestrator's own line-by-line read).
- The codex conformance-review command in SKILL.md (`codex exec -s read-only …`): the runner issues the wb call itself. Run the manual fallback only if the runner is unusable, with `codebuddy` in place of `codex exec` and the same read-only flags.
- Parallel cards (`--isolation worktree`) work as written there; both cards go to agy.
