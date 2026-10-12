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
const unreadable = [];
let totalCards = 0;

for (const file of files) {
  const filePath = path.posix.join(stateDir, file);
  let state;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    state = JSON.parse(raw);
  } catch {
    unreadable.push(file);
    continue;
  }
  if (!state || typeof state !== "object") {
    unreadable.push(file);
    continue;
  }

  const executor = state.executor || "unknown";
  const risk = state.risk || "unknown";
  const groupKey = `${executor}/${risk}`;

  const fixesCount = Array.isArray(state.fixes) ? state.fixes.length : 0;

  const hasRounds = Array.isArray(state.rounds) && state.rounds.length > 0;
  const roundSecs = hasRounds ? state.rounds.filter((r) => typeof r.seconds === "number") : [];
  const execSec = roundSecs.length > 0
    ? roundSecs.reduce((sum, r) => sum + r.seconds, 0)
    : (state.exec && typeof state.exec.seconds === "number" ? state.exec.seconds : 0);
  const outcome = state.outcome || "unknown";

  let fresh = 0;
  let cached = 0;
  let out = 0;
  let hasTokens = false;
  const ledgerRows = hasRounds
    ? state.rounds.flatMap((r) => Array.isArray(r.ledger) ? r.ledger : [])
    : (Array.isArray(state.ledger) ? state.ledger : []);
  for (const row of ledgerRows) {
    if (row && (row.role === "exec" || (!row.role && !row.file?.startsWith("codex-review-")))) {
      hasTokens = true;
      fresh += row.fresh || 0;
      cached += row.cached || 0;
      out += row.out || 0;
    }
  }

  let g = groups.get(groupKey);
  if (!g) {
    g = {
      cards: 0,
      fixes: 0,
      execSec: 0,
      fresh: 0,
      cached: 0,
      out: 0,
      tokenCards: 0,
      outcomes: {}
    };
    groups.set(groupKey, g);
  }
  g.cards++;
  g.fixes += fixesCount;
  g.execSec += execSec;
  g.fresh += fresh;
  g.cached += cached;
  g.out += out;
  if (hasTokens) g.tokenCards++;
  g.outcomes[outcome] = (g.outcomes[outcome] || 0) + 1;
  totalCards++;
}

const k = (n) => `${Math.round(n / 1000)}k`;

const sortedKeys = Array.from(groups.keys()).sort();
for (const key of sortedKeys) {
  const g = groups.get(key);
  const avgExecMin = g.cards > 0 ? (g.execSec / g.cards / 60).toFixed(1) : "0.0";
  // Older state files kept the ledger as text: average tokens only over cards that have numbers.
  const avgFresh = g.tokenCards > 0 ? Math.round(g.fresh / g.tokenCards) : 0;
  const avgCached = g.tokenCards > 0 ? Math.round(g.cached / g.tokenCards) : 0;
  const avgOut = g.tokenCards > 0 ? Math.round(g.out / g.tokenCards) : 0;

  const outcomesStr = Object.keys(g.outcomes)
    .sort()
    .map((o) => `${o}:${g.outcomes[o]}`)
    .join(" ");

  console.log(`${key}  cards ${g.cards}  outcomes ${outcomesStr}  fixes ${g.fixes}  exec ${avgExecMin}m  fresh ${k(avgFresh)} cached ${k(avgCached)} out ${k(avgOut)}`);
}

console.log(`total cards ${totalCards}`);
// A state file that doesn't parse is missing from every number above: say so, don't let the totals look complete.
if (unreadable.length > 0) {
  console.log(`skipped unreadable state files: ${unreadable.length} (${unreadable.join(", ")})`);
}
process.exit(0);
