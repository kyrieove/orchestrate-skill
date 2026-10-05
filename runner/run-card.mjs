import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { q, runBash, codexFallback } from "./lib.mjs";
import { parseArgs, getSection, lintCard, isJunkPath } from "./card.mjs";
import { snapshot, statTree, getReadOnlyDiff } from "./snapshot.mjs";
import { runCommit } from "./commit.mjs";
import { runExecutor } from "./executor.mjs";
import { runReview } from "./review.mjs";
import { formatLedgerLines, appendAcceptanceDraft } from "./acceptance.mjs";

// 1. Args & Card Parsing
const rawArgs = process.argv.slice(2);
const args = parseArgs(rawArgs);

const liveDir = (process.env.ORCH_RUNNER_LIVE_DIR || path.posix.join(os.homedir().replaceAll("\\", "/"), ".claude/agent-live"));
const normLiveDir = path.resolve(liveDir).replaceAll("\\", "/");
const stateDir = path.posix.join(liveDir, "orch-runner");
fs.mkdirSync(stateDir, { recursive: true });

// A may-change file larger than this (or git-ignored) is recorded by size + mtime instead of copied as fix base.
const MAX_BASE_BYTES = 1024 * 1024;

if (args.commit) runCommit(args, { stateDir });

const isFix = args.fix !== undefined;
const recon = !isFix && args.recon === true;
let card = args.card;
let name = args.name;
let executor = args.executor;
let risk = args.risk;
let repo = args.repo;
const timeoutMinArg = args["timeout-min"];

let existingState = null;
let fixRoundN = null;

if (isFix) {
  // card and repo default to the state file's (checked against it below when given).
  for (const req of ["name"]) {
    if (typeof args[req] !== "string" || args[req].trim() === "") {
      console.error(`Argument --${req} must be a non-empty string`);
      process.exit(2);
    }
  }
  if (!/^[\w.-]+$/.test(name)) {
    console.error("Invalid name argument");
    process.exit(2);
  }
  const stateFile = path.posix.join(stateDir, `${name}.json`);
  if (!fs.existsSync(stateFile)) {
    console.error("State file does not exist:", stateFile);
    process.exit(2);
  }
  try {
    existingState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    console.error("Failed to parse state file:", stateFile);
    process.exit(2);
  }

  const fixStr = String(args.fix).trim();
  if (!/^\d+$/.test(fixStr)) {
    console.error("Fix round N must be an integer:", args.fix);
    process.exit(2);
  }
  fixRoundN = parseInt(fixStr, 10);
  const recordedFixes = existingState.fixes?.length ?? 0;
  if (fixRoundN !== recordedFixes + 1 || fixRoundN > 2) {
    console.error(`Invalid fix round N=${fixRoundN} (recorded fixes: ${recordedFixes})`);
    process.exit(2);
  }

  for (const [key, val] of [["executor", executor], ["risk", risk]]) {
    if (val !== undefined && val !== existingState[key]) {
      console.error(`--${key} '${val}' does not match state '${existingState[key]}'`);
      process.exit(2);
    }
  }
  executor = existingState.executor;
  risk = existingState.risk;

  // --commit later uses the saved card and repo, so a fix must run on the same ones.
  for (const [arg, saved] of [["card", existingState.card], ["repo", existingState.repo]]) {
    if (typeof args[arg] === "string" && path.resolve(args[arg]).replaceAll("\\", "/") !== saved) {
      console.error(`--${arg} does not match state '${saved}'`);
      process.exit(2);
    }
  }
  card = existingState.card;
  repo = existingState.repo;
} else if (!args.commit) {
  for (const req of ["card", "name", "executor", "risk", "repo"]) {
    if (typeof args[req] !== "string" || args[req].trim() === "") {
      console.error(`Argument --${req} must be a non-empty string`);
      process.exit(2);
    }
  }

  if (!/^[\w.-]+$/.test(name)) {
    console.error("Invalid name argument");
    process.exit(2);
  }

  if (!["agy", "luna", "sol", "wb"].includes(executor)) {
    console.error("Invalid executor:", executor);
    process.exit(2);
  }

  if (!["low", "medium", "high"].includes(risk)) {
    console.error("Invalid risk:", risk);
    process.exit(2);
  }
}
// --reviewer sol: shared tooling gets the high-tier reviewer at medium risk (SKILL.md Review).
if (args.reviewer !== undefined && !["luna", "sol"].includes(args.reviewer)) {
  console.error("Invalid reviewer:", args.reviewer);
  process.exit(2);
}

