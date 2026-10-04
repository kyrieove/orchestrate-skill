import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const q = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
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

// 1. Args & Card Parsing
const rawArgs = process.argv.slice(2);
const args = parseArgs(rawArgs);

const card = args.card;
const name = args.name;
const executor = args.executor;
const risk = args.risk;
const repo = args.repo;
const timeoutMinArg = args["timeout-min"];

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

let timeoutMin = 100;
if (timeoutMinArg !== undefined) {
  timeoutMin = parseFloat(timeoutMinArg);
  if (isNaN(timeoutMin) || timeoutMin <= 0) {
    console.error("Invalid timeout-min:", timeoutMinArg);
    process.exit(2);
  }
}

const cardAbs = path.resolve(card).replaceAll("\\", "/");
if (!fs.existsSync(cardAbs)) {
  console.error("Card file does not exist:", cardAbs);
  process.exit(2);
}

const repoAbs = path.resolve(repo).replaceAll("\\", "/");
const gitCheck = spawnSync("git", ["-C", repoAbs, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
if (gitCheck.status !== 0 || gitCheck.stdout.trim() !== "true") {
  console.error("Repo is not inside git work tree:", repoAbs);
  process.exit(2);
}

const cardBytes = fs.readFileSync(cardAbs);
const cardText = cardBytes.toString("utf8");
const cardSha = crypto.createHash("sha256").update(cardBytes).digest("hex");

const checkSection = getSection(cardText, "Check");
if (checkSection === null) {
  console.error("No ## Check section found in card");
  process.exit(2);
}

let check = null;
const fencedMatch = checkSection.match(/```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/);
if (fencedMatch) {
  check = fencedMatch[1].trim();
} else {
  const inlineMatch = checkSection.match(/`([^`]+)`/);
  if (inlineMatch) {
    check = inlineMatch[1].trim();
  }
}

if (!check) {
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

// 2. State file
const liveDir = (process.env.ORCH_RUNNER_LIVE_DIR || path.posix.join(os.homedir().replaceAll("\\", "/"), ".claude/agent-live"));
const stateDir = path.posix.join(liveDir, "orch-runner");
fs.mkdirSync(stateDir, { recursive: true });

const stateFile = path.posix.join(stateDir, `${name}.json`);
const checkLog = path.posix.join(stateDir, `${name}.check.log`);

function save(st) {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), "utf8");
  fs.renameSync(tmp, stateFile);
}

const state = {
  name,
  card: cardAbs,
  cardSha,
  executor,
  risk,
  repo: repoAbs,
  check,
  mayChange,
  startedAt: new Date().toISOString(),
  stage: "executing",
  outcome: null,
  before: null,
  after: null,
  touched: null,
  outOfScope: null,
  exec: { exit: null, status: null, seconds: null, reply: null },
  checkResult: { exit: null, log: null },
  review: { model: null, verdict: null },
  ledger: null,
  cardModified: false
};
save(state);

// 3. Snapshot
function snapshot() {
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
    if (st.startsWith("R") || st.startsWith("C")) {
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

state.before = snapshot();
save(state);

for (const prefix of ["agy", "codex", "codex-review"]) {
  for (const ext of ["jsonl", "progress", "exit"]) {
    fs.rmSync(path.posix.join(liveDir, `${prefix}-${name}.${ext}`), { force: true });
  }
}

function runBash(cmd, { cwd, timeoutMin, exitPath }) {
  const startTime = Date.now();
  const isWin = process.platform === "win32";
  const child = spawn("bash", ["-c", cmd], {
    cwd,
    detached: !isWin,
    stdio: "ignore"
  });

  let timedOut = false;
  let timer = null;
  if (timeoutMin && timeoutMin > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      if (isWin) {
        spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    }, timeoutMin * 60 * 1000);
  }

  return new Promise((resolve) => {
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const seconds = (Date.now() - startTime) / 1000;
      if (timedOut) {
        if (exitPath) {
          fs.writeFileSync(exitPath, "interrupted\n", "utf8");
        }
        resolve({ timedOut: true, exit: null, seconds });
      } else {
        const exitCode = code !== null ? code : 1;
        if (exitPath) {
          fs.writeFileSync(exitPath, `${exitCode}\n`, "utf8");
        }
        resolve({ timedOut: false, exit: exitCode, seconds });
      }
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      const seconds = (Date.now() - startTime) / 1000;
      if (exitPath) {
        fs.writeFileSync(exitPath, "1\n", "utf8");
      }
      resolve({ timedOut: false, exit: 1, seconds, error: err });
    });
  });
}

// 4. Executor
const progressPrefix = (executor === "agy" || process.env.ORCH_RUNNER_FAKE_EXEC) ? "agy" : "codex";
const progressLine = `after starting, append \`0/N 已完成：无 · 正在：<第1步>\`, and after finishing each step append \`k/N 已完成：X · 正在：Y\` (Chinese; Y names the file / function and the action, 15–30 characters, e.g. \`2/5 已完成：读 README · 正在：在 README 的 Demo 前插入 Quota row 一节\`), as a new line, in UTF-8 (PowerShell: Add-Content -Encoding utf8), to ${liveDir}/${progressPrefix}-${name}.progress. Just append; do not open, list or inspect that directory or any other file to learn the format.`;
const execPrompt = `Read ${cardAbs} and carry out every step exactly; run only the commands the Steps name; do NOT run the Check — the runner runs it after you exit; do not commit. Reply: first line exactly STATUS: done, STATUS: blocked or STATUS: failed; then files changed and anything you could not do. ${progressLine}`;

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
  execCmd = `C:/Users/ASUS/AppData/Local/agy/bin/agy.exe -p ${q(execPrompt)} --model gemini-3.8-flash-high --dangerously-skip-permissions --output-format stream-json > ${q(S)} 2>&1`;
} else {
  const model = executor === "luna" ? "gpt-6-luna" : "gpt-6.1-sol";
  execCmd = `{ echo '{"model":"${model}"}'; codex exec --approve-for-me -m ${model} -C ${q(repoAbs)} --json ${q(execPrompt)} < /dev/null; } > ${q(S)} 2>&1`;
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
      if (lines.length > 0) {
        try {
          const lastObj = JSON.parse(lines[lines.length - 1]);
          if (lastObj.event === "result") {
            reply = lastObj.result?.response ?? (typeof lastObj.result === "string" ? lastObj.result : JSON.stringify(lastObj.result));
          }
        } catch {}
      }
    } else {
      const lines = content.trim().split(/\r?\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === "item.completed" && obj.item?.type === "agent_message") {
            reply = obj.item.text ?? "";
            break;
          } else if (obj.item?.type === "agent_message") {
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
    reply = nonEmpty.slice(-15).join("\n");
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
    const allowed = mayChange.some((entry) => entry.endsWith("/") ? p.startsWith(entry) : p === entry);
    if (!allowed) {
      outOfScope.push(p);
    }
  }
  outOfScope.sort();
  state.outOfScope = outOfScope;

  const cardNowBytes = fs.readFileSync(cardAbs);
  const cardNowSha = crypto.createHash("sha256").update(cardNowBytes).digest("hex");
  state.cardModified = (cardNowSha !== cardSha);
  save(state);

  if (outOfScope.length > 0) {
    state.outcome = "out_of_scope";
    save(state);
  }
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
}

