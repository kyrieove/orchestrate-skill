import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isJunkPath } from "./card.mjs";
import { formatLedgerLines } from "./acceptance.mjs";

export function printSummary(ctx) {
  const {
    state,
    name,
    risk,
    executor,
    check,
    checkLog,
    repoAbs,
    taskDir,
    cardDirNorm,
    recon,
    isFix,
    fixDiffFile,
    fixDiffContent,
    stateFile
  } = ctx;

  const lines = [];
  lines.push(`ORCH-RUNNER ${name} outcome=${state.outcome} risk=${risk}`);

  const execExit = state.exec?.exit !== null && state.exec?.exit !== undefined ? state.exec.exit : "n/a";
  const execStatus = state.exec?.status ?? "n/a";
  const execMins = state.exec?.seconds != null ? (state.exec.seconds / 60).toFixed(1) : "0.0";
  lines.push(`executor: ${executor}${state.execViaWb ? " → wb deepseek-v4.1-flash (agy fallback)" : ""} exit=${execExit} status=${execStatus} ${execMins}m`);
  if (state.plan) {
    lines.push(`plan: ${state.plan.model} PLAN: ${state.plan.verdict}`);
    if (state.plan.verdict === "REVISE" && state.plan.file && fs.existsSync(state.plan.file)) {
      try {
        const planContent = fs.readFileSync(state.plan.file, "utf8");
        const planLines = planContent.split(/\r?\n/).slice(1, 16);
        while (planLines.length > 0 && !planLines[planLines.length - 1].trim()) {
          planLines.pop();
        }
        if (planLines.length > 0) {
          lines.push(planLines.join("\n"));
        }
      } catch {}
    }
  }

  const touchedStr = state.touched && state.touched.length > 0 ? state.touched.join(", ") : "-";
  const nonJunkOutOfScope = (state.outOfScope || []).filter((p) => !isJunkPath(p));
  const outOfScopeStr = nonJunkOutOfScope.length > 0 ? nonJunkOutOfScope.join(", ") : "-";
  const junkStr = (state.junk && state.junk.length > 0) ? `   junk: ${state.junk.join(", ")}` : "";
  const cardModStr = state.cardModified ? "yes" : "no";
  lines.push(`touched: ${touchedStr}   out of scope: ${outOfScopeStr}${junkStr}   card modified: ${cardModStr}`);
  if (state.concurrent?.length) lines.push(`concurrent: ${state.concurrent.map((c) => `${c.path} (${c.name})`).join(", ")}`);
  if (state.readOnlyChanged && state.readOnlyChanged.length > 0) {
    lines.push(`read-only changed: ${state.readOnlyChanged.join(", ")}`);
  }

  const checkExit = state.checkResult?.exit !== null && state.checkResult?.exit !== undefined ? state.checkResult.exit : "skipped";
  lines.push(`check: exit=${checkExit} \`${check}\``);
  if (state.baselineCheck) {
    const bExit = state.baselineCheck.exit;
    const bTimedOut = state.baselineCheck.timedOut;
    const bTouched = state.baselineCheck.touched || [];
    let bLine = bTimedOut ? "baseline check: timed out" : `baseline check: exit=${bExit}`;
    if (!bTimedOut && bExit !== 0 && checkExit !== 0 && checkExit !== "skipped") {
      bLine += " (Check was already red before the executor)";
    }
    if (bTouched.length > 0) {
      bLine += `   baseline wrote: ${bTouched.join(", ")}`;
    }
    lines.push(bLine);
  }
  if (checkExit !== "skipped" && checkExit !== 0 && fs.existsSync(checkLog)) {
    const logLines = fs.readFileSync(checkLog, "utf8").split(/\r?\n/).filter(Boolean);
    const tail20 = logLines.slice(-20).join("\n");
    if (tail20) {
      lines.push(tail20);
    }
  }

  const reviewMdAbs = path.resolve(repoAbs, taskDir, "review.md").replaceAll("\\", "/");
  if (state.review?.model) {
    const raisedSuffix = state.review?.raised ? " (luna requested, floor sol)" : "";
    if (state.review.verdict === "pending") {
      lines.push(`review: pending ${state.review.model} (${state.review.reason})${raisedSuffix}`);
    } else {
      let firstLine = "-";
      let restLines = [];
      if (fs.existsSync(reviewMdAbs)) {
        const revContent = fs.readFileSync(reviewMdAbs, "utf8");
        const revLines = revContent.split(/\r?\n/);
        firstLine = revLines[0]?.trim() || "-";
        restLines = revLines.slice(1, 13).filter((l) => l !== undefined);
      }
      const retriedSuffix = state.review?.retried ? " (retried)" : "";
      lines.push(`review: ${state.review.model} ${firstLine}${retriedSuffix}${raisedSuffix}`);
      if (restLines.length > 0 && restLines.some((l) => l.trim())) {
        lines.push(restLines.join("\n"));
      }
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

  lines.push("tokens:");
  lines.push(formatLedgerLines(state.ledger));

  lines.push("reply:");
  if (state.exec?.reply !== null && state.exec?.reply !== undefined) {
    lines.push(`full reply: ${path.join(cardDirNorm, "reply.md")}`);
  }
  const replyLines = (state.exec?.reply ?? "").split(/\r?\n/);
  const replyTail = replyLines.slice(-(recon ? 40 : 15)).join("\n");
  lines.push(replyTail);

  lines.push(`state: ${stateFile}`);

  console.log(lines.join("\n"));
}
