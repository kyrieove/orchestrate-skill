# run-card-2 — card lint, review retry, junk list, read-only guard, --recon mode

## Goal
`runner/run-card.mjs` (1) refuses a malformed card before starting anything, (2) re-runs a review once when its
`review.md` has no VERDICT first line, (3) lists junk files separately among out-of-scope files, (4) fails when a
read-only path listed in the card changed, (5) supports `--recon` read-only cards. `node runner/test-run-card.mjs`
prints `12/12 passed`.

## Risk
medium

## Parameters
- new outcomes (exact strings): `readonly_violated`, `recon_done`; all existing outcomes unchanged
- lint exit code: 2 (same as bad arguments), all problems printed to stderr, one per line, prefixed `lint: `
- the three required Don't phrases (substring match): `Run scripts in the foreground and wait`,
  `Reuse existing functions`, `No rm, no git push`
- junk patterns (on the repo-relative path): a path segment `__pycache__`; basename ending `.log`; basename starting `tmp`
- review retry: at most 1 retry, only when the reviewer exited 0 and `review.md`'s first line is neither VERDICT line
- recon reply in the summary: last 40 lines (normal cards keep 15)

## Files
may change: `runner/run-card.mjs`, `runner/test-run-card.mjs` / read-only: everything else, including `SKILL.md`,
`ledger.mjs`, `cost.mjs`, `HANDOFF.md`

## Steps (N = 6)
Edit the existing code in place; keep its structure, helpers (`getSection`, `snapshot`, `runBash`, `save`, `q`) and style.

1. **`--recon` flag** (`parseArgs` / section 1): `--recon` takes no value; `const recon = args.recon === true`. Store
   `recon` in `state`. Section 4: when `recon`, the executor prompt is exactly
   `Read <abs card> and answer what it asks. This is read-only: do not create, modify or delete any file; do not commit. Reply: first line exactly STATUS: done, STATUS: blocked or STATUS: failed; then the answer. <progress line>`
   Section 5: when `recon`, every touched path (after the existing exemptions) is out of scope, ignoring `mayChange`.
   After section 5, when `recon` and no outcome yet → outcome `recon_done`; skip Check (6) and review (7).
   Summary: the reply shows its last 40 lines when `recon`, else 15.
2. **Lint** — new function `lintCard(cardText)` returning an array of problem strings, called in section 1 right after
   reading the card and BEFORE the Check/Files parsing, state file, snapshot or stream clearing. Rules:
   - sections `Goal`, `Risk`, `Files`, `Steps`, `Don't` must exist (`getSection` ≠ null); `Check` too unless `recon`;
   - first word of the `Risk` section (lowercased) must equal `--risk`;
   - the `Steps` heading line or its body must match `/N\s*=\s*\d+/`;
   - `Don't` must contain each of the three phrases (Parameters);
   - unless `recon`: the Files text before `read-only` has at least one backticked path, and the Check section has a
     fenced block or a backticked span.
   Problems → print each as `lint: <problem>` to stderr, exit 2. Then the existing Check/Files parsing runs as now.
   Note: `getSection` matches the first word of the heading, so `## Steps (N = 6)` is found by `"Steps"`, and
   `## Don't` by `"Don't"`. To test the Steps heading line, find the line starting `## Steps` in `cardText`.
3. **Read-only guard.** In section 1, `readOnly` = backticked spans in the Files section AFTER the first `read-only`.
   Expand a leading `~/` to the home directory; resolve relative ones against the repo. Keep only paths that exist;
   drop any path equal to or inside `liveDir` (the runner and executor write there) and any path inside the task dir.
   New function `statTree(paths)` → `{ [absPath]: [size, mtimeMs] }` for every file (recursive for directories;
   `fs.readdirSync(dir, { withFileTypes: true })`; skip `.git` directories). Take `state.readOnlyBefore` right after
   the git `before` snapshot. Compare (same keys, same values) right after the executor finishes (before section 5) and
   again right after the Check: any difference → outcome `readonly_violated`, `state.readOnlyChanged` = the changed /
   added / removed paths (repo-relative when inside the repo), and skip the remaining stages. Summary line:
   `read-only changed: <paths>` when set.
   Bypass paths covered: executor timeout / failed / blocked go to the summary without the comparison — that is
   acceptable because those outcomes already stop the card; recon cards run the comparison too.
