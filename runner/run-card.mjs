import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { q, runBash } from "./lib.mjs";

function parseArgs(args) {
  const booleanFlags = new Set(["recon", "commit", "fresh"]);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (booleanFlags.has(key)) {
        parsed[key] = true;
        continue;
      }
      const val = args[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        parsed[key] = val;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }
  return parsed;
}

function getSection(text, title) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  const sectionLines = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (inSection) break;
      const secTitle = line.replace(/^##\s+/, "").trim().split(/\s+/)[0];
      if (secTitle.toLowerCase() === title.toLowerCase()) {
        inSection = true;
        continue;
      }
    }
    if (inSection) {
      sectionLines.push(line);
    }
  }
  return inSection ? sectionLines.join("\n") : null;
}

function lintCard(cardText) {
  const problems = [];
  const requiredSections = ["Goal", "Risk", "Files", "Steps", "Don't"];
  if (!recon) {
    requiredSections.push("Check");
  }
  for (const sec of requiredSections) {
    if (getSection(cardText, sec) === null) {
      problems.push(`missing ## ${sec} section`);
    }
  }

  const riskSection = getSection(cardText, "Risk");
  if (riskSection !== null) {
    const firstWord = riskSection.trim().split(/\s+/)[0]?.toLowerCase();
    if (firstWord !== (risk ?? "").toLowerCase()) {
      problems.push(`Risk '${firstWord}' does not match --risk '${risk}'`);
    }
  }

  const stepsLine = cardText.split(/\r?\n/).find((l) => /^##\s+Steps\b/i.test(l)) || "";
  const stepsSection = getSection(cardText, "Steps") || "";
  if (!/N\s*=\s*\d+/.test(stepsLine) && !/N\s*=\s*\d+/.test(stepsSection)) {
    problems.push("Steps section heading or body must match /N\\s*=\\s*\\d+/");
  }

  const dontSection = getSection(cardText, "Don't");
  if (dontSection !== null) {
    const requiredDontPhrases = [
      "Run scripts in the foreground and wait",
      "Reuse existing functions",
      "No rm, no git push"
    ];
    for (const phrase of requiredDontPhrases) {
      if (!dontSection.includes(phrase)) {
        problems.push(`Don't section missing phrase: "${phrase}"`);
      }
    }
  }

  if (!recon) {
    const filesSection = getSection(cardText, "Files") || "";
    const roIdx = filesSection.search(/read-only/i);
    const beforeRo = roIdx >= 0 ? filesSection.slice(0, roIdx) : filesSection;
    if (!/`[^`]+`/.test(beforeRo)) {
      problems.push("Files section before read-only must have at least one backticked path");
    }

    const checkSection = getSection(cardText, "Check") || "";
    const hasFenced = /```[\s\S]*?```/.test(checkSection);
    const hasInline = /`[^`]+`/.test(checkSection);
    if (!hasFenced && !hasInline) {
      problems.push("Check section must have a fenced block or backticked span");
    }
  }

  return problems;
}

function isJunkPath(repoRelPath) {
  const norm = repoRelPath.replaceAll("\\", "/");
  const segments = norm.split("/");
  if (segments.includes("__pycache__")) return true;
  const base = path.posix.basename(norm);
  if (base.endsWith(".log")) return true;
  if (base.startsWith("tmp")) return true;
  return false;
}

// 1. Args & Card Parsing
const rawArgs = process.argv.slice(2);
const args = parseArgs(rawArgs);

const liveDir = (process.env.ORCH_RUNNER_LIVE_DIR || path.posix.join(os.homedir().replaceAll("\\", "/"), ".claude/agent-live"));
const normLiveDir = path.resolve(liveDir).replaceAll("\\", "/");
const stateDir = path.posix.join(liveDir, "orch-runner");
fs.mkdirSync(stateDir, { recursive: true });

if (args.commit) {
  const name = args.name;
  const message = args.message;
  if (typeof name !== "string" || !/^[\w.-]+$/.test(name)) {
    console.error("Argument --name required for commit (letters, digits, _ . - only)");
    process.exit(2);
  }
  if (!message || typeof message !== "string") {
    console.error("Argument --message required for commit");
    process.exit(2);
  }
  const stateFile = path.posix.join(stateDir, `${name}.json`);
  if (!fs.existsSync(stateFile)) {
    console.error("No state file found:", stateFile);
    process.exit(2);
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (err) {
    console.error("Failed to parse state file:", err);
    process.exit(2);
  }
  if (state.git === false) {
    console.error("not a git repository; nothing to commit");
    process.exit(2);
  }
  const repoAbs = state.repo;
  const cardAbs = state.card;
  if (!cardAbs || !fs.existsSync(cardAbs)) {
    console.error("Card file not found:", cardAbs);
    process.exit(2);
  }
  const cardText = fs.readFileSync(cardAbs, "utf8");

  if (/^##\s+Acceptance\s+\(draft\)\s*$/im.test(cardText)) {
    console.error("Card still contains ## Acceptance (draft)");
    process.exit(2);
  }

  const acceptanceSection = getSection(cardText, "Acceptance");
  if (acceptanceSection === null) {
    console.error("There is no ## Acceptance section in card");
    process.exit(2);
  }
  if (/\bTODO\b/.test(acceptanceSection)) {
    console.error("TODO found in ## Acceptance section");
    process.exit(2);
  }

  const allTouched = state.allTouched || (state.rounds ? state.rounds.flatMap((r) => r.touched || []) : state.touched) || [];
  const mayChange = state.mayChange || [];
  const inScope = [...new Set(allTouched)].filter((p) =>
    mayChange.some((entry) => entry.endsWith("/") ? p.startsWith(entry) : p === entry)
  );
  // A file created in one round and removed in a later one was never tracked: git add would fail on it.
  const tracked = new Set(spawnSync("git", ["-C", repoAbs, "ls-files", "-z", "--", ...inScope], { encoding: "utf8" }).stdout.split("\0"));
  const stagedTouched = inScope.filter((p) => tracked.has(p) || fs.existsSync(path.resolve(repoAbs, p)));

  const cardDirNorm = path.resolve(path.dirname(cardAbs)).replaceAll("\\", "/");
  let taskDir = path.posix.relative(repoAbs, cardDirNorm);
  if (taskDir === "") taskDir = ".";
  const cardRel = taskDir === "." ? "card.md" : `${taskDir}/card.md`;
  const reviewRel = taskDir === "." ? "review.md" : `${taskDir}/review.md`;

  const filesToStage = new Set(stagedTouched);
  filesToStage.add(cardRel);
  if (fs.existsSync(path.resolve(repoAbs, reviewRel))) {
    filesToStage.add(reviewRel);
  }

  const reviewLogRel = "docs/review-log.md";
  const reviewLogAbs = path.resolve(repoAbs, reviewLogRel);
  if (fs.existsSync(reviewLogAbs)) {
    const yyyymmdd = new Date().toISOString().slice(0, 10);
    const goalSec = getSection(cardText, "Goal") || "";
    const goalFirstLine = goalSec.trim().split(/\r?\n/)[0]?.trim() || "";
    const logLine = `- ${yyyymmdd} ${state.name}: ${goalFirstLine} (${cardRel})\n`;
    fs.appendFileSync(reviewLogAbs, logLine, "utf8");
    filesToStage.add(reviewLogRel);
  }

  const fileList = Array.from(filesToStage).sort();
  const addRes = spawnSync("git", ["-C", repoAbs, "add", "--", ...fileList], { encoding: "utf8" });
  if (addRes.status !== 0) {
    console.error("git add failed:", addRes.stderr);
    process.exit(1);
  }
  const commitRes = spawnSync("git", ["-C", repoAbs, "commit", "-m", message, "--", ...fileList], { encoding: "utf8" });
  if (commitRes.status !== 0) {
    console.error("git commit failed:", commitRes.stderr);
    process.exit(1);
  }
  const revRes = spawnSync("git", ["-C", repoAbs, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  if (revRes.status !== 0) {
    console.error("git rev-parse failed:", revRes.stderr);
    process.exit(1);
  }
  const shortHead = revRes.stdout.trim();
  console.log(shortHead);
  state.commit = shortHead;
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, stateFile);
  process.exit(0);
}

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
  for (const req of ["card", "name", "repo"]) {
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

  if (executor !== undefined) {
    if (executor !== existingState.executor) {
      console.error(`--executor '${executor}' does not match state '${existingState.executor}'`);
      process.exit(2);
    }
  } else {
    executor = existingState.executor;
  }

  if (risk !== undefined) {
    if (risk !== existingState.risk) {
      console.error(`--risk '${risk}' does not match state '${existingState.risk}'`);
      process.exit(2);
    }
  } else {
    risk = existingState.risk;
  }

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

  if (!["agy", "luna", "sol"].includes(executor)) {
    console.error("Invalid executor:", executor);
    process.exit(2);
  }

  if (!["low", "medium", "high"].includes(risk)) {
    console.error("Invalid risk:", risk);
    process.exit(2);
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
  const lintProblems = lintCard(cardText);
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
    state.rounds.push({ round: "1", ledger: state.ledger, touched: state.touched });
  }
  if (!state.fixes) state.fixes = [];
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
  const basePathsSet = new Set();
  for (const p of mayChange) {
    const absP = path.resolve(repoAbs, p);
    if (fs.existsSync(absP) && fs.statSync(absP).isFile()) {
      basePathsSet.add(p);
    }
  }
  for (const p of (state.touched || [])) {
    basePathsSet.add(p);
  }
  basePaths = Array.from(basePathsSet).sort();
  for (const p of basePaths) {
    const src = path.resolve(repoAbs, p);
    const dest = path.resolve(baseDir, p);
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
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
function snapshot() {
  if (!isGit) {
    const result = {};
    function walk(dir) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const fullPath = path.posix.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile()) {
            const st = fs.statSync(fullPath);
            const rel = path.posix.relative(repoAbs, fullPath).replaceAll("\\", "/");
            result[rel] = {
              st: "",
              hash: `${st.size}:${st.mtimeMs}`
            };
          }
        } catch {}
      }
    }
    walk(repoAbs);
    return result;
  }

  const res = spawnSync("git", ["-C", repoAbs, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024
  });
  if (res.status !== 0) {
    throw new Error(`git status failed: ${res.stderr}`);
  }
  const parts = res.stdout.split("\0");
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const st = part.slice(0, 2);
    const p = part.slice(3).replaceAll("\\", "/");
    entries.push({ st, path: p });
    if (/[RC]/.test(st)) {
      i++;
    }
  }
  const existing = [];
  for (const entry of entries) {
    const absP = path.resolve(repoAbs, entry.path);
    try {
      if (fs.existsSync(absP) && fs.statSync(absP).isFile()) {
        existing.push(entry.path);
      }
    } catch {}
  }
  const hashes = new Map();
  if (existing.length > 0) {
    const hashRes = spawnSync("git", ["-C", repoAbs, "hash-object", "--", ...existing], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024
    });
    if (hashRes.status !== 0) {
      throw new Error(`git hash-object failed: ${hashRes.stderr}`);
    }
    const lines = hashRes.stdout.trim().split(/\r?\n/);
    for (let j = 0; j < existing.length; j++) {
      hashes.set(existing[j], lines[j]);
    }
  }
  const result = {};
  for (const entry of entries) {
    result[entry.path] = {
      st: entry.st,
      hash: hashes.get(entry.path) ?? null
    };
  }
  return result;
}

