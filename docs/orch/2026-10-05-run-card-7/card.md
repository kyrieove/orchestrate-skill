# run-card-7 — fix 3 audit bugs (fix-round scope not saved, stats last-round only, run-long argv quoting) + 6 simplifications

## Goal
After a `--fix` round the state file holds the card's current `## Files` and `## Check`, so `--commit` stages files added for the fix;
`stats.mjs` sums executor tokens and time over all rounds of a card; `run-long.mjs -- cmd "a b"` passes `a b` as one argument.
Six simplifications from the audit land with no behaviour change. `node runner/test-run-card.mjs` passes, with three new assertions.

## Risk
medium (shared tooling; reviewed by sol via --reviewer sol)

## Parameters
- fix state keys: `state.mayChange`, `state.check` (same names as round 1)
- round record new key: `seconds` (= `state.exec.seconds` of that round, or null)
- run-long: exactly one arg after `--` → used as a raw shell command string; two or more → each passed through `q()` and joined with spaces

## Files
may change: `runner/run-card.mjs`, `runner/executor.mjs`, `runner/stats.mjs`, `runner/run-long.mjs`, `runner/test-run-card.mjs`
read-only: `ledger.mjs`, `runner/lib.mjs`

## Steps (N = 9)
1. `runner/run-card.mjs`, fix branch (`if (isFix) {`, ~line 256): in the round-1 record pushed when `state.rounds.length === 0`, add
   `seconds: state.exec?.seconds ?? null` (state.exec still holds round 1 here; it is reset a few lines below). Right after
   `if (!state.fixes) state.fixes = [];` add `state.mayChange = mayChange;` and `state.check = check;` (both variables are parsed from
   the card earlier in the file).