// Refuse to start a card that needs codex while codex's quota is used up. A missing or failing quota script never blocks.
const needsCodex = !args.commit && !codexFallback() && (["luna", "sol"].includes(executor) || (!isFix && !recon && risk !== "low"));
if (needsCodex) {
  const quotaScript = process.env.ORCH_QUOTA_SCRIPT || "D:/2/dev/token-weather-quotas/hooks/quota.mjs";
  if (fs.existsSync(quotaScript)) {
    try {
      const quotaRes = spawnSync(process.execPath, [quotaScript], { encoding: "utf8", timeout: 45000 });
      if (quotaRes.status === 0) {
        const quota = JSON.parse(quotaRes.stdout);
        const five = quota.codex?.five ?? null;
        const week = quota.codex?.week ?? null;
        const fiveFull = five !== null && five.pct >= 100;
        const weekFull = week !== null && week.pct >= 100;
        if (fiveFull || weekFull) {
          const when = new Date((fiveFull ? five : week).resetMs).toLocaleString("zh-CN", { hour12: false });
          console.error(`codex quota used up (5h ${five?.pct ?? "-"}%, 7d ${week?.pct ?? "-"}%, resets ${when}): ask the user whether to switch codex to wb (SKILL.md "Codex → wb switch")`);
          process.exit(2);
        }
      }
    } catch {}
  }
}

let timeoutMin = 100;
if (timeoutMinArg !== undefined) {
  timeoutMin = parseFloat(timeoutMinArg);
  if (isNaN(timeoutMin) || timeoutMin <= 0) {
    console.error("Invalid timeout-min:", timeoutMinArg);
    process.exit(2);
  }
}
const deadline = Date.now() + timeoutMin * 60000;
const remainingMin = () => (deadline - Date.now()) / 60000;

const cardAbs = card ? path.resolve(card).replaceAll("\\", "/") : "";
if (cardAbs && !fs.existsSync(cardAbs)) {
  console.error("Card file does not exist:", cardAbs);
  process.exit(2);
}

const repoAbs = repo ? path.resolve(repo).replaceAll("\\", "/") : "";
let isGit = false;
if (repoAbs) {
  const gitCheck = spawnSync("git", ["-C", repoAbs, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  isGit = gitCheck.status === 0 && gitCheck.stdout.trim() === "true";
}

const cardBytes = cardAbs ? fs.readFileSync(cardAbs) : Buffer.from("");
const cardText = cardBytes.toString("utf8");
const cardSha = crypto.createHash("sha256").update(cardBytes).digest("hex");

if (isFix) {
  const hasFixHeading = cardText.split(/\r?\n/).some((l) => l.trim() === `## Fix ${fixRoundN}`);
  if (!hasFixHeading) {
    console.error(`The card has no line exactly '## Fix ${fixRoundN}'`);
    process.exit(2);
  }
} else if (!args.commit) {
  const lintProblems = lintCard(cardText, { recon, risk });
  if (lintProblems.length > 0) {
    for (const prob of lintProblems) {
      console.error(`lint: ${prob}`);
    }
    process.exit(2);
  }
}

const checkSection = getSection(cardText, "Check");
let check = null;
if (checkSection !== null) {
  const fencedMatch = checkSection.match(/```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/);
  if (fencedMatch) {
    check = fencedMatch[1].trim();
  } else {
    const inlineMatch = checkSection.match(/`([^`]+)`/);
    if (inlineMatch) {
      check = inlineMatch[1].trim();
    }
  }
} else if (!recon) {
  console.error("No ## Check section found in card");
  process.exit(2);
}

if (!check && !recon) {
  console.error("No check command found in ## Check");
  process.exit(2);
}

const filesSection = getSection(cardText, "Files") || "";
const readOnlyIdx = filesSection.search(/read-only/i);
const allowedText = readOnlyIdx >= 0 ? filesSection.slice(0, readOnlyIdx) : filesSection;
const mayChange = [];
const backtickMatches = allowedText.matchAll(/`([^`]+)`/g);
for (const m of backtickMatches) {
  let entry = m[1].trim().replace(/\s+\(new\)$/i, "");
  mayChange.push(entry);
}

const cardDirNorm = path.resolve(path.dirname(cardAbs)).replaceAll("\\", "/");
let taskDir = path.posix.relative(repoAbs, cardDirNorm);
if (taskDir === "") taskDir = ".";
const exemptPaths = new Set([
  taskDir === "." ? "card.md" : `${taskDir}/card.md`,
  taskDir === "." ? "review.md" : `${taskDir}/review.md`
]);

const readOnlyRaw = [];
if (readOnlyIdx >= 0) {
  const afterReadOnly = filesSection.slice(readOnlyIdx + "read-only".length);
  for (const m of afterReadOnly.matchAll(/`([^`]+)`/g)) {
    readOnlyRaw.push(m[1].trim());
  }
}

const readOnlyPaths = [];
for (const p of readOnlyRaw) {
  let resolved;
  if (p.startsWith("~/") || p === "~") {
    resolved = path.resolve(os.homedir(), p.slice(p === "~" ? 1 : 2));
  } else if (path.isAbsolute(p)) {
    resolved = path.resolve(p);
  } else {
    resolved = path.resolve(repoAbs, p);
  }
  resolved = resolved.replaceAll("\\", "/");

  if (!fs.existsSync(resolved)) continue;
  if (resolved === normLiveDir || resolved.startsWith(normLiveDir + "/")) continue;
  if (resolved === cardDirNorm || resolved.startsWith(cardDirNorm + "/")) continue;

  readOnlyPaths.push(resolved);
}

// 2. State file

const stateFile = path.posix.join(stateDir, `${name}.json`);
const checkLog = path.posix.join(stateDir, `${name}.check.log`);

function save(st) {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), "utf8");
  fs.renameSync(tmp, stateFile);
}

