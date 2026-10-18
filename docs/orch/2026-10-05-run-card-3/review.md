VERDICT: FAIL

- [runner/run-card.mjs:142] `--commit` uses `--name` to build a state-file path without validating it, so path components such as `../` can select a state file outside the state directory. Apply the same name validation used for normal and fix runs before constructing the path.

Pre-existing: `docs/orch/2026-10-05-run-card-3/card.md` was already untracked before this task.