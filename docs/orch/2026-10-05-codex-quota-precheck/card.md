# codex-quota-precheck — refuse to start a card that needs codex when codex's quota is used up

## Goal
Before anything starts, `run-card.mjs` reads the codex quota (token-weather's `quota.mjs`) when the card needs codex
— a luna/sol executor, or a review (not a fix, not recon, risk ≠ low) — and the codex→wb switch is off. If the 5h or
7d window is at ≥ 100 %, it exits 2 with one line telling Claude to ask the user about the switch. A missing or failing
quota script never blocks. `node runner/test-run-card.mjs` prints `27/27 passed`.

## Risk
medium

## Parameters
- quota script: env `ORCH_QUOTA_SCRIPT` || `D:/2/dev/token-weather-quotas/hooks/quota.mjs`; run with `process.execPath`, `timeout: 45000`
- its stdout JSON: `{"codex":{"five":{"pct":N,"resetMs":ms},"week":{"pct":N,"resetMs":ms}}, ...}` (either window may be null)
- block when `five.pct >= 100` or `week.pct >= 100`; exit code 2 (same as a lint error)
- stderr line, exactly:
  `codex quota used up (5h ${five?.pct ?? "-"}%, 7d ${week?.pct ?? "-"}%, resets ${when}): ask the user whether to switch codex to wb (SKILL.md "Codex → wb switch")`
  with `when` = the full window's `resetMs` (5h if it is the full one, else 7d) as
  `new Date(resetMs).toLocaleString("zh-CN", { hour12: false })`
- needs codex: `!args.commit && !codexFallback() && (["luna", "sol"].includes(executor) || (!isFix && !recon && risk !== "low"))`
- script missing, non-zero exit, timeout, or unparsable JSON → no block, no output
- test count: 26 → 27

## Files
may change: `runner/run-card.mjs`, `runner/test-run-card.mjs` / read-only: everything else, including `SKILL.md`,
`runner/lib.mjs`, `runner/executor.mjs`, `runner/review.mjs`, `ledger.mjs`

## Steps (N = 3)
Edit the existing code in place; keep its structure and style.

1. `runner/run-card.mjs`: import `codexFallback` from `./lib.mjs` (extend the existing import line if there is one).
   Right after the `--reviewer` validation block (`if (args.reviewer !== undefined && !["luna", "sol"].includes(args.reviewer)) { … }`),
   add the check from Parameters: when "needs codex" holds and the script file exists, `spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 45000 })`;
   inside `try { … } catch {}` parse `stdout` and read `codex.five` / `codex.week`; when either `pct >= 100`, print the
   stderr line and `process.exit(2)`. Every failure path falls through silently.
   `executor`, `risk`, `recon` and `isFix` are all set before that block (for `--fix` they come from the state file).
2. `runner/test-run-card.mjs`: in `baseEnv` add `ORCH_QUOTA_SCRIPT: \`${tempLive}/no-quota.mjs\`` (never created), so no
   existing case runs the real quota script.
3. `runner/test-run-card.mjs`: Case Q after the last existing case:
   - write `${tempLive}/quota-full.mjs` containing
     `console.log(JSON.stringify({ codex: { five: { pct: 100, resetMs: Date.now() + 3600000 }, week: { pct: 40, resetMs: Date.now() + 86400000 } } }))`
   - `resetRepo(); writeCard(undefined, "medium");` env `{ ...baseEnv, ORCH_QUOTA_SCRIPT: \`${tempLive}/quota-full.mjs\` }`
     (keep baseEnv's fake exec / review). Run `runCard("case-q", { risk: "medium", env })` → assert exit 2 and
     stderr contains `codex quota used up (5h 100%, 7d 40%` and `switch codex to wb`; assert no state file
     `case-q` was written (use the same state-dir path `readState` uses, checked with `fs.existsSync`).
   - same env plus `ORCH_CODEX_FALLBACK_FILE` pointing at a temp file containing `on`: run `runCard("case-q2", { risk: "medium", env: env2 })`
     → assert exit 0 (the precheck is skipped; outcome comes from the fake review as in the other medium cases).
     Remove that temp file afterwards.
   - `passedCount++`; change the final summary from 26 to 27 (the `if`, the error message and `"26/26 passed"`).

## Check
`node runner/test-run-card.mjs`

## Don't
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.
- No commits, no other files, no refactors beyond the steps. Never run the real `D:/2/dev/token-weather-quotas/hooks/quota.mjs`
  and never touch `~/.claude/skills/orchestrate/codex-fallback`.

## Acceptance
- verdict: accepted (review on wb: codex out of quota; real-script trial with the switch off → exit 2, `codex quota used up (5h 100%, 7d 61%, resets 2026/10/5 22:29:51)`)
- files: runner/run-card.mjs, runner/test-run-card.mjs
- check: `node runner/test-run-card.mjs` → exit 0 (run by run-card)
- tokens:
  - round 1: exec deepseek-v4.1-flash: fresh 0k, cached 0k, out 0k  (codex-codex-quota-precheck.jsonl) · review deepseek-v4.1-flash: fresh 0k, cached 0k, out 0k  (codex-review-codex-quota-precheck.jsonl)
- review findings: 0 real / 0 false positive / 0 missed (medium, deepseek-v4.1-flash)
