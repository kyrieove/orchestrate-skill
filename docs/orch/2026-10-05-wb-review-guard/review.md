VERDICT: PASS

No diff-introduced problems found — all four steps match the card:
- `runner/review.mjs:36,126-137` — `preReview` gated on `wb` exactly as specified; `snapshot` imported from `./snapshot.mjs`; exempt `own` is repo-relative (`taskDir` is repo-relative at `run-card.mjs:224`, so the `path.posix.relative` fallback is correctly not needed); `wrote` is sorted, sets `review_error`/`verdict="error"`/`review.wrote`.
- `runner/run-card.mjs:342-343,605` — stat-once rewrite is behaviour-equivalent; `rec.size` is always a numeric field (only ever set with `size` at line 345), so dropping `?? "-"` is safe.
- `runner/test-run-card.mjs:1063-1086` — Case R creates its own `mkdtemp` bin in a `finally`-cleaned scope, switch file written/removed, asserts exit 0 + `review_error` + `wrote === ["wrote.txt"]`; `passedCount++` and 28/28 summary (lines 1088-1092) are correct; the 28 increment sites line up.
- No files outside the card touched; no junk files; `docs/orch/2026-10-05-wb-review-guard/` contains only `card.md`, which is allowed.

Bloat (card-instructed, does not fail): `test-run-card.mjs:1071-1072` duplicates the existing `codebuddy` fake shell script verbatim apart from the added `echo x > wrote.txt`; step 4 explicitly required building it "the same way as the existing fake", so this is acceptable but could have been a tiny shared helper.

Pre-existing problems: none observed in the touched code.