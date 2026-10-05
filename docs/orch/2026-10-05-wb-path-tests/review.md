VERDICT: PASS

Findings (all non-blocking; the diff is functionally correct per the 26/26 Check):

1. `runner/test-run-card.mjs:1011-1012` — The `codex-case-y.jsonl` assertion reads the first line of the exec stream, but that line is the literal `echo '{"model":"deepseek-v4.1-flash"}'` that `executor.mjs:48` writes itself. The fake `codebuddy` ignores all its argv, so nothing verifies the `--model` the real wb command string passes; a wrong `WB_MODEL` in `wbCmd` (`runner/lib.mjs:8`) would still pass. Fix: have the fake script persist its argv (e.g. `printf '%s' "$*" > "$fakeBin/argv"`) and assert `--model deepseek-v4.1-flash` on that instead of the echoed JSON line.

2. `runner/test-run-card.mjs:92` — Reply routing keys on the substring `"Review the"` in `$*`. That string is an arbitrary phrase in the review prompt built by `runner/review.mjs:42`; the exec prompt (`runner/executor.mjs:35`) is a sibling that must never contain it. If either prompt is reworded, both cases silently misroute (exec gets `VERDICT: PASS`, review gets `STATUS: done`) and fail with an opaque message. Fix: match an unambiguous, command-shape marker already distinguishing the two lanes, e.g. `*disallowedTools*` (only the review command passes `--disallowedTools`), or anchor on the prompt opening.

3. `runner/test-run-card.mjs:1013` — Deleting `codex-fallback` only matters because the file would otherwise linger in `tempLive`; but Case Z (Case Z at `:1021`) is `--executor wb`, which takes the wb branch regardless of the switch, and risk `low` skips review anyway. So the delete does not affect Case Z, and if any assertion above it throws the delete is skipped (only `tempLive` removal in `finally` saves you). Not a bug, just a misleading coupling.

Bloat the diff adds:
- `runner/test-run-card.mjs:86-90` — a `stream(reply)` helper used twice for building the two fake replies; inlining the two JSON strings would be simpler.
- `runner/test-run-card.mjs:95-96` — `delete wbEnv.ORCH_RUNNER_FAKE_EXEC` / `..._FAKE_REVIEW` are dead in practice: `baseEnv` is `{...process.env, ...}` and this test never puts those keys into `process.env`, so the code path they guard can't occur (the card itself calls them harmless).
- `runner/test-run-card.mjs:1013` — the manual switch-file `fs.rmSync` duplicates the temp-dir cleanup already done in `finally` (`:1039`).