function statTree(paths) {
  const result = {};

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const fullPath = path.posix.join(dir, entry.name);
      // A listed ancestor must not pull in what the runner and executor write themselves.
      if (fullPath === normLiveDir || fullPath === cardDirNorm) continue;
      try {
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const st = fs.statSync(fullPath);
          result[fullPath] = [st.size, st.mtimeMs];
        }
      } catch {}
    }
  }

  for (const p of paths) {
    const absP = path.resolve(p).replaceAll("\\", "/");
    if (!fs.existsSync(absP)) continue;
    try {
      const st = fs.statSync(absP);
      if (st.isDirectory()) {
        walk(absP);
      } else if (st.isFile()) {
        result[absP] = [st.size, st.mtimeMs];
      }
    } catch {}
  }

  return result;
}

function getReadOnlyDiff(beforeStats, paths) {
  const currentStats = statTree(paths);
  const beforeKeys = Object.keys(beforeStats || {});
  const currentKeys = Object.keys(currentStats || {});
  const allKeys = new Set([...beforeKeys, ...currentKeys]);
  const diffs = [];

  for (const k of allKeys) {
    const b = beforeStats ? beforeStats[k] : undefined;
    const c = currentStats ? currentStats[k] : undefined;
    if (!b || !c) {
      diffs.push(k);
    } else if (b[0] !== c[0] || b[1] !== c[1]) {
      diffs.push(k);
    }
  }

  if (diffs.length === 0) return null;

  const repoPrefix = repoAbs.endsWith("/") ? repoAbs : repoAbs + "/";
  const formatted = diffs.map((absP) => {
    if (absP === repoAbs) return ".";
    if (absP.startsWith(repoPrefix)) {
      return path.posix.relative(repoAbs, absP);
    }
    return absP;
  });
  formatted.sort();
  return formatted;
}

