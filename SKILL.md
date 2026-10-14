---
name: orchestrate
description: Claude plans and accepts; agy or codex executes a detailed task card; review is tiered by risk. Five commands — /orch (Claude picks the executor), /agy, /luna, /sol, /wb (fixed executor). Use whenever the user says Claude should plan/review but not implement, says 分工, 派活, 编排, orchestrate, /orch, /agy, /luna, /sol, /wb, 让 agy 干, 让 wb 干, 让 luna 干, 让 sol 干, 交给 agy/codex, or starts a feature, fix, refactor, analysis or batch job in a project whose HANDOFF.md says "Claude plans and reviews".
---

# orchestrate — Claude is the brain, agy and codex are the hands

Dates, incidents and measured costs behind these rules: [LESSONS.md](LESSONS.md).

**Why this shape.** Executors following explicit steps are fast and cheap. Executors *figuring things
out* — reading large files, designing, re-running whole test suites, reworking after strict reviews —
cost tens of times more. So design stays with Claude and the card says exactly what to do.

**Who writes.** Dispatch costs Claude 3–5k output tokens (card, dispatch, acceptance). Claude writes directly when that is cheaper and needs no design hand-off: small edits, and
self-contained helpers it can write in one go (e.g. the 25-line `ledger.mjs`). Anything coupled to existing code,
long, or needing a test loop is dispatched. Not in fixed modes (`/agy`, `/luna`, `/sol`) or when the user asked
Claude not to implement. The user sends other small jobs to `/son5`.

## Modes (executor is set by the command)

| Command | Executor | Use for |
|---|---|---|
| `/orch` (default) | all code, including new algorithms and ports → the code worker (asked, see below); Claude picks the rest: lookups, citation checks, bulk fact extraction → luna; sol executes only when the code worker failed the same card after 2 fixes (ask the user first, naming the job) | user didn't choose |
| `/agy` | agy | fixed |
| `/luna` | codex `gpt-6-luna` | fixed |
| `/sol` | codex `gpt-6.1-sol` | fixed |
| `/wb` | CodeBuddy CLI (WorkBuddy account) `deepseek-v4.1-flash` high | fixed |

**Code worker** (user): before the first code card of every `/orch` task ask "写代码交给 agy 还是 wb？";
Heavy work goes to the code worker, not sol: review layers 2 and 3 catch its misses.

**wb is agy's fallback, never a reviewer** (user). Switch `D:/2/dev/orch-runner/orchestrate/agy-fallback`:
`auto` (default, also when missing) → at dispatch the runner checks the antigravity quota and runs an agy card on wb
(`deepseek-v4.1-flash`) only while its 5h or 7d window is full; the summary's `executor:` line says `→ wb` when it fell
back. `on` → agy cards always on wb; `off` → always agy. Write it only when the user says so in chat, and say which it
is now. luna and sol never fall back: codex quota full → the runner exits 2 (`codex quota used up`) → tell the user.
Always flash, never another DeepSeek model (user).

Natural language: naming one executor ("让 / 交给 / 只让 agy|luna|sol|wb 干") → that fixed mode; "交给 codex"
without a model → `/orch`, choosing luna; plain 派活 / 分工 / 编排 → `/orch`. A slash
command beats wording inside its arguments (say so in one line if they conflict). Empty arguments → the
task in progress; none → ask in one line. luna and sol need no permission prompt (user); any
other codex model → ask, stating the concrete job. agy's model is fixed.

**Executor fails** (agy 429 / RESOURCE_EXHAUSTED / quota text, codex unreachable):
- fixed modes (`/agy`, `/luna`, `/sol`, `/wb`) → stop and tell the user; never switch executor on your own.
- `/orch` → ask the user which other executor to use, naming the job. Claude still doesn't implement.

**Reviewer out of quota.** Reviews run only on codex. Quota full when the review starts, or quota text when it dies →
the runner ends `review_pending` (no wb, no Claude substitute). The reviewer tier is a floor: sol for luna/sol
executors, high risk or `--reviewer sol`; `--reviewer luna` cannot lower it (summary says `floor sol`). On `review_pending`: do not replace the conformance review with a Claude line-by-line read. Accept
provisionally as `review pending` (in `## Acceptance` and the project log), and run the codex review when
quota returns. High risk: may be committed but marked `unreviewed`; its numbers don't go into the paper
until the review passes.

## Review — tiered by risk, same in every mode

