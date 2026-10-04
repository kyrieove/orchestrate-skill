VERDICT: FAIL

- [runner/run-card.mjs:653](/D:/2/dev/orch-runner/orchestrate/runner/run-card.mjs:653) The read-only comparison is skipped whenever the Check sets an outcome, including `check_failed` or `interrupted`. The card requires a comparison right after Check; only executor timeout, failure, or blocked outcomes are exempt. Run the comparison after Check regardless of its outcome, and set `readonly_violated` if paths changed.

Pre-existing problems: none found.