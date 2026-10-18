VERDICT: FAIL

- runner/stats.mjs:35 — Existing saved fix states have rounds without `seconds`. Their executor time now reports zero, discarding the previously reported `state.exec.seconds`. Fix: fall back to `state.exec.seconds` when no round has numeric timing.

Bloat added: none found.

Pre-existing problems: runner/executor.mjs accepts a missing `STATUS` as success.