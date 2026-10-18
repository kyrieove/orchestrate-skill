import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const q = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";

// wb = CodeBuddy CLI (WorkBuddy account) on DeepSeek v4.1 flash; replies end in a {"type":"result"} line.
export const WB_MODEL = "deepseek-v4.1-flash";
export const wbCmd = (prompt, extra = "", model = WB_MODEL) => `codebuddy -p ${q(prompt)} --model ${model} --effort high -y${extra}`;

// A read-only wb session (--reviewer wb): no write tools; the runner also checks that the repo did not change.
export const WB_READONLY = ` --output-format stream-json --tools "Read,Grep,Glob,Bash" --disallowedTools "Edit Write MultiEdit NotebookEdit"`;

// The reply of a stream-json run: the last {"type":"result"} line, or null.
export function wbReply(streamFile) {
  let text = "";
  try { text = fs.readFileSync(streamFile, "utf8"); } catch { return null; }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o.type === "result") return o.result ?? ""; } catch {}
  }
  return null;
}

// agy cards run on CodeBuddy too, on Gemini through magpie's gateway (the account magpie has signed in to Antigravity),
// so their quota is separate from the one agy.exe / the desktop app share. Needs the model exposed to CodeBuddy:
// `magpie "CodeBuddy Code" antigravity/gemini-3.8-flash`.
export const AGY_MODEL = "antigravity/gemini-3.8-flash";

// "on": agy cards run on wb; "off": always agy; anything else or missing = "auto":
// wb only while antigravity's quota is full, checked once at dispatch.
export const AGY_FALLBACK_FILE = process.env.ORCH_AGY_FALLBACK_FILE || "D:/2/dev/orch-runner/orchestrate/agy-fallback";
export function agyMode() {
  let mode = "auto";
  try { mode = fs.readFileSync(AGY_FALLBACK_FILE, "utf8").trim(); } catch {}
  return mode === "on" || mode === "off" ? mode : "auto";
}

// key: "codex" | "antigravity". Returns { five, week, full } or null when the script is missing or fails.
export function quotaOf(key) {
  const quotaScript = process.env.ORCH_QUOTA_SCRIPT || "D:/2/dev/token-weather-quotas/hooks/quota.mjs";
  if (!fs.existsSync(quotaScript)) return null;
  try {
    const res = spawnSync(process.execPath, [quotaScript], { encoding: "utf8", timeout: 45000 });
    if (res.status !== 0) return null;
    const quota = JSON.parse(res.stdout);
    const five = quota[key]?.five ?? null;
    const week = quota[key]?.week ?? null;
    return { five, week, full: (five !== null && five.pct >= 100) || (week !== null && week.pct >= 100) };
  } catch { return null; }
}

export function agyFallback() {
  const m = agyMode();
  return m === "on" || (m === "auto" && quotaOf("antigravity")?.full === true);
}

export function runBash(cmd, { cwd, timeoutMin, exitPath }) {
  const startTime = Date.now();
  const isWin = process.platform === "win32";
  // A script file, not `bash -c`: Git bash on Windows truncates a -c argument past ~8K chars
  // (a long review prompt then ends mid-quote and bash exits 2 before running anything).
  const script = path.join(os.tmpdir(), `orch-runbash-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(script, cmd, "utf8");
  const child = spawn("bash", [script], {
    cwd,
    // Bytecode (implicit, or the executor's py_compile syntax check) goes to temp, not __pycache__ next to read-only inputs.
    env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(os.tmpdir(), "orch-pycache") },
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
      fs.rmSync(script, { force: true });
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
      fs.rmSync(script, { force: true });
      const seconds = (Date.now() - startTime) / 1000;
      if (exitPath) {
        fs.writeFileSync(exitPath, "1\n", "utf8");
      }
      resolve({ timedOut: false, exit: 1, seconds, error: err });
    });
  });
}