Three layers:
1. **Check** — the card's Check command, run by `run-card.mjs` after the executor exits (the executor only runs a
   syntax self-check on what it changed; manual fallback: the executor runs the Check). Always.
2. **Conformance review** — diff against the card (steps followed, no files outside the card, no copied
   code, no junk files). Done by a read-only codex session, never by Claude:
   medium risk → `gpt-6-luna`, high risk → `gpt-6.1-sol` (checking a diff against a card needs no top model). When luna executed, sol reviews at medium and high; when sol executed, a *fresh*
   `gpt-6.1-sol` session.
   Code that later runs depend on (shared tooling, the runner, common modules) takes the high-tier reviewer (sol) even at
   medium risk: luna's reviews of shared code missed issues that sol found.
   **Audit**: after 4–5 accepted cards on the same module, run a read-only whole-repo sol audit (`/rv` 整体) and backfill
   each real finding into the K missed of the card that introduced it — a diff review never sees cross-card design bugs.
3. **Acceptance** — Claude only. Reads `review.md`, `git diff --stat`, the flagged hunks (`file:line`
   from the review) and the product (open the figure, run the CLI, read the numbers). Not the full diff.

**When a review is done** (user; an LLM review finds something new every round, so "no findings" is
never the stop signal). Every finding carries [P0]–[P3] and a code line that confirms it. Only P0/P1 (changes
behaviour, a result or a Parameters value, breaks the Goal or Check) block acceptance; P2/P3 go into Acceptance as
`deferred:` and are not fixed in this card. At most two review rounds per card: the first review, then one look at the
fix diff only — never a fresh full review. P0/P1 still open after that → the user decides.

Claude writes the tier into the card (`## Risk`). If a task fits several tiers, take the highest; if
unsure, go one up. The dispatch line names the tier (`派发 agy · risk=high · 将重算 <X>`) so the user can
override it.

| Risk | Examples | Layers |
|---|---|---|
| low | docs, typos, figure cosmetics, ≤ 10 lines | 1 + Claude looks at `diff --stat` |
| medium | ordinary code changes | 1 + 2 + 3 |
| high | numbers that go into the paper, data pipeline changes | 1 + 2 + 3, and in 3 Claude **independently recomputes at least one key number from the raw data** (another method, e.g. per-subject means `lm` against the GLMM) and double-checks any too-good statistic (tiny SE, R² ≈ 1, tiny p with a small effect) |

Lookup / literature / extraction tasks (any executor or subagent) usually produce no diff: skip layer 2;
in layer 3 every claim the user's decision hinges on — usually 1–2 — Claude verifies once at the primary source (source code, PDF page) before it
goes into a log or the paper.

Why the high tier: a self-check or a conformance review cannot catch a wrong number; only an independent recompute does.

## Flow

