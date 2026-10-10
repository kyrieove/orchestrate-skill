# <name> — <one-line goal>

<!-- Copy to docs/orch/<yyyy-mm-dd>-<name>/card.md and fill every <placeholder>. At most 2 rounds of `--fix` per card; the 3rd round needs a fresh `<task>-vN/` card. -->

## Goal
<what is true when done, in observable terms>

## Risk
low <!-- first word must equal --risk: low / medium / high; for high add the key number Claude will recompute -->

## Parameters
<every value the result depends on, with its expected value; omit the section only if nothing has a value>

## Files
may change: `<path/a.py>`, `<dir/>` / read-only: `<data/>`

## Steps (N = 1)
1. <file → function → the exact behaviour change>

## Check
`<one command, the fastest existing test that proves the goal>`

## Don't
- No commits, no other files, no refactors beyond the steps.
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.