state.before = snapshot();
state.readOnlyBefore = statTree(readOnlyPaths);
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
const progressPrefix = (executor === "agy" || process.env.ORCH_RUNNER_FAKE_EXEC) ? "agy" : "codex";
const progressLine = `after starting, append \`0/N 已完成：无 · 正在：<第1步>\`, and after finishing each step append \`k/N 已完成：X · 正在：Y\` (Chinese; Y names the file / function and the action, 15–30 characters, e.g. \`2/5 已完成：读 README · 正在：在 README 的 Demo 前插入 Quota row 一节\`), as a new line, in UTF-8 (PowerShell: Add-Content -Encoding utf8), to ${liveDir}/${progressPrefix}-${name}.progress. Just append; do not open, list or inspect that directory or any other file to learn the format.`;
let execPrompt;
if (isFix) {
  execPrompt = `Read ${cardAbs} and carry out ## Fix ${fixRoundN} exactly; run only the commands it names; do NOT run the Check — the runner runs it after you exit; do not commit. Reply: first line exactly STATUS: done, STATUS: blocked or STATUS: failed; then files changed and anything you could not do. Before replying, run a syntax-only check on every file you changed (e.g. node --check <file>, python -m py_compile <file>); this is not the Check. ${progressLine}`;
} else if (recon) {
  execPrompt = `Read ${cardAbs} and answer what it asks. This is read-only: do not create, modify or delete any file; do not commit. Reply: first line exactly STATUS: done, STATUS: blocked or STATUS: failed; then the answer. ${progressLine}`;
} else {
  execPrompt = `Read ${cardAbs} and carry out every step exactly; run only the commands the Steps name; do NOT run the Check — the runner runs it after you exit; do not commit. Reply: first line exactly STATUS: done, STATUS: blocked or STATUS: failed; then files changed and anything you could not do. Before replying, run a syntax-only check on every file you changed (e.g. node --check <file>, python -m py_compile <file>); this is not the Check. ${progressLine}`;
}

