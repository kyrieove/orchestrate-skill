# run-card-6 — split runner/run-card.mjs into stage modules, same behaviour

## Goal
`runner/run-card.mjs` keeps only argument handling, state setup and the top-level stage sequence; the code of each
stage lives in its own module under `runner/`. Behaviour is byte-for-byte the same: `node runner/test-run-card.mjs`
prints `23/23 passed` without any change to the test file. Why: later cards should touch one small file
(agy's cached input grew from 1.8 M to 9.3 M per card as run-card.mjs grew to ~1280 lines).

## Risk
medium (shared tooling: reviewed by sol via `--reviewer sol`)

## Parameters
- new modules (exact names): `runner/card.mjs`, `runner/snapshot.mjs`, `runner/executor.mjs`, `runner/review.mjs`,
  `runner/acceptance.mjs`, `runner/commit.mjs`
- size targets: `run-card.mjs` ≤ 600 lines; every new module ≤ 350 lines
- test result: `23/23 passed`; `runner/test-run-card.mjs` unchanged
- summary output, state file fields, exit codes, outcome names, command strings: unchanged

## Files
may change: `runner/run-card.mjs`, `runner/card.mjs`, `runner/snapshot.mjs`, `runner/executor.mjs`,
`runner/review.mjs`, `runner/acceptance.mjs`, `runner/commit.mjs` / read-only: `runner/test-run-card.mjs`,
`runner/lib.mjs`, `runner/run-long.mjs`, `runner/stats.mjs`, `ledger.mjs`, `cost.mjs`, `SKILL.md`, `HANDOFF.md`

## Steps (N = 8)
Rules for every step: **move** code, don't rewrite it — same statements, same order, same messages. A moved function
gets every outer variable it reads as a parameter; for the stage blocks (steps 3–6) pass one context object `ctx`
holding exactly the outer variables the block reads, and keep mutations the block did (`state.x = …`, `save(state)`)
working through `ctx.state` / `ctx.save`. If a block assigns an outer `let` that later code in run-card.mjs reads,
return that value and assign it at the call site. New modules hold no module-level mutable state and import only
node builtins, `./lib.mjs` and each other. To find a block's outer variables: list every identifier it uses that is
not declared inside it, and look each up in run-card.mjs.

1. **`runner/card.mjs`**: move `parseArgs`, `getSection`, `lintCard`, `isJunkPath` (run-card.mjs lines ~9–120) and
   `export` them. run-card.mjs imports them.
2. **`runner/snapshot.mjs`**: move `snapshot`, `statTree`, `getReadOnlyDiff` (section "3. Snapshot", ~574–760).
   Outer variables they read (e.g. `isGit`, `repoAbs`, `normLiveDir`, `cardDirNorm`) become parameters. Update every
   call site in run-card.mjs (including the ones in `scopeCheck`, the fix-base code and section 6).
3. **`runner/commit.mjs`**: move the whole `if (args.commit) { … }` body (~130–235) into
   `export function runCommit(args, ctx)`; run-card.mjs keeps `if (args.commit) runCommit(args, { … });` at the
   same place. It still ends with `process.exit`.
4. **`runner/executor.mjs`**: move section "4. Executor" (progress line, prompt, stream paths, command build, run,
   reply extraction, status parse; ~760–860) into `export function runExecutor(ctx)`. Return whatever later code
   reads (e.g. `S`, `E`, `progressPrefix`) as an object and destructure it at the call site.
5. **`runner/review.mjs`**: move the review part of section "7. Review" (reviewer choice including `args.reviewer`,
   prompt, the 2-attempt loop, verdict read; the `else` branch that starts `state.stage = "reviewing"`) into
   `export function runReview(ctx)`. The `if/else if` that decides whether a review runs stays in run-card.mjs.
6. **`runner/acceptance.mjs`**: move `formatLedgerLines` and section "5. Acceptance draft" (~1140–1190, the
   `draftOutcomes` set and the code that appends `## Acceptance`) into exported functions
   `formatLedgerLines(ledger, sep)` and `appendAcceptanceDraft(ctx)`. The `k` helper moves with them if only they use
   it; otherwise export it from acceptance.mjs and import it.
7. **Leave in run-card.mjs**: args validation, state file + `save`, card/Check/Files parsing, fix setup, `scopeCheck`,
   section 5 "Touched files", section 6 "Check", ledger call, fix diff, summary printing. Delete imports run-card.mjs
   no longer uses.
8. **Self-check**: `node --check` on each of the 7 files; `wc -l runner/*.mjs` and confirm the Parameters size targets.
   If run-card.mjs is still > 600 lines, report the line count; do not move more code than the steps name.

## Check
`node runner/test-run-card.mjs`

## Don't
No commits, no other files, no edits to `runner/test-run-card.mjs`, no behaviour changes, no renaming of state fields or
outcomes, no refactors beyond the steps. Run scripts in the foreground and wait; before replying, stop any background
task still running. Reuse existing functions; don't copy existing logic. No rm, no git push, no git checkout . /
restore . / reset --hard.

## Fix 1
Review finding (sol): dual positional/object signatures were added. Keep exactly one signature per function — the one
the call sites already use — and delete the branches that detect the other form:
1. `runner/card.mjs` `lintCard`: signature `lintCard(cardText, { recon, risk })`; delete `reconOrOpts` / `maybeRisk`
   and the `typeof … === "object"` branch; keep the defaults only as destructuring defaults if needed:
   `export function lintCard(cardText, { recon = false, risk = "" } = {})`.
2. `runner/snapshot.mjs` `snapshot`: `export function snapshot(repoAbs, isGit)`; delete the object branch.
3. `runner/snapshot.mjs` `statTree`: `export function statTree(paths, { normLiveDir, cardDirNorm })`; delete the
   positional branch.
4. `runner/snapshot.mjs` `getReadOnlyDiff`: `export function getReadOnlyDiff(beforeStats, paths, { repoAbs, normLiveDir, cardDirNorm })`;
   delete the positional branch. Call sites in `run-card.mjs` / `executor.mjs` / `snapshot.mjs` stay as they are.
5. Scan the other new modules (`executor.mjs`, `review.mjs`, `acceptance.mjs`, `commit.mjs`) for the same pattern
   (an argument that may be either of two shapes, or `typeof` checks / coercion not present in the original code) and
   remove it the same way. `node --check` each changed file.

## Acceptance
- verdict: accepted (Fix 1 diff read by Claude: only the dual-signature branches removed; run-card.mjs is 677 lines, above the 600 target — agy reported it as Step 8 asked; the remaining bulk is arg/state setup and the summary, next split candidate)
- files: runner/acceptance.mjs, runner/card.mjs, runner/commit.mjs, runner/executor.mjs, runner/review.mjs, runner/run-card.mjs, runner/snapshot.mjs
- check: `node runner/test-run-card.mjs` → exit 0 (run by run-card)
- tokens:
  - round 1: exec gemini-3.8-flash-high: fresh 335k, cached 2535k, out 63k  (agy-run-card-6.jsonl) · review gpt-6.1-sol: fresh 34k, cached 128k, out 1k  (codex-review-run-card-6.jsonl)
  - Fix 1: exec gemini-3.8-flash-high: fresh 799k, cached 2986k, out 8k  (agy-run-card-6.jsonl)
- review findings: 1 real / 0 false positive / 0 missed (medium, gpt-6.1-sol via --reviewer sol)
- fix-round tokens: continued agy conversation cost fresh 799k vs round 1 fresh 335k for a ~40-line deletion — continuing did not save fresh tokens here; `--fresh` not yet measured (next fix round: run it with `--fresh` and compare)