let state;
let basePaths = [];
let baseDir = null;

if (isFix) {
  state = existingState;
  state.git = existingState.git !== undefined ? existingState.git : isGit;
  if (!state.rounds) state.rounds = [];
  if (state.rounds.length === 0) {
    state.rounds.push({ round: "1", ledger: state.ledger, touched: state.touched, seconds: state.exec?.seconds ?? null });
  }
  if (!state.fixes) state.fixes = [];
  state.mayChange = mayChange;
  state.check = check;
  state.stage = "executing";
  state.outcome = null;
  state.readOnlyChanged = null;
  state.outOfScope = null;
  state.junk = null;
  state.exec = { exit: null, status: null, seconds: null, reply: null };
  state.checkResult = { exit: null, log: null };
  save(state);

  baseDir = path.posix.join(stateDir, `${name}.fix${fixRoundN}.base`);
  fs.mkdirSync(baseDir, { recursive: true });
  function addDirFiles(dirAbs) {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.posix.join(dirAbs, entry.name);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          addDirFiles(full);
        } else if (st.isFile()) {
          const rel = path.posix.relative(repoAbs, full);
          basePathsSet.add(rel);
        }
      } catch {}
    }
  }

  const basePathsSet = new Set();
  for (const p of mayChange) {
    const absP = path.resolve(repoAbs, p).replaceAll("\\", "/");
    if (!fs.existsSync(absP)) continue;
    try {
      const st = fs.statSync(absP);
      if (st.isFile()) {
        basePathsSet.add(p);
      } else if (st.isDirectory()) {
        addDirFiles(absP);
      }
    } catch {}
  }
  for (const p of (state.touched || [])) {
    basePathsSet.add(p);
  }
  basePaths = Array.from(basePathsSet).sort();
  let ignored = new Set();
  if (isGit) {
    const igRes = spawnSync("git", ["check-ignore", "--stdin"], { cwd: repoAbs, input: basePaths.join("\n"), encoding: "utf8" });
    ignored = new Set((igRes.stdout ?? "").split(/\r?\n/).filter(Boolean));
  }
  const stats = {};
  for (const p of basePaths) {
    const src = path.resolve(repoAbs, p);
    const dest = path.resolve(baseDir, p);
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      const st = fs.statSync(src);
      if (ignored.has(p) || st.size > MAX_BASE_BYTES) {
        stats[p] = { size: st.size, mtimeMs: st.mtimeMs };
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
  state.fixBaseStats = stats;
  save(state);
} else {
  state = {
    name,
    recon,
    card: cardAbs,
    cardSha,
    executor,
    risk,
    repo: repoAbs,
    git: isGit,
    check,
    mayChange,
    startedAt: new Date().toISOString(),
    stage: "executing",
    outcome: null,
    before: null,
    after: null,
    readOnlyBefore: null,
    readOnlyChanged: null,
    touched: null,
    outOfScope: null,
    junk: null,
    exec: { exit: null, status: null, seconds: null, reply: null },
    checkResult: { exit: null, log: null },
    review: { model: null, verdict: null },
    ledger: null,
    conversationId: null,
    cardModified: false,
    rounds: [],
    fixes: [],
    allTouched: []
  };
  save(state);
}

// 3. Snapshot
state.before = snapshot(repoAbs, isGit);
state.readOnlyBefore = statTree(readOnlyPaths, { normLiveDir, cardDirNorm });
save(state);

if (isFix) {
  const execPrefix = (executor === "agy" || process.env.ORCH_RUNNER_FAKE_EXEC) ? "agy" : "codex";
  fs.rmSync(path.posix.join(liveDir, `${execPrefix}-${name}.progress`), { force: true });
  fs.rmSync(path.posix.join(liveDir, `${execPrefix}-${name}.exit`), { force: true });
} else {
  for (const prefix of ["agy", "codex", "codex-review"]) {
    for (const ext of ["jsonl", "progress", "exit"]) {
      fs.rmSync(path.posix.join(liveDir, `${prefix}-${name}.${ext}`), { force: true });
    }
  }
}

// 4. Executor
await runExecutor({
  executor,
  liveDir,
  name,
  isFix,
  cardAbs,
  fixRoundN,
  recon,
  state,
  args,
  isGit,
  repoAbs,
  remainingMin,
  save,
  readOnlyPaths,
  normLiveDir,
  cardDirNorm
});

function scopeCheck() {
  state.after = snapshot(repoAbs, isGit);
  const allPaths = new Set([...Object.keys(state.before), ...Object.keys(state.after)]);
  const touched = [];
  for (const p of allPaths) {
    if (exemptPaths.has(p)) continue;
    const b = state.before[p];
    const a = state.after[p];
    if (!b || !a) {
      touched.push(p);
    } else if (b.st !== a.st || b.hash !== a.hash) {
      touched.push(p);
    }
  }
  touched.sort();
  state.touched = touched;

  const outOfScope = [];
  for (const p of touched) {
    const allowed = !recon && mayChange.some((entry) => entry.endsWith("/") ? p.startsWith(entry) : p === entry);
    if (!allowed) {
      outOfScope.push(p);
    }
  }
  state.outOfScope = outOfScope;

  const junk = outOfScope.filter(isJunkPath);
  state.junk = junk;

  return outOfScope;
}

// 5. Touched files
if (!state.outcome) {
  state.stage = "checking-files";
  save(state);

  const outOfScope = scopeCheck();

  const cardNowBytes = fs.readFileSync(cardAbs);
  const cardNowSha = crypto.createHash("sha256").update(cardNowBytes).digest("hex");
  state.cardModified = (cardNowSha !== cardSha);
  save(state);

  if (outOfScope.length > 0) {
    state.outcome = "out_of_scope";
    save(state);
  }
}

if (recon && !state.outcome) {
  state.outcome = "recon_done";
  save(state);
}

// 6. Check
if (!state.outcome) {
  state.stage = "checking";
  save(state);

  if (remainingMin() <= 0) {
    state.outcome = "interrupted";
    state.interruptedAt = "check";
    save(state);
  } else {
    const checkCmd = `{\n${check}\n} > ${q(checkLog)} 2>&1`;
    const checkRes = await runBash(checkCmd, { cwd: repoAbs, timeoutMin: Math.min(30, remainingMin()), exitPath: null });

    if (checkRes.timedOut) {
      state.outcome = "interrupted";
      state.checkResult = { exit: null, log: checkLog };
      save(state);
    } else {
      state.checkResult = { exit: checkRes.exit, log: checkLog };
      save(state);

      if (checkRes.exit !== 0) {
        state.outcome = "check_failed";
        save(state);
      }
    }

    const checkOutOfScope = scopeCheck();
    if (checkOutOfScope.length > 0 && state.outcome !== "readonly_violated") {
      state.outcome = "out_of_scope";
      save(state);
    }

    // Runs whatever the Check's outcome: a failing Check may still have written to read-only data.
    if (state.readOnlyBefore) {
      const roDiff = getReadOnlyDiff(state.readOnlyBefore, readOnlyPaths, { repoAbs, normLiveDir, cardDirNorm });
      if (roDiff) {
        state.outcome = "readonly_violated";
        state.readOnlyChanged = roDiff;
        save(state);
      }
    }
  }
}

// 7. Review
if (!state.outcome) {
  if (isFix) {
    state.outcome = "fix_passed";
    save(state);
  } else if (risk === "low") {
    state.outcome = "passed_no_review";
    save(state);
  } else {
    await runReview({
      args,
      executor,
      risk,
      state,
      save,
      isGit,
      cardAbs,
      liveDir,
      name,
      repoAbs,
      taskDir,
      remainingMin
    });
  }
}

// 8. Ledger + summary
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ledgerScript = path.resolve(__dirname, "../ledger.mjs");
try {
  const ledgerRes = spawnSync(process.execPath, [ledgerScript, name, "--json"], {
    encoding: "utf8",
    env: { ...process.env, ORCH_RUNNER_LIVE_DIR: liveDir }
  });
  if (ledgerRes.status === 0 && ledgerRes.stdout.trim()) {
    state.ledger = JSON.parse(ledgerRes.stdout.trim());
  } else {
    state.ledger = [];
  }
} catch {
  state.ledger = [];
}
// A fix runs no review: the review stream left from round 1 is not this round's cost.
if (isFix) state.ledger = state.ledger.filter((row) => row.role !== "review");
let fixDiffContent = "";
let fixDiffFile = null;
if (isFix) {
  const diffPathsSet = new Set(basePaths);
  for (const p of (state.touched || [])) {
    diffPathsSet.add(p);
  }
  const diffPaths = Array.from(diffPathsSet).sort();
  const diffPieces = [];
  const statKeys = new Set(Object.keys(state.fixBaseStats || {}));
  for (const p of diffPaths) {
    if (statKeys.has(p)) continue;
    const baseCopy = path.resolve(baseDir, p).replaceAll("\\", "/");
    const repoFile = path.resolve(repoAbs, p).replaceAll("\\", "/");
    const baseExists = fs.existsSync(baseCopy) && fs.statSync(baseCopy).isFile();
    const repoExists = fs.existsSync(repoFile) && fs.statSync(repoFile).isFile();
    if (!baseExists && !repoExists) continue;
    const arg1 = baseExists ? baseCopy : "/dev/null";
    const arg2 = repoExists ? repoFile : "/dev/null";
    const dRes = spawnSync("git", ["diff", "--no-index", "--", arg1, arg2], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024
    });
    if (dRes.stdout) {
      diffPieces.push(dRes.stdout);
    }
  }
  for (const p of Object.keys(state.fixBaseStats || {}).sort()) {
    const rec = state.fixBaseStats[p];
    const repoFile = path.resolve(repoAbs, p);
    const exists = fs.existsSync(repoFile) && fs.statSync(repoFile).isFile();
    const nowSize = exists ? fs.statSync(repoFile).size : null;
    const nowMtime = exists ? fs.statSync(repoFile).mtimeMs : null;
    if (!exists || nowSize !== rec.size || nowMtime !== rec.mtimeMs) {
      const before = rec.size ?? "-";
      const after = exists ? nowSize : "-";
      diffPieces.push(`# large or ignored file changed (not diffed): ${p} (size ${before} → ${after} bytes)\n`);
    }
  }
  fixDiffContent = diffPieces.join("");
  fixDiffFile = path.posix.join(stateDir, `${name}.fix${fixRoundN}.diff`);
  fs.writeFileSync(fixDiffFile, fixDiffContent, "utf8");

  state.rounds.push({
    round: `Fix ${fixRoundN}`,
    ledger: state.ledger,
    outcome: state.outcome,
    fresh: Boolean(args.fresh),
    touched: state.touched,
    seconds: state.exec?.seconds ?? null
  });
  state.fixes.push({
    n: fixRoundN,
    outcome: state.outcome
  });
  state.allTouched = Array.from(new Set(state.rounds.flatMap((r) => r.touched || []))).sort();
} else {
  state.allTouched = state.touched || [];
}

