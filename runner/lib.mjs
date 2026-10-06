import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

export const q = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";

// wb = CodeBuddy CLI (WorkBuddy account) on DeepSeek v4.1 flash; replies end in a {"type":"result"} line.
export const WB_MODEL = "deepseek-v4.1-flash";
export const wbCmd = (prompt, extra = "") => `codebuddy -p ${q(prompt)} --model ${WB_MODEL} --effort high -y${extra}`;

// "on": codex's places (luna, sol, review) always go to wb; "off": always codex; anything else or missing = "auto":
// wb only while codex's quota is used up, checked at each call (dispatch and review separately).
export const CODEX_FALLBACK_FILE = process.env.ORCH_CODEX_FALLBACK_FILE || "C:/Users/ASUS/.claude/skills/orchestrate/codex-fallback";
export function codexMode() {
  let mode = "auto";
  try { mode = fs.readFileSync(CODEX_FALLBACK_FILE, "utf8").trim(); } catch {}
  return mode === "on" || mode === "off" ? mode : "auto";
}

// Returns { five, week, full } from the quota script, or null when it is missing or fails (never blocks codex).
export function codexQuota() {
  const quotaScript = process.env.ORCH_QUOTA_SCRIPT || "D:/2/dev/token-weather-quotas/hooks/quota.mjs";
  if (!fs.existsSync(quotaScript)) return null;
  try {
    const res = spawnSync(process.execPath, [quotaScript], { encoding: "utf8", timeout: 45000 });
    if (res.status !== 0) return null;
    const quota = JSON.parse(res.stdout);
    const five = quota.codex?.five ?? null;
    const week = quota.codex?.week ?? null;
    return { five, week, full: (five !== null && five.pct >= 100) || (week !== null && week.pct >= 100) };
  } catch { return null; }
}

export function codexFallback() {
  const mode = codexMode();
  return mode === "on" || (mode === "auto" && codexQuota()?.full === true);
}

export function runBash(cmd, { cwd, timeoutMin, exitPath }) {
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
