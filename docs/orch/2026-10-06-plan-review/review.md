VERDICT: FAIL

- ledger.mjs:61 — Plan tokens are counted again on every `--fix` round: the original plan stream remains, while runner/run-card.mjs:648 filters only `review` rows before saving each round’s ledger. Fix: exclude both `review` and `plan` rows from fix-round ledgers; retain plan usage in round 1.
- Bloat — runner/test-run-card.mjs:1624 duplicates the existing codex-full quota fixture. Fix: reuse `${tempLive}/quota-full.mjs`. This alone does not cause FAIL.

Pre-existing problems: none identified within the permitted scope.