state.stage = "done";
save(state);

// 5. Acceptance draft
appendAcceptanceDraft({ state, cardAbs, check, risk });

// Print summary (<= ~45 lines, nothing else on stdout)
const lines = [];
lines.push(`ORCH-RUNNER ${name} outcome=${state.outcome} risk=${risk}`);

const execExit = state.exec?.exit !== null && state.exec?.exit !== undefined ? state.exec.exit : "n/a";
const execStatus = state.exec?.status ?? "n/a";
const execMins = state.exec?.seconds != null ? (state.exec.seconds / 60).toFixed(1) : "0.0";
lines.push(`executor: ${executor} exit=${execExit} status=${execStatus} ${execMins}m`);

const touchedStr = state.touched && state.touched.length > 0 ? state.touched.join(", ") : "-";
const nonJunkOutOfScope = (state.outOfScope || []).filter((p) => !isJunkPath(p));
const outOfScopeStr = nonJunkOutOfScope.length > 0 ? nonJunkOutOfScope.join(", ") : "-";
const junkStr = (state.junk && state.junk.length > 0) ? `   junk: ${state.junk.join(", ")}` : "";
const cardModStr = state.cardModified ? "yes" : "no";
lines.push(`touched: ${touchedStr}   out of scope: ${outOfScopeStr}${junkStr}   card modified: ${cardModStr}`);
if (state.readOnlyChanged && state.readOnlyChanged.length > 0) {
  lines.push(`read-only changed: ${state.readOnlyChanged.join(", ")}`);
}