2. `runner/run-card.mjs`, the `state.rounds.push({ round: \`Fix ${fixRoundN}\`, ...})` (~line 570): add `seconds: state.exec?.seconds ?? null`.
3. `runner/stats.mjs` (~lines 34–50): when `Array.isArray(state.rounds) && state.rounds.length > 0`, take the ledger rows from
   `state.rounds.flatMap((r) => Array.isArray(r.ledger) ? r.ledger : [])` and `execSec` = sum of the rounds' numeric `seconds`;
   otherwise keep today's source (`state.ledger`, `state.exec.seconds`). Keep the existing exec-row filter for both sources.
   (Fix rounds already drop review rows and each round's exec stream is overwritten, so summing rounds does not double-count.)
4. `runner/run-long.mjs` line 19: `const command = cmdParts.length === 1 ? cmdParts[0] : cmdParts.map(q).join(" ");` (`q` is already imported).
5. `runner/run-long.mjs` option loop: before the `if (arg === "--resume")` chain add one check —
   if `["--name", "--out", "--timeout-min"].includes(arg)` and (`i + 1 >= optArgs.length || optArgs[i + 1].startsWith("--")`) →
   `console.error(\`Missing value for ${arg}\`); process.exit(2);` — and delete the three per-flag copies of that check.
6. `runner/run-card.mjs` (~lines 74–90): replace the two executor/risk match blocks with
   ```js
   for (const [key, val] of [["executor", executor], ["risk", risk]]) {
     if (val !== undefined && val !== existingState[key]) {
       console.error(`--${key} '${val}' does not match state '${existingState[key]}'`);
       process.exit(2);
     }
   }
   executor = existingState.executor;
   risk = existingState.risk;
   ```
7. `runner/run-card.mjs` (~lines 418–424): delete `outOfScope.sort();` and `junk.sort();` (both are filtered from the already sorted `touched`).
8. `runner/executor.mjs`: replace the `let S; if (...) {...} else {...}` block (~lines 38–43) with
   `const S = path.posix.join(liveDir, \`${progressPrefix}-${name}.jsonl\`);` (`progressPrefix` uses the same condition, line 25).
   Replace the failed/blocked branches (~lines 107–113) with one computed outcome:
   `const failOutcome = execResult.exit !== 0 || status === "failed" ? "failed" : status === "blocked" ? "blocked" : null;`
   then `if (failOutcome) { state.outcome = failOutcome; save(state); }`. Delete the final `return { S, E, progressPrefix };`, and in
   `runner/run-card.mjs` (~line 375) change `const { S, E, progressPrefix } = await runExecutor({` to `await runExecutor({`
   (none of the three is used later in run-card.mjs; check with grep before deleting).
9. `runner/test-run-card.mjs`, three assertions:
   - Case M: before `runCard("case-m", { args: ["--fix", "1"] ...})`, rewrite the card so `## Files` may change also lists `c.txt`
     (replace ``"`b.txt` /"`` with ``"`b.txt`, `c.txt` /"`` in the card text); fake exec becomes
     `echo y > b.txt; echo z > c.txt; echo 'STATUS: done'`; after the fix assert `stateM2.outcome === "fix_passed"` (already there) and
     `stateM2.mayChange.includes("c.txt")`.
   - Case S: add a fourth state `stats-4` (executor `agy`, risk `low`, outcome `fix_passed`, `exec: { seconds: 30 }`,
     `ledger: [{ role: "exec", fresh: 20000, cached: 0, out: 0 }]`, `fixes: [{ n: 1 }]`, `rounds: [{ round: "1", ledger: [{ role: "exec", fresh: 100000, cached: 0, out: 0 }], seconds: 60 }, { round: "Fix 1", ledger: [{ role: "exec", fresh: 20000, cached: 0, out: 0 }], seconds: 30 }]`);
     assert the `agy/low` line contains `fresh 120k` and `exec 1.5m`; change `total cards 3` to `total cards 4`.
   - Case Q: one more run-long call (fresh out dir, like Q2) with `"--", "printf", "%s\n", "a b"`; assert exit 0 and the stream file
     contains the line `a b` (unquoted join would print `a` and `b` on separate lines).

## Check
`node runner/test-run-card.mjs`

## Don't
No commits, no other files, no refactors beyond the steps; reuse `q` from `runner/lib.mjs`.
"Run scripts in the foreground and wait; before replying, stop any background task still running."
"Reuse existing functions; don't copy existing logic." "No rm, no git push, no git checkout . / restore . / reset --hard."

## Fix 1
1. `runner/stats.mjs`, the `execSec` computation (~line 35): when `hasRounds` is true but no round has a numeric `seconds`
   (state files written before this card), fall back to `state.exec.seconds` as the non-rounds branch does:
   ```js
   const roundSecs = hasRounds ? state.rounds.filter((r) => typeof r.seconds === "number") : [];
   const execSec = roundSecs.length > 0
     ? roundSecs.reduce((sum, r) => sum + r.seconds, 0)
     : (state.exec && typeof state.exec.seconds === "number" ? state.exec.seconds : 0);
   ```
2. `runner/test-run-card.mjs`, Case S: add a fifth state `stats-5` (executor `luna`, risk `low`, outcome `fix_passed`,
   `exec: { seconds: 120 }`, `fixes: [{ n: 1 }]`, `rounds: [{ round: "1", ledger: [] }, { round: "Fix 1", ledger: [] }]` — no `seconds`);
   assert the `luna/low` line contains `exec 2.0m`; change `total cards 4` to `total cards 5`.

## Acceptance
- verdict: accepted (Fix 1 diff read by Claude; stats.mjs run on the real state files: 6 cards, exec 5.9m avg)
- files: runner/executor.mjs, runner/run-card.mjs, runner/run-long.mjs, runner/stats.mjs, runner/test-run-card.mjs
- check: `node runner/test-run-card.mjs` → exit 0 (run by run-card)
- tokens:
  - round 1: exec gemini-3.8-flash-high: fresh 696k, cached 3817k, out 57k  (agy-run-card-7.jsonl) · review gpt-6.1-sol: fresh 45k, cached 112k, out 1k  (codex-review-run-card-7.jsonl)
  - Fix 1: exec gemini-3.8-flash-high: fresh 103k, cached 428k, out 13k  (agy-run-card-7.jsonl)
- review findings: 1 real / 0 false positive / 0 missed (medium, gpt-6.1-sol via --reviewer sol); pre-existing, out of scope: executor accepts a reply without a STATUS line as success
- fix-round tokens: --fresh Fix 1 cost fresh 103k vs card 6's continued-conversation Fix 1 at 799k → SKILL.md now makes --fresh the default
