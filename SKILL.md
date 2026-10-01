---
name: orchestrate
description: Claude plans and accepts; agy executes a detailed task card; codex reviews once. Use whenever the user says Claude should plan/review but not implement, says 分工, 派活, 编排, orchestrate, /orch, 让 agy 干, 交给 agy/codex, or starts a feature, fix, refactor, analysis or batch job in a project whose HANDOFF.md says "Claude plans and reviews".
---

# orchestrate — Claude plans, agy executes, codex reviews once

**Why this shape.** agy following explicit steps is fast and cheap. agy *figuring things out* — reading
large files, designing, re-running whole test suites, reworking after strict reviews — costs tens of
times more (measured 2026-10-01: a goal-only card burned 2.2 M fresh + 18 M cached input tokens).
So the design work stays with Claude: the card says exactly what to do, agy does it, codex checks it
once, Claude accepts. Claude never writes the implementation itself.

## Flow

1. **Read just enough.** `grep -n` / `sed -n 'a,bp'` on the code the change touches. For a large
   unfamiliar area, first send agy a read-only recon card ("summarise X: functions, call sites, data
   flow, ≤ 40 lines") and plan from its summary.
2. **Write the card** — `docs/orch/<yyyy-mm-dd>-<name>/card.md` in the project (sections below).
   One task per card. Before dispatching, show the user the card when it writes to data folders or
   does anything irreversible; otherwise dispatch.
3. **agy executes** (background + heartbeat, commands below). Tracked files must be clean first.
4. **codex reviews once** — ask the user which model first (default `gpt-6.1-sol`). Skip the review
   for docs, typos or changes ≤ 10 lines; Claude reads the diff instead.
5. **Fix if needed.** Claude reads `review.md`, appends `## Fix 1` to the card (exact steps), agy runs
   it again; Claude checks only that fix's diff — no second codex review. Max 2 fixes, then rewrite
   the card.
6. **Accept.** Run the check, `git diff --stat`, look at the product (open the figure, run the CLI).
   Append `## Acceptance` to the card, commit (code + card + review), **don't push**. If the project
   keeps a log (e.g. `docs/review-log.md`), add one line pointing at the card.

## Card sections (`card.md`)

```markdown
# <name> — <one-line goal>
## Goal        what is true when done, in observable terms
## Files       may change: … / read-only: … (data folders always read-only)
## Steps       numbered; per step: file → function → the exact behaviour change; code snippets
               for anything fiddly (index math, time axes, regexes, API calls agy may get wrong)
## Check       one command, the fastest existing test that proves the goal; add ONE small new test
               only for a bug with a crisp repro, and spell it out here
## Don't       no commits, no other files, no refactors beyond the steps, reuse helper X instead of copying
```

Later sections appended in the same file: `## Fix 1`, `## Fix 2`, `## Acceptance` (verdict, files,
check result, commit hash). Each task folder holds only `card.md` and `review.md`.

## Commands

agy (model fixed; `-p` ignores stdin, so it reads the card from disk):

```bash
T=$(mktemp -d); C:/Users/ASUS/AppData/Local/agy/bin/agy.exe -p "Read <abs card.md> and carry out every step exactly; run only the Check command; do not commit. Reply with: files changed, check result, anything you could not do." --model gemini-3.8-flash-high --dangerously-skip-permissions --output-format json > $T/agy.json 2>&1; echo done > $T/done; echo $T
```

Run it with `run_in_background`, cwd = repo. In the same message arm a Monitor heartbeat
(`timeout_ms` 1800000, re-arm while running):

```bash
s=$(date +%s); until [ -f <T>/done ]; do sleep 300; [ -f <T>/done ] || echo "agy 仍在执行 <name>，已 $(( ($(date +%s)-s)/60 )) 分钟"; done
```

(Create `T` yourself first with `mktemp -d` so both commands know it.) Tell the user one line on
every event: dispatch, each heartbeat, done, review done, fix dispatched, accepted. Never run an
executor in the foreground — a Bash call over 10 min is cut off and the conversation goes silent.

codex review (read-only; ask the model first):

```bash
codex exec -s read-only -m <model> -c model_reasoning_effort=medium -C <repo> -o <task dir>/review.md "Review the working-tree changes against <abs card.md>. Run git status and git diff (include untracked files the card creates). Do not modify or create files. Reply: first line exactly VERDICT: PASS or VERDICT: FAIL, then at most 10 findings, each with file:line, the problem and the fix — wrong behaviour, steps not followed, files outside the card, copied code, junk files."
```

agy out of quota (429 / RESOURCE_EXHAUSTED / quota text) → ask the user for a codex model and run the
same card with `codex exec --approve-for-me -m <model> -C <repo> "<same instruction>"` (no `-s` with
`--approve-for-me`). Claude still doesn't implement.

## Pitfalls

- agy copies code instead of reusing it — name the helper to reuse in `## Don't`.
- codex's sandbox can't write `~/.mne`: for MNE code put `_MNE_FAKE_HOME_DIR=<temp dir>` in the check.
- Don't run agy inside codex (no sign-in there) or vice versa.
- Executors leave junk files — `git status` at acceptance; delete them before committing.