// 7. Review
if (!state.outcome) {
  if (risk === "low") {
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

    const beforePathsList = Object.keys(state.before || {}).sort();
    const beforePathsStr = beforePathsList.length > 0 ? beforePathsList.join(", ") : "none";
    const reviewPrompt = `Review the working-tree changes against ${cardAbs}. Run git status and git diff (include untracked files the card creates); read only the diff, the card and the code the diff touches. Do not run tests or scripts (the Check was already run) and do not modify or create files. card.md and review.md under docs/orch/<task>/ are always allowed. These files already had uncommitted changes before this task: ${beforePathsStr}. Those earlier changes are not part of it, but review any further change this task made in them. Report only problems this diff introduces; list pre-existing problems in one line at the end, outside the verdict. No style or naming remarks. Reply: first line exactly VERDICT: PASS or VERDICT: FAIL, then at most 5 findings, most severe first, each with file:line, the problem and the fix — wrong behaviour, a Parameters value not matching the card, a bypassed check, steps not followed, files outside the card, copied code, junk files.`;

    const reviewStream = path.posix.join(liveDir, `codex-review-${name}.jsonl`);
    const reviewExit = path.posix.join(liveDir, `codex-review-${name}.exit`);
    const reviewMdAbs = path.resolve(repoAbs, taskDir, "review.md").replaceAll("\\", "/");
    fs.rmSync(reviewMdAbs, { force: true });

    let reviewCmd;
    if (process.env.ORCH_RUNNER_FAKE_REVIEW) {
      reviewCmd = `{\n${process.env.ORCH_RUNNER_FAKE_REVIEW}\n} > ${q(reviewStream)} 2>&1`;
    } else {
      reviewCmd = `{ echo '{"model":"${reviewer}"}'; codex exec -s read-only -m ${reviewer} -c model_reasoning_effort=medium -C ${q(repoAbs)} -o ${q(reviewMdAbs)} --json ${q(reviewPrompt)} < /dev/null; } > ${q(reviewStream)} 2>&1`;
    }

    const reviewRes = await runBash(reviewCmd, { cwd: repoAbs, timeoutMin, exitPath: reviewExit });

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
  const ledgerRes = spawnSync(process.execPath, [ledgerScript, name], { encoding: "utf8" });
  if (ledgerRes.status === 0 && ledgerRes.stdout.trim()) {
    state.ledger = ledgerRes.stdout.trim();
  } else {
    state.ledger = "n/a";
  }
} catch {
  state.ledger = "n/a";
}

state.stage = "done";
save(state);

// Print summary (<= ~45 lines, nothing else on stdout)
const lines = [];
lines.push(`ORCH-RUNNER ${name} outcome=${state.outcome} risk=${risk}`);

const execExit = state.exec?.exit !== null && state.exec?.exit !== undefined ? state.exec.exit : "n/a";
const execStatus = state.exec?.status ?? "n/a";
const execMins = state.exec?.seconds != null ? (state.exec.seconds / 60).toFixed(1) : "0.0";
lines.push(`executor: ${executor} exit=${execExit} status=${execStatus} ${execMins}m`);

const touchedStr = state.touched && state.touched.length > 0 ? state.touched.join(", ") : "-";
const outOfScopeStr = state.outOfScope && state.outOfScope.length > 0 ? state.outOfScope.join(", ") : "-";
const cardModStr = state.cardModified ? "yes" : "no";
lines.push(`touched: ${touchedStr}   out of scope: ${outOfScopeStr}   card modified: ${cardModStr}`);

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
  lines.push(`review: ${state.review.model} ${firstLine}`);
  if (restLines.length > 0 && restLines.some((l) => l.trim())) {
    lines.push(restLines.join("\n"));
  }
} else {
  lines.push(`review: skipped -`);
}

const diffRes = spawnSync("git", ["-C", repoAbs, "diff", "--stat"], { encoding: "utf8" });
let diffLast = "-";
if (diffRes.stdout) {
  const dLines = diffRes.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (dLines.length > 0) {
    diffLast = dLines[dLines.length - 1].trim();
  }
}
lines.push(`diff: ${diffLast}`);

lines.push(`tokens:`);
lines.push(state.ledger ?? "n/a");

lines.push(`reply:`);
const replyLines = (state.exec?.reply ?? "").split(/\r?\n/);
const replyTail = replyLines.slice(-15).join("\n");
lines.push(replyTail);

lines.push(`state: ${stateFile}`);

console.log(lines.join("\n"));
process.exit(0);







