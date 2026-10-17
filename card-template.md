# <name> — <one-line goal>

<!-- Copy to docs/orch/<yyyy-mm-dd>-<name>/card.md and fill every <placeholder>. At most 2 rounds of `--fix` per card; the 3rd round needs a fresh `<task>-vN/` card. -->

## Goal
<what is true when done, in observable terms>

## Risk
low <!-- first word must equal --risk: low / medium / high; for high add the key number Claude will recompute -->

## Parameters
<every value the result depends on, with its expected value; omit the section only if nothing has a value. A fact about a data format or a file's contents: read one real file first and write where it came from (`source: <path>`). Mark a value taken from a mockup or plan that nobody measured on the real thing `(unverified)`; acceptance needs someone to look at the real result before it is called done>

## Files
may change: `<path/a.py>`, `<dir/>` / read-only: `<data/>` <!-- read-only: only this project's own data the task must not touch; never a directory a daemon or the host program writes (`.claude-plugin/types/`): its changes trip the guard and end the run `readonly_violated` -->

## Steps (N = 1)
1. <file → function → the exact behaviour change>

## Setup
<!-- Optional; delete the section if unused. Shell commands run before the baseline Check, only with `--isolation worktree` (the worktree has no ignored or untracked files). Data paths are absolute paths in the main tree, read-only. -->

## Check
`<one command, the fastest existing test that proves the goal>`

## Expect
<!-- Optional; delete the section if unused. Write `green` only for a refactor: the Check is meant to pass before the change too. Otherwise the runner warns when the Check already passes before the change, and a new test must fail on the old code. -->

## Don't
- No commits, no other files, no refactors beyond the steps.
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.
