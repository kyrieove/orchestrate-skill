# Retro 2026-10-05 — adding the wb executor (CodeBuddy / DeepSeek) to orchestrate and token-weather

Source: one Claude Code session in `gn_manuscript` (wb executor, codex→wb switch, token-weather `wb` button, retro
fixes dispatched to wb). Candidates, most severe first. Nothing implemented yet.

1. **Shell escapes lost in Bash heredocs (tool economy).** Three times a `node - <<'EOF'` edit script lost its
   backslashes (`"\\n"` became a raw newline, `\\(` became `(`), leaving a syntax error that took 1–2 extra turns to
   repair (token-weather toggle, `tw_check.cjs`, `review.mjs` split). Every edit script holding a backslash failed;
   ones without passed. Fix: one line in global `CLAUDE.md` — "an edit script containing a backslash goes to a
   scratchpad file via Write, then `node <file>`; never a heredoc or `node -e`". CRLF files (SKILL.md) also failed
   plain `includes()` matches once: the same scratchpad scripts should normalise `\r\n` first.
2. **ledger.mjs counts 0 tokens for wb (automated check / information access).** Every wb row reads
   `fresh 0k, cached 0k, out 0k`: `ledger.mjs` handles agy's `event: "result"` and codex's `turn.completed`, not
   CodeBuddy's `{"type":"result","usage":{input_tokens, cache_read_input_tokens, output_tokens}}`. After 10–15 cards
   `stats.mjs` will rank wb as free. Fix: one branch in `ledger.mjs` plus a Case in `test-run-card.mjs` with a fake
   CodeBuddy stream.
3. **No test covers the wb command path (automated check).** `ORCH_RUNNER_FAKE_EXEC` / `_FAKE_REVIEW` replace the
   whole command, so the wb exec/review strings and the result-line parsing were only checked by hand. The review
   lane stuck at 启动中 (text output, nothing streamed) reached the user before any test. Fix: a fake `codebuddy`
   on PATH in the test (prints a canned stream-json), one exec Case and one review Case with `codex-fallback` = on.
4. **Two token-weather copies (navigation).** The live plugin is `D:/2/dev/token-weather-quotas` (via
   `CLAUDE_CODE_PLUGIN_DIRS`); `~/.claude/plugins/cache/claude-code-playground-mods/token-weather` is the old,
   disabled one with a Compact button. The agent read the cache copy first and described the wrong UI. Likewise
   `~/.claude/skills/orchestrate` is a symlink to `D:/2/dev/orch-runner/orchestrate`. Fix: a navigation pointer in
   orchestrate `SKILL.md` Pitfalls: "token-weather source: `D:/2/dev/token-weather-quotas/hooks/token-weather.mjs`
   (the plugins/cache copy is disabled)".
5. **Runner discovers codex quota only at review time (automated check).** Codex 5h was at 100% before dispatch;
   the agent learned it from the user's screenshot. Fix: `run-card.mjs` runs `token-weather-quotas/hooks/quota.mjs`
   before a card whose review needs codex (risk ≥ medium, `codex-fallback` off) and exits 2 with
   "codex 5h at N%, resets HH:MM — ask the user about the codex→wb switch" when ≥ 100%.

Dropped:
- Misreading "wb 按钮可以代替 codex" as a toggle button: an ambiguity the agent should have asked about (global
  CLAUDE.md already says so); no environment change helps.
- The gn_manuscript retro's "check_env passes only with `hpm`": re-checked, `check_env` passes under `mnedev` (PATH
  python); HANDOFF corrected (gn_manuscript `dfebf33`). Retro claims about environments need one verification run
  before they go into a HANDOFF.