const checkExit = state.checkResult?.exit !== null && state.checkResult?.exit !== undefined ? state.checkResult.exit : "skipped";
lines.push(`check: exit=${checkExit} \`${check}\``);
if (checkExit !== "skipped" && checkExit !== 0 && fs.existsSync(checkLog)) {
  const logLines = fs.readFileSync(checkLog, "utf8").split(/\r?\n/).filter(Boolean);
  const tail20 = logLines.slice(-20).join("\n");
  if (tail20) {
    lines.push(tail20);
  }
}

const reviewMdAbs = path.resolve(repoAbs, taskDir, "review.md").replaceAll("\\", "/");
if (state.review?.model) {
  let firstLine = "-";
  let restLines = [];
  if (fs.existsSync(reviewMdAbs)) {
    const revContent = fs.readFileSync(reviewMdAbs, "utf8");
    const revLines = revContent.split(/\r?\n/);
    firstLine = revLines[0]?.trim() || "-";
    restLines = revLines.slice(1, 13).filter((l) => l !== undefined);
  }
  const retriedSuffix = state.review?.retried ? " (retried)" : "";
  lines.push(`review: ${state.review.model} ${firstLine}${retriedSuffix}`);
  if (restLines.length > 0 && restLines.some((l) => l.trim())) {
    lines.push(restLines.join("\n"));
  }
} else {
  lines.push(`review: skipped -`);
}

