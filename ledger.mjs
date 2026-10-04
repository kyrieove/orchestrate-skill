// Token use of one orchestrate task, for its ## Acceptance line.
// Usage: node ledger.mjs <name>   (no name: every stream in agent-live)
// Reads ~/.claude/agent-live/{agy,codex,codex-review}-<name>.jsonl; run it before the next same-name dispatch clears them.
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const dir = `${homedir()}/.claude/agent-live`;
const name = process.argv[2];
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && (!name || f.replace(/^(agy|codex-review|codex)-/, "") === `${name}.jsonl`));
const k = (n) => `${Math.round(n / 1000)}k`;

for (const f of files) {
  let model = "", fresh = 0, cached = 0, out = 0;
  for (const line of readFileSync(`${dir}/${f}`, "utf8").split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== "object") continue;
    model = e.init?.model ?? (typeof e.model === "string" ? e.model : model);
    // codex: input_tokens includes the cached part; agy: input_tokens is fresh only.
    if (e.type === "turn.completed" && e.usage) {
      const u = e.usage;
      fresh += u.input_tokens - (u.cached_input_tokens ?? 0); cached += u.cached_input_tokens ?? 0; out += u.output_tokens ?? 0;
    } else if (e.event === "result" && e.result?.usage) {
      const u = e.result.usage;
      fresh += u.input_tokens ?? 0; cached += u.cache_read_tokens ?? 0; out += u.output_tokens ?? 0;
    }
  }
  const role = f.startsWith("codex-review-") ? "review" : "exec";
  console.log(`${role} ${model || f.split("-")[0]}: fresh ${k(fresh)}, cached ${k(cached)}, out ${k(out)}  (${f})`);
}