1. **Read just enough.** `grep -n` / `sed -n 'a,bp'` on the code the change touches. For a large
   unfamiliar area, first send a read-only recon card ("summarise X: functions, call sites, data
   flow, ≤ 40 lines", dispatched with `--recon`) and plan from its summary.
2. **Write the card** — `docs/orch/<yyyy-mm-dd>-<name>/card.md` in the project (sections below). Start from `D:/2/dev/orch-runner/orchestrate/card-template.md`.
   One task per card. Show the user the card before dispatching when it writes to data folders or
   does anything irreversible; otherwise dispatch.
3. **Dispatch through the runner** — one background Bash (`run_in_background`, `timeout` 7200000, cwd = repo), no heartbeat:
   ```bash
   node D:/2/dev/orch-runner/orchestrate/runner/run-card.mjs --card <abs card.md> --name <name> --executor agy|luna|sol|wb --risk low|medium|high --repo <abs repo> # agent-live/<agy|codex>-<name>.jsonl agent-live/codex-review-<name>.jsonl agent-live/codex-plan-<name>.jsonl
   ```
   Keep the trailing comment with the literal stream paths: token-weather shows a lane only for paths spelled in the
   command. The runner lints the card (exit 2 lists every problem; nothing has started; exit 2 with `codex quota used up` → codex quota full for a luna/sol executor or a high-risk card: tell the user), snapshots git status + content
   hashes, runs the Check once as a baseline (summary `baseline check:`; red before the executor = not its fault), for high
   risk runs a read-only sol plan review of the card (`PLAN: REVISE` stops before execution), runs the executor, compares read-only paths, checks touched files against `## Files`, runs the Check itself,
   runs the review for the tier (Review section), runs `ledger.mjs`, appends `## Acceptance (draft)` on a pass, and
   prints one summary. Claude is woken once, by the completion notice. `--recon`: read-only card, no Check, any file
   change is out of scope. `--exec-check`: the executor runs the card's Check itself (up to 3 attempts) before replying; the runner still re-runs it as the evidence. Recommended when the Check finishes in under 2 minutes; kept in the state file for `--fix N`. `--timeout-min` (default 100, the Bash job dies at 120). `--reviewer sol`: shared tooling at medium risk (Review layer 2). Not a git repo: works on a
   size/mtime snapshot; `--commit` refuses. State: `~/.claude/agent-live/orch-runner/<name>.json`.
   **Long runs (> 10 min of computing):** the executor writes the script and runs the pilot only; Claude starts the full
   run in the background with `node D:/2/dev/orch-runner/orchestrate/runner/run-long.mjs --name <name> --out <output dir> [--resume] -- <command> # agent-live/run-<name>.jsonl`
   (refuses an existing output dir unless `--resume`; default timeout 110 min; split longer runs into resumable parts;
   a waiting executor re-reads its context on every poll).
4. **Read the summary** (its first line is `ORCH-RUNNER <name> outcome=<outcome>`):

   | outcome | next |
   |---|---|
   | `review_pass`, `passed_no_review`, `recon_done`, `fix_passed` | step 6 (low risk: also glance at `diff --stat`) |
   | `review_fail` | check each finding at its `file:line`, then step 5 |
   | `check_failed` | the summary has the Check's tail; step 5 |
   | `out_of_scope` | 🛑 show the files, the user decides (never auto-revert); `junk:` paths are deleted only after the user says so in one line; false positive → add `- scope override: <reason>`, run `--recheck` and `--review-only`, then `--commit` |
   | `readonly_violated` | 🛑 show the changed read-only paths to the user |
   | `blocked`, `failed`, `interrupted` | read the reply / stream tail; executor failures follow **Executor fails** above |
   | `review_pending` | codex quota ran out: **Reviewer out of quota** above |
   | `plan_revise` | high risk only: sol's pre-execution plan review found a card problem (findings in the summary); nothing ran — fix the card, dispatch again |
   | `plan_error` | the plan review produced no `PLAN:` line or died: read `codex-plan-<name>.jsonl`, fix the cause, dispatch again |
   | `review_error` | read the tail of `codex-review-<name>.jsonl`: anything else (bad config, no VERDICT twice) → fix the cause and re-run the review — no provisional acceptance |
5. **Fix.** A real finding whose fix is a few mechanical lines (a missing check, a wrong regex, a duplicate
   declaration): Claude fixes it directly — except in fixed modes or when the user asked Claude not to implement
   (same rule as **Who writes**) — runs `node D:/2/dev/orch-runner/orchestrate/runner/run-card.mjs --recheck --name <name>` (the card's Check on
   the current tree; `--commit` refuses files changed since the last Check, or a last Check that failed), and adds a
   `- claude fix: <what>` line to Acceptance (`--commit` needs it to accept a `review_fail` / `check_failed` run) — an executor fix round is small. Anything larger: append `## Fix N` to the card (exact steps), then
   `node D:/2/dev/orch-runner/orchestrate/runner/run-card.mjs --fix N --fresh --name <name> # agent-live/<agy|codex>-<name>.jsonl` (card, repo, executor, risk come from the state file).
   It runs the executor (`--fresh`: a new agy session; drop it to continue),
   read-only guard, files check and Check, no second conformance review; the summary carries the fix diff, which is
   all Claude reads. High risk: recompute the key number again. Max 2 fixes, then a new card in `<task>-v2/`.
6. **Accept.** Turn `## Acceptance (draft)` into `## Acceptance`: replace the `TODO`s (verdict: accepted / review
   pending / rejected; `review findings: N real / M false positive / K missed`, with tier and reviewer; recompute result
   for high risk); the files, Check and `tokens:` lines are already filled in. Then
   `node D:/2/dev/orch-runner/orchestrate/runner/run-card.mjs --commit --name <name> --message "<msg>"` — it stages only the
   card's files + card.md + review.md + reply.md (and appends to `docs/review-log.md` when the project has one), commits, prints the
   hash; **don't push**. Commit messages end with the attribution lines the session asks for.
   When a bug in an accepted card's code turns up later (user test, ocr, another review), add it to that card's K missed
   with where it was found and the fix commit, then commit the card. After 10–15 cards, change the Modes table from
   `node D:/2/dev/orch-runner/orchestrate/runner/stats.mjs` and the Acceptance rows, not from impressions (user).
   Analysis logs follow the project's CLAUDE.md rules.

## Card sections (`card.md`)

```markdown
# <name> — <one-line goal>
## Goal        what is true when done, in observable terms
## Risk        low / medium / high (+ the key number Claude will recompute, for high); the first word must equal --risk
## Parameters  every value the result depends on, with its expected value — analysis settings (windows, N,
               exclusions, K range, weights, seeds), thresholds, paths, constants, config keys. The code asserts
               each one; the reviewer checks them one by one. Omit only when nothing in the task has a value.
## Files       may change: `a.py`, `dir/` … / read-only: `data/` … — every path in backticks (the runner reads them:
               may-change paths bound the files check; read-only paths get a size/mtime guard). Data folders always read-only.
               Git-ignored files are outside the files check: list an ignored path that matters as read-only.
## Steps (N = k)  numbered 1..N, the total in the heading; per step: file → function → the exact behaviour change; code snippets
               for anything fiddly (index math, time axes, regexes, API calls the executor may get wrong)
               When a step adds a check or invariant, list every path that can bypass it (cache hit, early
               return, fallback, retry) and say how each one is covered.## Check       one command in backticks (or a fenced block), the fastest existing test that proves the goal; add ONE small new test
               only for a bug with a crisp repro, and spell it out here
## Expect      optional. `green` = a refactor: the Check is meant to pass before the change too (no baseline WARNING).
               Otherwise the runner prints WARNING when the Check already passes before the change: add a test that fails on the old code.
## Don't       no commits, no other files, no refactors beyond the steps, reuse helper X instead of copying; and always:
               "Run scripts in the foreground and wait; before replying, stop any background task still running."
               "Reuse existing functions; don't copy existing logic." "No rm, no git push, no git checkout . / restore . / reset --hard."
```

Later sections appended in the same file: `## Fix 1`, `## Fix 2`, `## Acceptance`. Each task folder
holds only `card.md`, `review.md` and `reply.md` (the executor's full reply). The runner refuses a card missing Goal / Risk / Files / Check / Steps (N = k) /
Don't or the three quoted Don't sentences (recon cards may omit Check).

### Research data outside git (input read-only, output isolated)

When the task reads raw data or writes results into an untracked folder, the card must also say:
- raw data directories are read-only: no delete, move, rename or in-place overwrite;
- the output directory must not exist at the first start; if it does, stop — never clear or reuse it. A resume
  reuses it only after the script checks its own saved run parameters (e.g. `run_params.json`) match;
- temp files, logs and results all stay in the output directory;
- compare the raw-file list, sizes and mtimes before and after; any difference = failure, stop;
- **checkpoint / resume** (user's hard requirement): any script expected to run > 10 min
  saves results in batches, skips finished batches on restart, skips if the final output exists; each
  batch's seed depends only on its batch number so a resumed run is bit-identical to an uninterrupted
  one; prove it with a small trial (run straight through vs stop once and resume). Batch size: an
  interruption loses at most ~10 min.
- fix rounds may modify only files this task created in that output directory; replaced results are
  renamed with suffix `_SUPERSEDED_<reason>`, not deleted, and the report gets a version line on top.

## Manual fallback (runner missing or broken)

Same flow by hand; the executor runs the Check. Steps 1–2 above stay.

3. **Snapshot.** Save `git status --short` as *before* (outside git: the file list with sizes and mtimes
   of the folders the card may touch). Existing changes belong to the
   user — the executor must not overwrite them.
4. **Execute** (background, no heartbeat; commands below). **Long runs (> 10 min of computing):** the executor
   writes the script and runs the pilot only; Claude starts the full run as a background Bash job (0 tokens while it
   computes; a waiting executor re-reads its context on every poll).
   Command (literal paths, so the lane `脚本 <name>` shows; the `.exit` file turns it done/failed):
   `python <script> 2>&1 | tee ~/.claude/agent-live/run-<name>.jsonl; echo ${PIPESTATUS[0]} > ~/.claude/agent-live/run-<name>.exit`
   — the script appends `k/N 已完成：… · 正在：…` to `~/.claude/agent-live/run-<name>.progress` after each checkpoint.
   A Bash job is killed at 2 h: split longer runs into resumable parts.
5. **Touched files.** Take the snapshot again as *after*. Exempt: `docs/orch/<task>/card.md` and
   `review.md`. Any other touched file not in the card's `## Files` → 🛑 stop, show it, let the user decide
   (never auto-revert). Obvious junk (`__pycache__`, `*.log`, `tmp*`) is deleted only after the user says so
   in one line.
6. **Review** per the risk tier.
7. **Fix if needed.** Append `## Fix 1` to the card (exact steps) and re-run the **same** executor with
   `--conversation <id>` for agy (≈ 80 % of the fixed overhead is then cached), unless that session did a long
   run — then a fresh agy call; codex executors get a fresh `codex exec` with "carry out ## Fix N of <card>". Claude reads
   only that fix's diff (it is small) — no second conformance review; high risk: recompute the key number
   again. Max 2 fixes, then write a new card in `<task>-v2/` and keep the old folder. A `review.md` without a
   first-line VERDICT counts as FAIL: re-run the review once.
8. **Accept.** Append `## Acceptance` to the card (verdict: accepted / review pending / rejected, files, check result, recompute result for
   high risk, commit hash, and two ledger lines below), commit code + card + review, **don't push**.
   - `tokens:` the output of `node D:/2/dev/orch-runner/orchestrate/ledger.mjs <name>` (one row per executor and reviewer run),
     taken before any same-name dispatch clears the streams; fix rounds add their own row.
   - `review findings:` N real / M false positive / K missed (a bug found later by Claude or a later review), with tier and reviewer.
     When a bug in an accepted card's code turns up later (user test, ocr, another review), add it to that card's K missed
     with where it was found and the fix commit, then commit the card. Long runs get the same two lines (the run itself adds no executor row).
   After 10–15 cards, change the Modes table from these rows, not from impressions (user).
   If the project keeps a code log (e.g. `docs/review-log.md`), add one line pointing at the card. Analysis logs follow the
   project's CLAUDE.md rules.

## Commands (manual fallback)

Run `mkdir -p ~/.claude/agent-live` once first. Before every dispatch create `T=$(mktemp -d)` (used by the
commands). Only at a card's first dispatch, clear same-name leftovers:
`rm -f ~/.claude/agent-live/{agy,codex,codex-review,run}-<name>.{jsonl,progress,exit}` — later dispatches (review,
fixes) must not, or the ledger loses the earlier rows; a re-run of the same role first saves its ledger row.

Progress line — append to every executor instruction: "after starting, append `0/N 已完成：无 · 正在：<第1步>`, and after finishing each step append `k/N 已完成：X · 正在：Y` (Chinese; Y says in plain words what is being done now and how far along it is, 30–50 characters, no function names needed, e.g. `2/5 已完成：读 README · 正在：给 README 加额度说明，开头两段已写好，还差示例和截图`), as a new line, in UTF-8 (PowerShell: Add-Content -Encoding utf8), to <abs ~/.claude/agent-live/<agy|codex>-<name>.progress>. Just append; do not open, list or inspect that directory or any other file to learn the format." The last sentence matters: without it, agy explores `agent-live/` for a 1-line edit. The token-weather mod shows it as the lane progress bar, only in the session whose Bash command spells out the `agent-live/<name>.jsonl` path literally (no shell variables in the name). The lane crops the line's end on a narrow screen, so keep X short and put any changing count first in Y (`正在：T-AAHC交叉验证 76/100（k-means 已完）`, not `正在：交叉验证 k-means 72/72 · T-AAHC 76/100`): a count at the end gets cropped and the lane looks frozen. A sub-step counter Claude writes itself (a silent background loop appending to the same `.progress`) follows the same rule.

**agy** (model fixed; `-p` ignores stdin, so it reads the card from disk):

```bash
C:/Users/ASUS/AppData/Local/agy/bin/agy.exe -p "Read <abs card.md> and carry out every step exactly; run only the commands the Steps and the Check name; do not commit. Reply with: files changed, check result, anything you could not do. <progress line>" --model gemini-3.8-flash-high --dangerously-skip-permissions --output-format stream-json 2>&1 | tee ~/.claude/agent-live/agy-<name>.jsonl > $T/agy.jsonl; echo ${PIPESTATUS[0]} > ~/.claude/agent-live/agy-<name>.exit; echo done > $T/done
```

Fix rounds add `--conversation <conversation_id>`. agy's reply and `conversation_id` are in the last
line of `$T/agy.jsonl` (`"event":"result"`, fields under `.result`): read it with `tail -n 1`, never the
whole file. If the last line is not a result (crash, killed), read the last few lines for the cause.
`--dangerously-skip-permissions` is per call; never edit `~/.gemini/config/config.json`.

**codex executes** (`/luna`, `/sol`, or `/orch` picking codex):

```bash
{ echo '{"model":"<model>"}'; codex exec --approve-for-me -m <model> -C <repo> --json "Read <abs card.md> and carry out every step exactly; run only the commands the Steps and the Check name; do not commit. Reply with: files changed, check result, anything you could not do. <progress line>" < /dev/null; } > ~/.claude/agent-live/codex-<name>.jsonl 2>&1; echo $? > ~/.claude/agent-live/codex-<name>.exit; echo done > $T/done
```

(no `-s` with `--approve-for-me`; outside git add `--skip-git-repo-check`, review against the file snapshot, and write
`commit: n/a` in Acceptance). `< /dev/null` is required: with stdin left open codex prints "Reading additional input from stdin..." and hangs. The first line names the lane (`GPT-6 Luna` / `GPT-6.1 Sol`).

**codex conformance review** (read-only; `<reviewer>`: luna or sol executed → `gpt-6.1-sol` (fresh session); otherwise
`gpt-6-luna` for medium risk, `gpt-6.1-sol` for high):

```bash
{ echo '{"model":"<reviewer>"}'; codex exec -s read-only -m <reviewer> -c model_reasoning_effort=medium -C <repo> -o <task dir>/review.md --json "Review the working-tree changes against <abs card.md>. Run git status and git diff (include untracked files the card creates); read only the diff, the card and the code the diff touches. Do not run tests or scripts (the Check was already run) and do not modify or create files. card.md and review.md under docs/orch/<task>/ are always allowed. These files already had uncommitted changes before this task: <paths from the before snapshot>. Those earlier changes are not part of it, but review any further change this task made in them. Report only problems this diff introduces; list pre-existing problems in one line at the end, outside the verdict. No style or naming remarks. Reply: first line exactly VERDICT: PASS or VERDICT: FAIL, then at most 5 findings, most severe first, each starting with a priority tag, then file:line, the problem, the fix and the code line that confirms it (read it; drop any finding you cannot confirm in the code) — wrong behaviour, a Parameters value not matching the card, a bypassed check, steps not followed, files outside the card, copied code, junk files. Priority: [P0]/[P1] = changes behaviour, a computed result or a Parameters value, breaks the card's Goal or Check, bypasses a check, or skips a step; [P2]/[P3] = everything else. VERDICT: FAIL only when at least one [P0] or [P1] finding exists." < /dev/null; } > ~/.claude/agent-live/codex-review-<name>.jsonl 2>&1; echo $? > ~/.claude/agent-live/codex-review-<name>.exit; echo done > $T/review.done
```

**wb executes** (`/wb`, or an agy card while agy's quota is full): the codex exec command with
`codebuddy` in place of `codex exec` — exec: `{ echo '{"model":"deepseek-v4.1-flash"}'; codebuddy -p "<same prompt>" --model deepseek-v4.1-flash --effort high -y --output-format stream-json < /dev/null; } > ~/.claude/agent-live/codex-<name>.jsonl 2>&1`.
The reply is the `result` field of the last `{"type":"result"}` line.

Fill `<paths from the before snapshot>` from step 3 (without it, sol counts the user's own earlier edits against the card). Run the review in the background too.

**Background, no heartbeat.** Run the executor (and the review) with `run_in_background` and
`timeout` 7200000, cwd = repo. Do **not** arm a Monitor heartbeat: every event wakes Claude for a full turn,
which re-reads the whole context (tens of thousands of tokens late in a session) just to say "still running".
The user watches progress in the token-weather lane at zero token cost; Claude is woken once, by the
background task's completion notice.

Tell the user one line on: dispatch, done, review done, fix dispatched, accepted — each naming the risk tier
where relevant.

## Pitfalls

- codex's sandbox can't write `~/.mne`: for MNE code put `_MNE_FAKE_HOME_DIR=<temp dir>` in the check.
- Don't run agy inside codex (no sign-in there) or vice versa.
- Cost check: `node D:/2/dev/orch-runner/orchestrate/cost.mjs <transcript.jsonl>`.
- Source locations: this skill is a symlink to `D:/2/dev/orch-runner/orchestrate`; the live token-weather mod is `D:/2/dev/token-weather-quotas/hooks/token-weather.mjs` (the `~/.claude/plugins/cache/.../token-weather` copy is the old, disabled one).