if (isFix && fixDiffFile) {
  lines.push("fix diff:");
  const diffLines = fixDiffContent ? fixDiffContent.split(/\r?\n/) : [];
  if (diffLines.length > 0 && diffLines[diffLines.length - 1] === "") diffLines.pop();
  if (diffLines.length > 150) {
    lines.push(diffLines.slice(0, 150).join("\n"));
    lines.push(`(truncated, full diff: ${fixDiffFile})`);
  } else if (diffLines.length > 0) {
    lines.push(diffLines.join("\n"));
  } else {
    lines.push("-");
  }
} else if (!state.git) {
  lines.push("diff: n/a (not git)");
} else {
  const diffRes = spawnSync("git", ["-C", repoAbs, "diff", "--stat"], { encoding: "utf8" });
  let diffLast = "-";
  if (diffRes.stdout) {
    const dLines = diffRes.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (dLines.length > 0) {
      diffLast = dLines[dLines.length - 1].trim();
    }
  }
  lines.push(`diff: ${diffLast}`);
}

lines.push(`tokens:`);
lines.push(formatLedgerLines(state.ledger));

lines.push(`reply:`);
const replyLines = (state.exec?.reply ?? "").split(/\r?\n/);
const replyTail = replyLines.slice(-(recon ? 40 : 15)).join("\n");
lines.push(replyTail);

lines.push(`state: ${stateFile}`);

console.log(lines.join("\n"));
process.exit(0);
