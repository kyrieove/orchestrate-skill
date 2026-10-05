import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { q, runBash } from "./lib.mjs";

const rawArgs = process.argv.slice(2);
const dashDashIdx = rawArgs.indexOf("--");
if (dashDashIdx === -1) {
  console.error("Missing '--'");
  process.exit(2);
}

const optArgs = rawArgs.slice(0, dashDashIdx);
const cmdParts = rawArgs.slice(dashDashIdx + 1);
if (cmdParts.length === 0) {
  console.error("No command specified after '--'");
  process.exit(2);
}
const command = cmdParts.length === 1 ? cmdParts[0] : cmdParts.map(q).join(" ");

let name = null;
let outDir = null;
let resume = false;
let timeoutMin = 110;

for (let i = 0; i < optArgs.length; i++) {
  const arg = optArgs[i];
  if (["--name", "--out", "--timeout-min"].includes(arg) && (i + 1 >= optArgs.length || optArgs[i + 1].startsWith("--"))) {
    console.error(`Missing value for ${arg}`);
    process.exit(2);
  }
  if (arg === "--resume") {
    resume = true;
  } else if (arg === "--name") {
    name = optArgs[++i];
  } else if (arg === "--out") {
    outDir = optArgs[++i];
  } else if (arg === "--timeout-min") {
    const val = optArgs[++i];
    timeoutMin = parseFloat(val);
    if (isNaN(timeoutMin) || timeoutMin <= 0) {
      console.error("Invalid --timeout-min value:", val);
      process.exit(2);
    }
  } else {
    console.error("Unknown argument:", arg);
    process.exit(2);
  }
}

if (!name || typeof name !== "string" || !outDir || typeof outDir !== "string") {
  console.error("Missing required argument --name or --out");
  process.exit(2);
}

if (!/^[\w.-]+$/.test(name)) {
  console.error("Invalid --name:", name);
  process.exit(2);
}

if (!resume) {
  if (fs.existsSync(outDir)) {
    console.error(`output dir exists: ${outDir} (never cleared or reused; pass --resume only if the script checks its saved run parameters)`);
    process.exit(2);
  }
} else {
  if (!fs.statSync(outDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`output dir does not exist or is not a directory: ${outDir}`);
    process.exit(2);
  }
}

const liveDir = (process.env.ORCH_RUNNER_LIVE_DIR || path.posix.join(os.homedir().replaceAll("\\", "/"), ".claude/agent-live"));
fs.mkdirSync(liveDir, { recursive: true });

const stream = path.posix.join(liveDir, `run-${name}.jsonl`);
const progressFile = path.posix.join(liveDir, `run-${name}.progress`);
const exitPath = path.posix.join(liveDir, `run-${name}.exit`);

if (!resume) {
  fs.rmSync(stream, { force: true });
  fs.rmSync(progressFile, { force: true });
}
fs.rmSync(exitPath, { force: true });

const redir = resume ? ">>" : ">";
const bashCmd = `{\n${command}\n} ${redir} ${q(stream)} 2>&1`;
const res = await runBash(bashCmd, { cwd: process.cwd(), timeoutMin, exitPath });

const exitStr = res.timedOut ? "interrupted" : String(res.exit ?? 1);
const minutes = (res.seconds / 60).toFixed(1);
console.log(`RUN-LONG ${name} exit=${exitStr} ${minutes}m`);

if (fs.existsSync(stream)) {
  // Only the end of the log: a long run's stream can be far larger than memory allows.
  const fd = fs.openSync(stream, "r");
  const size = fs.fstatSync(fd).size;
  const buf = Buffer.alloc(Math.min(size, 64 * 1024));
  fs.readSync(fd, buf, 0, buf.length, size - buf.length);
  fs.closeSync(fd);
  const lines = buf.toString("utf8").split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const tail20 = lines.slice(-20);
  if (tail20.length > 0) {
    console.log(tail20.join("\n"));
  }
}

process.exit(0);
