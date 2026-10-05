VERDICT: PASS

No problems this diff introduces.

- run-card.mjs:310-330 — check-ignore over all basePaths, the ignored/large stat-only rule, and `state.fixBaseStats = stats; save(state)` match Steps 1 and the Parameters; `MAX_BASE_BYTES = 1024 * 1024` is declared once near the top (line 25), and touched paths are added to basePaths before the copy loop so they get the same rule.
- run-card.mjs:557-586 — stat-keyed paths are skipped in the `git diff --no-index` loop, and the stat loop appends the exact Parameters line after the diff pieces (missing => `-`). Matches Step 2.
- test-run-card.mjs:909-979 — Case X follows Case W's shape (commits `src/old.txt="a\n"` + `.gitignore`, writes 2 MiB `src/big.bin` uncommitted/ignored, fix exec appends to it) and asserts fix_passed, no base copy, `-a`/`+b`, and the stat line; the 23→24 summary literals are all updated. Matches Step 3.

Bloat:
- run-card.mjs:319-320 — `fs.statSync(src)` is called twice per file; the first stat (in the `existsSync && isFile` test) is discarded. Reuse one stat.
- run-card.mjs:582 — `rec.size ?? "-"` is dead: a fixBaseStats key is only ever written with a numeric size, so the `-` before-branch is unreachable.

Pre-existing (outside this card, not introduced here): the run-long.mjs stale-exit-file change and the Case Q4 test additions were already uncommitted before this task; no problems with them.
 task; no problems with them.