let S;
if (process.env.ORCH_RUNNER_FAKE_EXEC || executor === "agy") {
  S = path.posix.join(liveDir, `agy-${name}.jsonl`);
} else {
  S = path.posix.join(liveDir, `codex-${name}.jsonl`);
}
const E = S.replace(/\.jsonl$/, ".exit");

let execCmd;
if (process.env.ORCH_RUNNER_FAKE_EXEC) {
  execCmd = `{\n${process.env.ORCH_RUNNER_FAKE_EXEC}\n} > ${q(S)} 2>&1`;
} else if (executor === "agy") {
  const convArg = (state.conversationId && !args.fresh) ? ` --conversation ${state.conversationId}` : "";
  execCmd = `C:/Users/ASUS/AppData/Local/agy/bin/agy.exe -p ${q(execPrompt)} --model gemini-3.8-flash-high --dangerously-skip-permissions --output-format stream-json${convArg} > ${q(S)} 2>&1`;
} else {
  const model = executor === "luna" ? "gpt-6-luna" : "gpt-6.1-sol";
  execCmd = `{ echo '{"model":"${model}"}'; codex exec --approve-for-me${isGit ? "" : " --skip-git-repo-check"} -m ${model} -C ${q(repoAbs)} --json ${q(execPrompt)} < /dev/null; } > ${q(S)} 2>&1`;
}

