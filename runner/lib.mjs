import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

export const q = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";

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
