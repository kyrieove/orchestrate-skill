---
name: orchestrate
description: Hand multi-step coding, data or research work to the codex CLI and the agy CLI, which build and cross-review each other, while Claude only writes a short task card and does the final acceptance — the workflow that spends the least Claude quota. Use whenever the user says Claude should plan/review but not implement, says 分工, 派活, 编排, orchestrate, 让 codex 和 agy 干, 交给 codex, or starts a new module, feature, bug fix, analysis or literature survey in a project whose HANDOFF.md says "Claude plans and reviews".
---

# orchestrate — Claude writes the card and accepts; codex and agy build and review

The scarce resource is **Claude quota**. Every Claude turn re-reads the whole context, so the cost is
driven by how many turns a task takes and how much text comes back into Claude's context. This skill
keeps both small: Claude appears at dispatch and at acceptance; everything between runs unattended in
`orchestrate.py`. Claude never writes the implementation itself.

## Tiers (pick before writing the card)

| Tier | When | Flow |
|---|---|---|
| **quick** | one file, obvious fix, < ~20 lines | builder only + check command, no review (`--quick`) |
| **standard** | default | card → builder → check → reviewer → ≤ 2 auto-fix rounds |
| **planned** | new module, data processing, > 3 files | card → builder writes `plan.md` → reviewer reviews plan → auto-builds (stops only if plan review says NEEDS_INPUT) |

Ask the user before dispatching (show the card) only for irreversible actions or writes to data folders. Otherwise dispatch directly.

## Who builds, who reviews

Builder and reviewer are always different executors. **Default: agy builds, codex reviews** — agy is
much faster; codex's strictness is worth more in review, and it catches agy's habit of copying code.

| Task shape | Builder | Reviewer |
|---|---|---|
| Default: features, fixes, refactors, scaffolding, tests, docs, batch data runs | agy | codex |
| Exactness-critical (numbers must match a paper/reference bit for bit), or agy failed the same card twice | codex | agy |
| Web-grounded search, media transcription | agy | codex (spot-checks claims) |
| Literature metadata / DOI checks, text-only surveys | codex | agy |

Quota out on one side → the script swaps executors automatically (never calling an exhausted
provider again in this run); if that leaves one executor on both sides, the review runs in a fresh
session (on `gpt-6-astra` if codex) and the verdict is marked `same-source`.

## The task card (Claude writes this — ≤ 20 lines)

`.orchestrate/<yyyy-mm-dd>-<name>/card.md` in the project root (add `.orchestrate/` to `.gitignore`):

```markdown
---
name: fix-colorbar-ticks
builder: agy            # agy | codex
reviewer: codex         # the other one
check: python -m pytest test/test_source.py -q
tier: standard          # quick | standard | planned
---
Goal: <one or two sentences — what is true when done>
May change: <files or globs>
Read-only: <data folders, anything that must not be touched>
Notes: <constraints the executor can't guess: reuse function X, keep defaults, units…>
```

Write the goal as an outcome the check command can prove. Don't restate project rules the executors
can read themselves (`AGENTS.md`, `CLAUDE.md`, HANDOFF.md) — point at them.

## Run

```bash
python C:/Users/ASUS/.claude/skills/orchestrate/scripts/orchestrate.py run <card.md>
python C:/Users/ASUS/.claude/skills/orchestrate/scripts/orchestrate.py status <card.md>
```

Run `run` in the background; you are notified when it exits. Don't poll. When the user asks for
progress — or every 30 min for runs over an hour — read only the one-line `status`.

The script: refuses to start if another code-changing run holds the repo lock → creates branch
`orch/<name>` → builder → check → reviewer → feeds failures back to the builder (max 2 rounds) →
writes `summary.md` (≤ 10 lines). Fix rounds and re-reviews continue the same executor session
(`<run>/sessions.json`), so executors don't re-read the repo from scratch. Shared project context goes
in `<repo>/AGENTS.md` (codex reads it on its own; the script hands it to agy) — keep one per project:
file map, conventions, key functions, how to run the tests. Summary says `OPEN: no AGENTS.md` if missing. Executors never commit. Exit 0 = passed, 1 = failed after retries,
2 = needs Claude (plan review says NEEDS_INPUT, both quotas out, timeout).

## Acceptance (Claude)

Read, in this order, and stop as soon as something is wrong:
1. `summary.md` (≤ 10 lines: status, files changed, check result, open questions).
2. `git diff --stat main...orch/<name>` — files outside "May change" → reject.
3. The product itself: open the figure, run the CLI once, read the one output number that matters.

Don't read the full diff, logs or transcripts unless one of those three points at a problem; then
read only the part it points at. Accepted → tell the user, add one entry to the project log
(`docs/review-log.md` or equivalent) and HANDOFF.md; commit only when the user says so.

## Pitfalls

- agy copies existing code instead of reusing it — write "reuse X" in Notes; the codex review looks for duplicates.
- agy burns tokens waiting on slow tests — give the fastest check that proves the goal.
- codex can't fetch images; keep its literature work text-only.
- agy (verified 2026-10-01): with `-p` it ignores stdin — the script writes the prompt to a file and
  points `-p` at it; without `-p` (review) it must be told "use no tools", or headless mode denies its
  tool call and it prints nothing (this no-tools restriction applies to agy only; codex review runs read-only and may inspect files). Inside codex's sandbox agy can't sign in — don't nest them.
- Data: input folders read-only, outputs to a new folder, jobs > 10 min must resume in batches (see `agy-delegate` form C).
- Executors leave junk (e.g. `.mne-test-profile/`) — the reviewer flags untracked files.
