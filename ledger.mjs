// Token use of one orchestrate task, for its ## Acceptance line.
// Usage: node ledger.mjs <name>   (no name: every stream in agent-live)
// Reads ~/.claude/agent-live/{agy,codex,codex-review}-<name>.jsonl; run it before the next same-name dispatch clears them.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const dir = `${homedir()}/.claude/agent-live`;
const name = process.argv[2];
// run-<name> streams are plain script output with no token use: only executor and review streams count.
const files = (existsSync(dir) ? readdirSync(dir) : [])
  .filter((f) => /^(agy|codex-review|codex)-.+\.jsonl$/.test(f) && (!name || f.replace(/^(agy|codex-review|codex)-/, "") === `${name}.jsonl`))
  .sort();
if (!files.length) {
  console.error(`没有 ${name ? `${name} 的` : ""}执行或审查数据流：${dir}`);
  process.exit(1);
}
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
      fresh += (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0); cached += u.cached_input_tokens ?? 0; out += u.output_tokens ?? 0;
    } else if (e.event === "result" && e.result?.usage) {
      const u = e.result.usage;
      fresh += u.input_tokens ?? 0; cached += u.cache_read_tokens ?? 0; out += u.output_tokens ?? 0;
    }
  }
  const role = f.startsWith("codex-review-") ? "review" : "exec";
  console.log(`${role} ${model || f.split("-")[0]}: fresh ${k(fresh)}, cached ${k(cached)}, out ${k(out)}  (${f})`);
}