const execResult = await runBash(execCmd, { cwd: repoAbs, timeoutMin, exitPath: E });

if (execResult.timedOut) {
  state.outcome = "interrupted";
  state.exec = { exit: null, status: "interrupted", seconds: execResult.seconds, reply: "" };
  save(state);
} else {
  let reply = null;
  if (!process.env.ORCH_RUNNER_FAKE_EXEC && fs.existsSync(S)) {
    const content = fs.readFileSync(S, "utf8");
    if (executor === "agy") {
      const lines = content.trim().split(/\r?\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.event === "result") {
            reply = obj.result?.response ?? (typeof obj.result === "string" ? obj.result : JSON.stringify(obj.result));
            state.conversationId = obj.result?.conversation_id ?? null;
            break;
          }
        } catch {}
      }
    } else {
      const lines = content.trim().split(/\r?\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.item?.type === "agent_message") {
            reply = obj.item.text ?? "";
            break;
          }
        } catch {}
      }
    }
  }

  if (reply === null || reply === undefined) {
    const content = fs.existsSync(S) ? fs.readFileSync(S, "utf8") : "";
    const nonEmpty = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    reply = nonEmpty.slice(-(recon ? 40 : 15)).join("\n");
  }

  const statusMatch = reply.match(/^STATUS:\s*(done|blocked|failed)\b/m);
  const status = statusMatch ? statusMatch[1] : "missing";

  state.exec = {
    exit: execResult.exit,
    status,
    seconds: execResult.seconds,
    reply
  };
  save(state);

  if (execResult.exit !== 0 || status === "failed") {
    state.outcome = "failed";
    save(state);
  } else if (status === "blocked") {
    state.outcome = "blocked";
    save(state);
  }
}

if (!state.outcome && state.readOnlyBefore) {
  const roDiff = getReadOnlyDiff(state.readOnlyBefore, readOnlyPaths);
  if (roDiff) {
    state.outcome = "readonly_violated";
    state.readOnlyChanged = roDiff;
    save(state);
  }
}

