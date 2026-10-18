VERDICT: FAIL

- [runner/run-long.mjs:75] `--resume` accepts any existing path, including a regular file, although the card requires an existing output directory. Check that the path exists and is a directory; otherwise exit 2.

Pre-existing problems: I can’t distinguish any earlier `card.md` changes from changes made during this task because the task directory is untracked.