4. **Junk list** (section 5): `state.junk` = the out-of-scope paths matching the junk patterns (Parameters). Outcome is
   still `out_of_scope` (junk is deleted only after the user says so). Summary: `out of scope:` lists the non-junk ones,
   followed by `junk: <paths>` when any.
5. **Review retry** (section 7): after the review, if `reviewRes.exit === 0` and the first line of `review.md` is
   neither `VERDICT: PASS` nor `VERDICT: FAIL`, run the same review command once more with the stream redirect `>>`
   instead of `>` (so `ledger.mjs` sums both runs) after deleting `review.md`; then classify as now. Set
   `state.review.retried = true`. Summary review line ends with ` (retried)` when set.
6. **Tests** (`runner/test-run-card.mjs`): the shared test card now must pass lint: add `## Goal`, `## Risk` with the
   case's risk, `## Steps (N = 1)` and a `## Don't` containing the three phrases; its Files section becomes
   ``may change: `a.txt`, `b.txt` / read-only: `data/` `` and the repo commits `data/f.txt` = "d". Keep cases A–F passing.
   Add cases (the final line becomes `12/12 passed`):
   - G: card without `## Don't` → exit status 2, stderr contains `lint:`, no state file for that name.
   - H: card whose `## Risk` says `high` run with `--risk low` → exit 2, stderr contains `lint:`.
   - I: fake exec `echo x > x.log; echo 'STATUS: done'` → `out_of_scope`, `state.junk` = `["x.log"]`.
   - J: fake exec `echo changed > data/f.txt; echo 'STATUS: done'` → `readonly_violated`, `readOnlyChanged` contains `data/f.txt`.
   - K: `--recon`, fake exec `echo 'STATUS: done'; echo 'answer: 42'` → `recon_done`, Check not run (`checkResult` unset).
   - L: risk medium, fake review that writes `no verdict here` on its first call and `VERDICT: PASS` on its second
     (use a counter file outside the repo, e.g. in the temp live dir) → `review_pass`, `state.review.retried === true`.
   The recon card in K may omit `## Check`. Cases G and H must not clear or create any stream file.

## Check
`node runner/test-run-card.mjs`

## Don't
No commits, no other files, no refactors beyond the steps; don't edit SKILL.md, ledger.mjs, cost.mjs or HANDOFF.md.
Don't install packages. Don't run real agy/codex executors from the test.
"Run scripts in the foreground and wait; before replying, stop any background task still running."
"Reuse existing functions; don't copy existing logic." "No rm, no git push, no git checkout . / restore . / reset --hard."
(The test's `git reset --hard` / `git clean` inside its own temp repo is the only exception.)

## Acceptance
- verdict: accepted (review FAIL, 1 finding; Claude fixed it directly — one condition removed so the read-only comparison runs after any Check outcome — instead of an agy fix round for a one-line change)
- dispatched through `runner/run-card.mjs` itself: executor → Check → files → ledger → review ran unattended, Claude woke once
- files: `runner/run-card.mjs`, `runner/test-run-card.mjs`
- check: `node runner/test-run-card.mjs` → 12/12 passed (runner's run, and Claude's re-run after the fix); no temp dirs left
- tokens: exec gemini-3.8-flash-high: fresh 815k, cached 7099k, out 78k · review gpt-6-luna: fresh 31k, cached 64k, out 1k
- review findings: 1 real / 0 false positive / 0 missed (medium, gpt-6-luna)
- K missed backfill (retro 2026-10-05): 2 (found after acceptance): read-only walk of an ancestor included the live dir / task dir — /rv sol, fixed 834eeee; read-only walk skipped symlinks/junctions — audit sol, fixed 2177aee
- K missed backfill (audit sol 2026-10-05 #2): 1 — read-only paths that don't exist yet are dropped, so files created there go unguarded (run-card.mjs)