// 5. Touched files
if (!state.outcome) {
  state.stage = "checking-files";
  save(state);

  state.after = snapshot();
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
  outOfScope.sort();
  state.outOfScope = outOfScope;

  const junk = outOfScope.filter(isJunkPath);
  junk.sort();
  state.junk = junk;

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

  const checkCmd = `{\n${check}\n} > ${q(checkLog)} 2>&1`;
  const checkRes = await runBash(checkCmd, { cwd: repoAbs, timeoutMin: 30, exitPath: null });

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

  // Runs whatever the Check's outcome: a failing Check may still have written to read-only data.
  if (state.readOnlyBefore) {
    const roDiff = getReadOnlyDiff(state.readOnlyBefore, readOnlyPaths);
    if (roDiff) {
      state.outcome = "readonly_violated";
      state.readOnlyChanged = roDiff;
      save(state);
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
    state.stage = "reviewing";
    let reviewer;
    if (executor === "luna" || executor === "sol") {
      reviewer = "gpt-6.1-sol";
    } else if (risk === "high") {
      reviewer = "gpt-6.1-sol";
    } else {
      reviewer = "gpt-6-luna";
    }

    state.review = { model: reviewer, verdict: null };
    save(state);

    let reviewPrompt;
    if (isGit) {
      const beforePathsList = Object.keys(state.before || {}).sort();
      const beforePathsStr = beforePathsList.length > 0 ? beforePathsList.join(", ") : "none";
      reviewPrompt = `Review the working-tree changes against ${cardAbs}. Run git status and git diff (include untracked files the card creates); read only the diff, the card and the code the diff touches. Do not run tests or scripts (the Check was already run) and do not modify or create files. card.md and review.md under docs/orch/<task>/ are always allowed. These files already had uncommitted changes before this task: ${beforePathsStr}. Those earlier changes are not part of it, but review any further change this task made in them. Report only problems this diff introduces; list pre-existing problems in one line at the end, outside the verdict. No style or naming remarks. Reply: first line exactly VERDICT: PASS or VERDICT: FAIL, then at most 5 findings, most severe first, each with file:line, the problem and the fix — wrong behaviour, a Parameters value not matching the card, a bypassed check, steps not followed, files outside the card, copied code, junk files.`;
    } else {
      const touchedList = (state.touched || []).join(", ");
      reviewPrompt = `Review the changes against ${cardAbs}. This folder is not a git repository; the task changed exactly these files: ${touchedList}. Read only those files and the card. Do not run tests or scripts (the Check was already run) and do not modify or create files. card.md and review.md under docs/orch/<task>/ are always allowed. Report only problems this diff introduces; list pre-existing problems in one line at the end, outside the verdict. No style or naming remarks. Reply: first line exactly VERDICT: PASS or VERDICT: FAIL, then at most 5 findings, most severe first, each with file:line, the problem and the fix — wrong behaviour, a Parameters value not matching the card, a bypassed check, steps not followed, files outside the card, copied code, junk files.`;
    }

    const reviewStream = path.posix.join(liveDir, `codex-review-${name}.jsonl`);
    const reviewExit = path.posix.join(liveDir, `codex-review-${name}.exit`);
    const reviewMdAbs = path.resolve(repoAbs, taskDir, "review.md").replaceAll("\\", "/");
    fs.rmSync(reviewMdAbs, { force: true });

    const skipGitFlag = isGit ? "" : " --skip-git-repo-check";
    let reviewCmd;
    if (process.env.ORCH_RUNNER_FAKE_REVIEW) {
      reviewCmd = `{\n${process.env.ORCH_RUNNER_FAKE_REVIEW}\n} > ${q(reviewStream)} 2>&1`;
    } else {
      reviewCmd = `{ echo '{"model":"${reviewer}"}'; codex exec${skipGitFlag} -s read-only -m ${reviewer} -c model_reasoning_effort=medium -C ${q(repoAbs)} -o ${q(reviewMdAbs)} --json ${q(reviewPrompt)} < /dev/null; } > ${q(reviewStream)} 2>&1`;
    }

    let reviewRes = await runBash(reviewCmd, { cwd: repoAbs, timeoutMin, exitPath: reviewExit });

    if (!reviewRes.timedOut && reviewRes.exit === 0) {
      let firstLine = "";
      if (fs.existsSync(reviewMdAbs)) {
        const content = fs.readFileSync(reviewMdAbs, "utf8");
        const lines = content.split(/\r?\n/);
        firstLine = lines[0]?.trim() ?? "";
      }

      if (firstLine !== "VERDICT: PASS" && firstLine !== "VERDICT: FAIL") {
        fs.rmSync(reviewMdAbs, { force: true });
        let retryCmd;
        if (process.env.ORCH_RUNNER_FAKE_REVIEW) {
          retryCmd = `{\n${process.env.ORCH_RUNNER_FAKE_REVIEW}\n} >> ${q(reviewStream)} 2>&1`;
        } else {
          retryCmd = `{ echo '{"model":"${reviewer}"}'; codex exec${skipGitFlag} -s read-only -m ${reviewer} -c model_reasoning_effort=medium -C ${q(repoAbs)} -o ${q(reviewMdAbs)} --json ${q(reviewPrompt)} < /dev/null; } >> ${q(reviewStream)} 2>&1`;
        }
        state.review.retried = true;
        reviewRes = await runBash(retryCmd, { cwd: repoAbs, timeoutMin, exitPath: reviewExit });
      }
    }

    if (reviewRes.timedOut) {
      state.outcome = "interrupted";
      save(state);
    } else if (reviewRes.exit !== 0) {
      state.outcome = "review_error";
      state.review.verdict = "error";
      save(state);
    } else {
      let firstLine = "";
      if (fs.existsSync(reviewMdAbs)) {
        const content = fs.readFileSync(reviewMdAbs, "utf8");
        const lines = content.split(/\r?\n/);
        firstLine = lines[0]?.trim() ?? "";
      }

      if (firstLine === "VERDICT: PASS") {
        state.outcome = "review_pass";
        state.review.verdict = "PASS";
      } else if (firstLine === "VERDICT: FAIL") {
        state.outcome = "review_fail";
        state.review.verdict = "FAIL";
      } else {
        state.outcome = "review_error";
        state.review.verdict = firstLine || "error";
      }
      save(state);
    }
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
  for (const p of diffPaths) {
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
  fixDiffContent = diffPieces.join("");
  fixDiffFile = path.posix.join(stateDir, `${name}.fix${fixRoundN}.diff`);
  fs.writeFileSync(fixDiffFile, fixDiffContent, "utf8");

  state.rounds.push({
    round: `Fix ${fixRoundN}`,
    ledger: state.ledger,
    outcome: state.outcome,
    fresh: Boolean(args.fresh),
    touched: state.touched
  });
  state.fixes.push({
    n: fixRoundN,
    outcome: state.outcome
  });
  state.allTouched = Array.from(new Set(state.rounds.flatMap((r) => r.touched || []))).sort();
} else {
  state.allTouched = state.touched || [];
}

const k = (n) => `${Math.round(n / 1000)}k`;
function formatLedgerLines(ledger, sep = "\n") {
  if (!Array.isArray(ledger) || ledger.length === 0) return "n/a";
  return ledger
    .map((item) => `${item.role} ${item.model}: fresh ${k(item.fresh)}, cached ${k(item.cached)}, out ${k(item.out)}  (${item.file})`)
    .join(sep);
}

state.stage = "done";
save(state);

// 5. Acceptance draft
const draftOutcomes = new Set(["review_pass", "passed_no_review", "fix_passed", "recon_done"]);
if (draftOutcomes.has(state.outcome)) {
  const currentCardText = fs.readFileSync(cardAbs, "utf8");
  const cLines = currentCardText.split(/\r?\n/);
  const keptLines = [];
  let inDraft = false;
  for (const line of cLines) {
    if (/^##\s+Acceptance\s+\(draft\)\s*$/i.test(line.trim())) {
      inDraft = true;
      continue;
    }
    if (inDraft) {
      if (/^##\s+/.test(line)) {
        inDraft = false;
        keptLines.push(line);
      }
      continue;
    }
    keptLines.push(line);
  }
  const cleanCardText = keptLines.join("\n").trimEnd();

  const allTouched = state.allTouched || (state.rounds ? state.rounds.flatMap((r) => r.touched || []) : state.touched) || [];
  const allTouchedList = allTouched.length > 0 ? allTouched.join(", ") : "-";
  const checkExitVal = state.checkResult?.exit !== null && state.checkResult?.exit !== undefined ? state.checkResult.exit : 0;
  const checkLine = check ? `- check: \`${check}\` → exit ${checkExitVal} (run by run-card)` : "- check: -";

  const tokenLines = [];
  if (state.rounds && state.rounds.length > 0) {
    for (const r of state.rounds) {
      const roundLabel = (r.round === "1" || r.round === "round 1") ? "round 1" : r.round;
      tokenLines.push(`  - ${roundLabel}: ${formatLedgerLines(r.ledger, " · ")}`);
    }
  } else {
    tokenLines.push(`  - round 1: ${formatLedgerLines(state.ledger, " · ")}`);
  }

  const reviewerStr = state.review?.model || "no review";
  const draftSection = [
    "## Acceptance (draft)",
    "- verdict: TODO (accepted / review pending / rejected)",
    `- files: ${allTouchedList}`,
    checkLine,
    "- tokens:",
    ...tokenLines,
    `- review findings: TODO N real / M false positive / K missed (${risk}, ${reviewerStr})`
  ].join("\n");

  fs.writeFileSync(cardAbs, `${cleanCardText}\n\n${draftSection}\n`, "utf8");
}

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







