// Token use of one orchestrate task, for its ## Acceptance line.
// Usage: node ledger.mjs <name> [--json]   (no name: every stream in agent-live)
// Reads ~/.claude/agent-live/{agy,codex,codex-review,codex-plan}-<name>.jsonl; run it before the next same-name dispatch clears them.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const dir = process.env.ORCH_RUNNER_LIVE_DIR || `${homedir()}/.claude/agent-live`;
const isJson = process.argv.includes("--json");
const args = process.argv.slice(2).filter((a) => a !== "--json");
const name = args[0];
// run-<name> streams are plain script output with no token use: only executor and review streams count.
const files = (existsSync(dir) ? readdirSync(dir) : [])
  .filter((f) => /^(agy|codex-review|codex-plan|codex)-.+\.jsonl$/.test(f) && (!name || f.replace(/^(agy|codex-review|codex-plan|codex)-/, "") === `${name}.jsonl`))
  .sort();
if (!files.length) {
  console.error(`没有 ${name ? `${name} 的` : ""}执行或审查数据流：${dir}`);
  process.exit(1);
}
const k = (n) => `${Math.round(n / 1000)}k`;

const results = [];
for (const f of files) {
  let model = "", fresh = 0, cached = 0, out = 0;
  let stepFresh = 0, stepCached = 0, stepOut = 0, hasStepUsage = false;
  let resultFresh = 0, resultCached = 0, resultOut = 0;
  let badLines = 0, nonEmpty = 0;
  for (const line of readFileSync(`${dir}/${f}`, "utf8").split("\n")) {
    if (!line.trim()) continue;
    nonEmpty++;
    let e;
    try { e = JSON.parse(line); } catch { badLines++; continue; }
    if (!e || typeof e !== "object") { badLines++; continue; }
    model = e.init?.model ?? (typeof e.model === "string" ? e.model : model);
    if (f.startsWith("agy-") && e.type !== "result") {
      const u = e.step_update?.usage ?? e.usage ?? e.step?.usage;
      if (e.event === "step_update" && u) {
        hasStepUsage = true;
        stepFresh += u.input_tokens ?? 0;
        stepCached += u.cache_read_tokens ?? 0;
        stepOut += u.output_tokens ?? 0;
      } else if (e.event === "result" && e.result?.usage) {
        const ru = e.result.usage;
        resultFresh += ru.input_tokens ?? 0;
        resultCached += ru.cache_read_tokens ?? 0;
        resultOut += ru.output_tokens ?? 0;
      }
    } else {
      // codex: input_tokens includes the cached part; agy: input_tokens is fresh only.
      if (e.type === "turn.completed" && e.usage) {
        const u = e.usage;
        fresh += (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0);
        cached += u.cached_input_tokens ?? 0;
        out += u.output_tokens ?? 0;
      } else if (e.type === "result" && (e.usage || e.result?.usage)) {
        const u = e.usage ?? e.result?.usage;
        const cachedTokens = u.cache_read_input_tokens ?? u.cached_input_tokens ?? 0;
        fresh += Math.max(0, (u.input_tokens ?? 0) - cachedTokens);
        cached += cachedTokens;
        out += u.output_tokens ?? 0;
      }
    }
  }
  if (f.startsWith("agy-") && fresh + cached + out === 0) {
    if (hasStepUsage) {
      fresh = stepFresh; cached = stepCached; out = stepOut;
    } else {
      fresh = resultFresh; cached = resultCached; out = resultOut;
    }
  }
  // Warnings go to stderr so --json output stays parseable.
  if (badLines > 0) console.error(`warning: ${f}: ${badLines} unreadable line(s) skipped`);
  if (nonEmpty > 0 && fresh + cached + out === 0) console.error(`warning: ${f}: no token usage found (the format may have changed, or the run stopped before it finished)`);
  const role = f.startsWith("codex-review-") ? "review" : f.startsWith("codex-plan-") ? "plan" : "exec";
  const m = model || f.split("-")[0];
  if (isJson) {
    results.push({ role, model: m, fresh, cached, out, file: f });
  } else {
    console.log(`${role} ${m}: fresh ${k(fresh)}, cached ${k(cached)}, out ${k(out)}  (${f})`);
  }
}
if (isJson) {
  console.log(JSON.stringify(results));
}
