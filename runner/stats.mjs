import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const liveDir = process.env.ORCH_RUNNER_LIVE_DIR || path.posix.join(os.homedir().replaceAll("\\", "/"), ".claude/agent-live");
const stateDir = path.posix.join(liveDir, "orch-runner");

if (!fs.existsSync(stateDir)) {
  console.log("total cards 0");
  process.exit(0);
}

const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json")).sort();
const groups = new Map();
let totalCards = 0;

for (const file of files) {
  const filePath = path.posix.join(stateDir, file);
  let state;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    state = JSON.parse(raw);
  } catch {
    continue;
  }
  if (!state || typeof state !== "object") continue;

  const executor = state.executor || "unknown";
  const risk = state.risk || "unknown";
  const groupKey = `${executor}/${risk}`;

  let fixesCount = 0;
  if (Array.isArray(state.fixes)) {
    fixesCount = state.fixes.length;
  } else if (typeof state.fixes === "number") {
    fixesCount = state.fixes;
  }

  const execSec = (state.exec && typeof state.exec.seconds === "number") ? state.exec.seconds : 0;
  const outcome = state.outcome || "unknown";

  let fresh = 0;
  let cached = 0;
  let out = 0;
  let hasTokens = false;
  if (Array.isArray(state.ledger)) {
    for (const row of state.ledger) {
      if (row && (row.role === "exec" || (!row.role && !row.file?.startsWith("codex-review-")))) {
        hasTokens = true;
        fresh += row.fresh || 0;
        cached += row.cached || 0;
        out += row.out || 0;
      }
    }
  }

  if (!groups.has(groupKey)) {
    groups.set(groupKey, []);
  }
  groups.get(groupKey).push({
    outcome,
    fixes: fixesCount,
    execSec,
    fresh,
    cached,
    out,
    hasTokens
  });
  totalCards++;
}

const k = (n) => `${Math.round(n / 1000)}k`;

const sortedKeys = Array.from(groups.keys()).sort();
for (const key of sortedKeys) {
  const cards = groups.get(key);
  const cardCount = cards.length;
  const totalFixes = cards.reduce((sum, c) => sum + c.fixes, 0);
  const totalExecSec = cards.reduce((sum, c) => sum + c.execSec, 0);
  const totalFresh = cards.reduce((sum, c) => sum + c.fresh, 0);
  const totalCached = cards.reduce((sum, c) => sum + c.cached, 0);
  const totalOut = cards.reduce((sum, c) => sum + c.out, 0);

  const avgExecMin = cardCount > 0 ? (totalExecSec / cardCount / 60).toFixed(1) : "0.0";
  // Older state files kept the ledger as text: average tokens only over cards that have numbers.
  const tokenCards = cards.filter((c) => c.hasTokens).length;
  const avgFresh = tokenCards > 0 ? Math.round(totalFresh / tokenCards) : 0;
  const avgCached = tokenCards > 0 ? Math.round(totalCached / tokenCards) : 0;
  const avgOut = tokenCards > 0 ? Math.round(totalOut / tokenCards) : 0;

  const outcomeCounts = {};
  for (const c of cards) {
    outcomeCounts[c.outcome] = (outcomeCounts[c.outcome] || 0) + 1;
  }
  const outcomesStr = Object.keys(outcomeCounts)
    .sort()
    .map((o) => `${o}:${outcomeCounts[o]}`)
    .join(" ");

  console.log(`${key}  cards ${cardCount}  outcomes ${outcomesStr}  fixes ${totalFixes}  exec ${avgExecMin}m  fresh ${k(avgFresh)} cached ${k(avgCached)} out ${k(avgOut)}`);
}

console.log(`total cards ${totalCards}`);
process.exit(0);
