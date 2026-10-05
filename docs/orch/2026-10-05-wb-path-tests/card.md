# wb-path-tests — test the wb exec and review commands with a fake codebuddy; tests never read the real switch

## Goal
`node runner/test-run-card.mjs` prints `26/26 passed`, with two new cases that run the real wb command strings
against a fake `codebuddy` on PATH: one with the codex→wb switch on (luna executor, medium risk → exec and review both
on wb) and one with `--executor wb` and the switch off. The switch file path is overridable, and every test case
points it at a temp path, so the user's real `codex-fallback` file never changes a test.

## Risk
medium

## Parameters
- switch path override: env `ORCH_CODEX_FALLBACK_FILE`; default stays `C:/Users/ASUS/.claude/skills/orchestrate/codex-fallback`
- fake codebuddy reply: exec → `STATUS: done`; review (its argv contains `Review the`) → `VERDICT: PASS`
- expected review model with the switch on: `deepseek-v4.1-flash`
- test count: 24 → 26

## Files
may change: `runner/lib.mjs`, `runner/test-run-card.mjs` / read-only: everything else, including `SKILL.md`,
`ledger.mjs`, `runner/run-card.mjs`, `runner/executor.mjs`, `runner/review.mjs`

## Steps (N = 3)
Edit the existing code in place; keep its structure and style.

1. `runner/lib.mjs`: change the constant to
   `export const CODEX_FALLBACK_FILE = process.env.ORCH_CODEX_FALLBACK_FILE || "C:/Users/ASUS/.claude/skills/orchestrate/codex-fallback";`
   Nothing else in `lib.mjs` changes.
2. `runner/test-run-card.mjs`, setup:
   - in `baseEnv` add `ORCH_CODEX_FALLBACK_FILE: \`${tempLive}/codex-fallback\`` (the file does not exist → switch off
     for every existing case).
   - right after `baseEnv`, create a fake bin dir and script (write the script with `fs.writeFileSync`, mode `0o755`):
     ```js
     const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-bin-")).replaceAll("\\", "/");
     const stream = (reply) => [
       JSON.stringify({ type: "system", subtype: "init" }),
       JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }),
       JSON.stringify({ type: "result", subtype: "success", is_error: false, result: reply }),
     ].join("\n");
     fs.writeFileSync(path.join(fakeBin, "codebuddy"),
       `#!/bin/sh\ncase "$*" in\n  *"Review the"*) cat <<'EOF'\n${stream("VERDICT: PASS")}\nEOF\n  ;;\n  *) cat <<'EOF'\n${stream("STATUS: done")}\nEOF\n  ;;\nesac\n`,
       { mode: 0o755 });
     const wbEnv = { ...baseEnv, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` };
     delete wbEnv.ORCH_RUNNER_FAKE_EXEC;
     delete wbEnv.ORCH_RUNNER_FAKE_REVIEW;
     ```
     (if `baseEnv` does not contain those two keys, the deletes are harmless.) Add `fakeBin` to the `finally` cleanup
     next to `tempLive`.
3. `runner/test-run-card.mjs`, two cases after the last existing case, each starting with `resetRepo()` and using the
   file's existing `writeCard`, `runCard` and `readState` helpers:
   - **Case Y (switch on)**: `fs.writeFileSync(\`${tempLive}/codex-fallback\`, "on\n")`; `writeCard(undefined, "medium")`;
     run `runCard("case-y", { risk: "medium", env: wbEnv, args: ["--executor", "luna"] })` — if `runCard` takes the
     executor another way, follow how the existing cases pass a non-default executor. Assert: exit 0; state outcome
     `review_pass`; `state.exec.status === "done"`; `state.review.model === "deepseek-v4.1-flash"`; the card folder's
     `review.md` first line is `VERDICT: PASS`; the first line of `${tempLive}/codex-case-y.jsonl` contains
     `deepseek-v4.1-flash`. Then delete the switch file (`fs.rmSync(..., { force: true })`).
   - **Case Z (wb executor, switch off)**: `writeCard()` (low risk); `runCard("case-z", { env: wbEnv, args: ["--executor", "wb"] })`.
     Assert: exit 0; outcome `passed_no_review`; `state.exec.status === "done"`.
   - `passedCount++` after each; change the final summary from 24 to 26 (the `if`, the error message and `"24/24 passed"`).

## Check
`node runner/test-run-card.mjs`

## Don't
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.
- No commits, no other files, no refactors beyond the steps. Never read or write `~/.claude/skills/orchestrate/codex-fallback` itself.

## Acceptance
- verdict: accepted (runner outcome out_of_scope was a false alarm: Claude created `docs/orch/2026-10-05-codex-quota-precheck/card.md` during the run; Check and review then run by hand)
- files: runner/lib.mjs, runner/test-run-card.mjs
- check: `node runner/test-run-card.mjs` → 26/26 passed (run by Claude, before and after the fix below)
- tokens: exec deepseek-v4.1-flash (ledger does not parse CodeBuddy usage yet; user: skip for now)
- review findings: 2 real / 0 false positive / 0 missed (medium, deepseek-v4.1-flash by hand, codex out of quota) — Claude fixed both: the fake codebuddy now records its argv and Case Y asserts `--model deepseek-v4.1-flash` on both calls; exec/review routing keys on `--disallowedTools` instead of the prompt phrase. Bloat notes not taken.
