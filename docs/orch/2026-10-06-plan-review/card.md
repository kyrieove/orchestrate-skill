# plan-review — a high-risk card is reviewed read-only by sol before the executor starts

## Goal
For `--risk high` (not `--fix`, not `--recon`) the runner first runs a read-only codex `gpt-6.1-sol` session over the
card and the code it names. First line `PLAN: OK` → the run continues as today. `PLAN: REVISE` → outcome `plan_revise`,
nothing is executed, and the summary shows the findings so Claude can fix the card. Codex quota full → the runner
refuses to start a high-risk card (exit 2). Its tokens show in the ledger as role `plan`. All existing tests pass
without ever calling the real codex; the new cases pass.

## Risk
medium — shared tooling (reviewer sol via `--reviewer sol`).

## Parameters
- model: `gpt-6.1-sol`, `-c model_reasoning_effort=medium`, `codex exec -s read-only` (plus `--skip-git-repo-check` outside git), `< /dev/null`, stream `${liveDir}/codex-plan-${name}.jsonl`, exit file `${liveDir}/codex-plan-${name}.exit`, reply file `${stateDir}/${name}.plan.md` (`-o`), first stream line `{"model":"gpt-6.1-sol"}` like the review
- timeout: `Math.min(20, remainingMin())` minutes
- verdict = first line of the reply file, trimmed: `PLAN: OK` / `PLAN: REVISE`; anything else (or non-zero exit, or timeout) → outcome `plan_error`, nothing executed
- outcomes: `plan_revise`, `plan_error`; `state.plan = { model, verdict: "OK" | "REVISE" | "error", file }`
- summary line right after the `executor:` line: `plan: gpt-6.1-sol PLAN: OK` (or REVISE / error); on REVISE also print the reply file's lines 2–16
- quota: the existing precheck in run-card (`needsCodex`) also covers `risk === "high" && !isFix && !recon`; message unchanged
- test fake: env `ORCH_RUNNER_FAKE_PLAN` = a shell snippet run instead of codex (like `ORCH_RUNNER_FAKE_REVIEW`); it writes the reply file, whose path is given to it as env `ORCH_PLAN_OUT`
- prompt (exact text, `<card>` = the card's absolute path):
  `Read <card> and only the code it names (the files in ## Files and the functions in ## Steps). This card will be carried out step by step by another agent; your job is to find problems in the card itself, before execution. Do not modify or create files and do not run tests or scripts. Look for: a step that contradicts the current code (wrong function, line or behaviour), a check or invariant some path can bypass, a Parameters value that disagrees with the code or the Goal, a Check that would pass without the Goal being met, steps in an order that breaks one another, a step that is ambiguous enough to be done two ways. Reply: first line exactly PLAN: OK or PLAN: REVISE, then at most 5 findings, most severe first, each naming the card step or section, the file:line it conflicts with, the problem and the change to the card. No style or wording remarks. PLAN: REVISE only for a finding that would make a faithful execution wrong.`

## Files
may change: `runner/run-card.mjs`, `runner/test-run-card.mjs`, `ledger.mjs`
read-only: `runner/review.mjs`, `runner/executor.mjs`, `runner/commit.mjs`, `runner/card.mjs`, `runner/lib.mjs`, `runner/snapshot.mjs`, `runner/acceptance.mjs`, `SKILL.md`, `HANDOFF.md`

## Steps (N = 5)
1. `runner/run-card.mjs`, the quota precheck: extend `needsCodex` to `!args.commit && (["luna", "sol"].includes(executor) || (risk === "high" && !isFix && !recon))`. Check that `risk` is already set at that point for normal runs; if it is only known later, move nothing else — tell me in the reply.
2. `runner/run-card.mjs`: add `"codex-plan"` to the prefixes whose `jsonl/progress/exit` files are cleared at a card's first dispatch (the loop over `["agy", "codex", "codex-review"]`).
3. `runner/run-card.mjs`, new section between `// 3. Snapshot` (including the baseline Check block) and `// 4. Executor`, guarded by `if (!state.outcome && risk === "high" && !isFix && !recon)`: build the codex command from Parameters (or the `ORCH_RUNNER_FAKE_PLAN` snippet, run with `ORCH_PLAN_OUT` set to the reply path — prefix the snippet with `ORCH_PLAN_OUT=<q(path)>` the way the code passes values into shell commands), run it with `runBash`, read the first line of the reply file, set `state.plan` and on REVISE / error the outcome, `save(state)`. The executor block already skips when `state.outcome` is set (added by the baseline card) — confirm it. Reuse `q` and `runBash`; do not copy the review module's loop.
4. `runner/run-card.mjs`, summary: the `plan:` line from Parameters right after the `executor:` line. `ledger.mjs`: accept `codex-plan-<name>.jsonl` in both the file filter and the prefix strip (regex alternatives `agy|codex-review|codex-plan|codex`, longest first), role `"plan"` when the file starts with `codex-plan-`; update the comment on line 3.
5. `runner/test-run-card.mjs`:
   - add `ORCH_RUNNER_FAKE_PLAN: "echo 'PLAN: OK' > \"$ORCH_PLAN_OUT\""` to `baseEnv`, so every existing high-risk case passes the plan step without codex; run the suite once after this alone and confirm all existing cases still pass before adding new ones.
   - Case PR, same style, distinct names: (a) risk high, fake plan OK, fake exec + fake review PASS → `review_pass`, `state.plan.verdict === "OK"`, stdout has `plan: gpt-6.1-sol PLAN: OK`; (b) risk high, fake plan writing `PLAN: REVISE` + a line `- step 2 is wrong`, fake exec creating `exec-ran.txt` → outcome `plan_revise`, `exec-ran.txt` absent, stdout has `- step 2 is wrong`; (c) fake plan writing nothing → `plan_error`, exec not run; (d) risk medium → `state.plan` undefined; (e) a `--fix 1` round on a high-risk card → the fake plan is not run (have it write a marker file and assert it is absent); (f) risk high with the codex-full quota script → exit 2, no state file.

Bypass paths: `--fix` and `--recon` skip by design; `--commit` / `--recheck` exit before section 3; a baseline read-only violation sets the outcome first and the guard skips the plan; the executor block skips on any set outcome.

## Check
`node runner/test-run-card.mjs`

## Don't
- No commits, no other files, no refactors beyond the steps; reuse `runBash`, `q`, `snapshot` instead of copying them.
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.

## Acceptance
- verdict: accepted
- files: ledger.mjs, runner/run-card.mjs, runner/test-run-card.mjs
- check: `node runner/test-run-card.mjs` → passed; after the fix re-run through `--recheck`
- tokens:
  - round 1: exec gemini-3.8-flash-high: fresh 298k, cached 4740k, out 57k (11.5 m) · review gpt-6.1-sol: fresh 48k, cached 192k, out 1k
- review findings: 1 real / 0 false positive / K missed 0 (medium, gpt-6.1-sol); bloat (duplicate quota-full fixture in Case PR) left as is
- claude fix: fix-round ledgers drop `plan` rows as well as `review` rows, so round-1 plan tokens are not counted again
