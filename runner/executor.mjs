import fs from "node:fs";
import path from "node:path";
import { q, runBash, wbCmd, WB_MODEL, agyFallback } from "./lib.mjs";
import { getReadOnlyDiff } from "./snapshot.mjs";

export async function runExecutor(ctx) {
  const {
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
  } = ctx;

  const progressPrefix = (executor === "agy" || process.env.ORCH_RUNNER_FAKE_EXEC) ? "agy" : "codex";
  const progressLine = `after starting, append \`0/N 已完成：无 · 正在：<第1步>\`, and after finishing each step append \`k/N 已完成：X · 正在：Y\` (Chinese; Y names the file / function and the action, 15–30 characters, e.g. \`2/5 已完成：读 README · 正在：在 README 的 Demo 前插入 Quota row 一节\`), as a new line, in UTF-8 (PowerShell: Add-Content -Encoding utf8), to ${liveDir}/${progressPrefix}-${name}.progress. Just append; do not open, list or inspect that directory or any other file to learn the format.`;
  const lean = "Write the least code that does the step: reuse what the repo already has, then the stdlib; no new abstractions, options or files the card does not ask for. Keep the reply to the STATUS line, the files changed and what you could not do.";
  let execPrompt;
  if (isFix) {
    execPrompt = `Read ${cardAbs} and carry out ## Fix ${fixRoundN} exactly; run only the commands it names; do NOT run the Check — the runner runs it after you exit; do not commit. Reply: first line exactly STATUS: done, STATUS: blocked or STATUS: failed; then files changed and anything you could not do. Before replying, run a syntax-only check on every file you changed (e.g. node --check <file>, python -m py_compile <file>); this is not the Check. ${lean} ${progressLine}`;
  } else if (recon) {
    execPrompt = `Read ${cardAbs} and answer what it asks. This is read-only: do not create, modify or delete any file; do not commit. Reply: first line exactly STATUS: done, STATUS: blocked or STATUS: failed; then the answer. ${progressLine}`;
  } else {
    execPrompt = `Read ${cardAbs} and carry out every step exactly; run only the commands the Steps name; do NOT run the Check — the runner runs it after you exit; do not commit. Reply: first line exactly STATUS: done, STATUS: blocked or STATUS: failed; then files changed and anything you could not do. Before replying, run a syntax-only check on every file you changed (e.g. node --check <file>, python -m py_compile <file>); this is not the Check. ${lean} ${progressLine}`;
  }

  const S = path.posix.join(liveDir, `${progressPrefix}-${name}.jsonl`);
  const E = S.replace(/\.jsonl$/, ".exit");

  state.execViaWb = !process.env.ORCH_RUNNER_FAKE_EXEC && executor === "agy" && agyFallback();

  let execCmd;
  if (process.env.ORCH_RUNNER_FAKE_EXEC) {
    execCmd = `{\n${process.env.ORCH_RUNNER_FAKE_EXEC}\n} > ${q(S)} 2>&1`;
  } else if (executor === "wb" || state.execViaWb) {
    execCmd = `{ echo '{"model":"${WB_MODEL}"}'; ${wbCmd(execPrompt, " --output-format stream-json")} < /dev/null; } > ${q(S)} 2>&1`;
  } else if (executor === "agy") {
    const convArg = (state.conversationId && !args.fresh) ? ` --conversation ${state.conversationId}` : "";
    execCmd = `C:/Users/ASUS/AppData/Local/agy/bin/agy.exe -p ${q(execPrompt)} --model gemini-3.8-flash-high --dangerously-skip-permissions --output-format stream-json${convArg} > ${q(S)} 2>&1`;
  } else {
    const model = executor === "luna" ? "gpt-6-luna" : "gpt-6.1-sol";
    execCmd = `{ echo '{"model":"${model}"}'; codex exec --approve-for-me${isGit ? "" : " --skip-git-repo-check"} -m ${model} -C ${q(repoAbs)} --json ${q(execPrompt)} < /dev/null; } > ${q(S)} 2>&1`;
  }

  if (remainingMin() <= 0) {
    state.outcome = "interrupted";
    state.interruptedAt = "executor";
    save(state);
  } else {
    const execResult = await runBash(execCmd, { cwd: repoAbs, timeoutMin: remainingMin(), exitPath: E });

    if (execResult.timedOut) {
      state.outcome = "interrupted";
      state.exec = { exit: null, status: "interrupted", seconds: execResult.seconds, reply: "" };
      save(state);
    } else {
      let reply = null;
      if (!process.env.ORCH_RUNNER_FAKE_EXEC && fs.existsSync(S)) {
        const content = fs.readFileSync(S, "utf8");
        const lines = content.trim().split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const obj = JSON.parse(lines[i]);
            if (executor === "agy" && !state.execViaWb) {
              if (obj.event === "result") {
                reply = obj.result?.response ?? (typeof obj.result === "string" ? obj.result : JSON.stringify(obj.result));
                state.conversationId = obj.result?.conversation_id ?? null;
                break;
              }
            } else if (obj.type === "result") {
              reply = obj.result ?? "";
              break;
            } else if (obj.item?.type === "agent_message") {
              reply = obj.item.text ?? "";
              break;
            }
          } catch {}
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

      const failOutcome = execResult.exit !== 0 || status === "failed" ? "failed" : status === "blocked" ? "blocked" : null;
      if (failOutcome) {
        state.outcome = failOutcome;
        save(state);
      }
    }
  }

  if (!state.outcome && state.readOnlyBefore) {
    const roDiff = getReadOnlyDiff(state.readOnlyBefore, readOnlyPaths, { repoAbs, normLiveDir, cardDirNorm });
    if (roDiff) {
      state.outcome = "readonly_violated";
      state.readOnlyChanged = roDiff;
      save(state);
    }
  }

}
