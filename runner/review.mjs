import fs from "node:fs";
import path from "node:path";
import { q, runBash, quotaOf } from "./lib.mjs";

export async function runReview(ctx) {
  const {
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
  } = ctx;

  state.stage = "reviewing";
  const floorSol = executor === "luna" || executor === "sol" || risk === "high" || args.reviewer === "sol";
  const reviewer = floorSol ? "gpt-6.1-sol" : "gpt-6-luna";

  state.review = { model: reviewer, verdict: null };
  if (args.reviewer === "luna" && floorSol) state.review.raised = true;

  if (quotaOf("codex")?.full) {
    state.outcome = "review_pending";
    state.review.verdict = "pending";
    state.review.reason = "codex quota used up";
    save(state);
    return;
  }
  save(state);

  let reviewPrompt;
  if (isGit) {
    const beforePathsList = Object.keys(state.before || {}).sort();
    const beforePathsStr = beforePathsList.length > 0 ? beforePathsList.join(", ") : "none";
    reviewPrompt = `Review the working-tree changes against ${cardAbs}. Run git status and git diff (include untracked files the card creates); read only the diff, the card and the code the diff touches. Do not run tests or scripts (the Check was already run) and do not modify or create files. card.md and review.md under docs/orch/<task>/ are always allowed. These files already had uncommitted changes before this task: ${beforePathsStr}. Those earlier changes are not part of it, but review any further change this task made in them. Report only problems this diff introduces; list pre-existing problems in one line at the end, outside the verdict. No style or naming remarks. Reply: first line exactly VERDICT: PASS or VERDICT: FAIL, then at most 5 findings, most severe first, each with file:line, the problem and the fix — wrong behaviour, a Parameters value not matching the card, a bypassed check, steps not followed, files outside the card, copied code, junk files. Also list bloat the diff adds (re-implemented helper or stdlib, an abstraction with one use, dead code, unrequested options); bloat alone does not make it FAIL.`;
  } else {
    const touchedList = (state.touched || []).join(", ");
    reviewPrompt = `Review the changes against ${cardAbs}. This folder is not a git repository; the task changed exactly these files: ${touchedList}. Read only those files and the card. Do not run tests or scripts (the Check was already run) and do not modify or create files. card.md and review.md under docs/orch/<task>/ are always allowed. Report only problems this diff introduces; list pre-existing problems in one line at the end, outside the verdict. No style or naming remarks. Reply: first line exactly VERDICT: PASS or VERDICT: FAIL, then at most 5 findings, most severe first, each with file:line, the problem and the fix — wrong behaviour, a Parameters value not matching the card, a bypassed check, steps not followed, files outside the card, copied code, junk files. Also list bloat the diff adds (re-implemented helper or stdlib, an abstraction with one use, dead code, unrequested options); bloat alone does not make it FAIL.`;
  }

  const reviewStream = path.posix.join(liveDir, `codex-review-${name}.jsonl`);
  const reviewExit = path.posix.join(liveDir, `codex-review-${name}.exit`);
  const reviewMdAbs = path.resolve(repoAbs, taskDir, "review.md").replaceAll("\\", "/");
  fs.rmSync(reviewMdAbs, { force: true });

  const skipGitFlag = isGit ? "" : " --skip-git-repo-check";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (remainingMin() <= 0) {
      state.outcome = "interrupted";
      state.interruptedAt = attempt === 0 ? "review" : "retry";
      save(state);
      break;
    }

    state.review.retried = attempt === 1;
    if (attempt === 1) {
      fs.rmSync(reviewMdAbs, { force: true });
    }

    const redir = attempt === 0 ? ">" : ">>";
    let reviewCmd;
    if (process.env.ORCH_RUNNER_FAKE_REVIEW) {
      reviewCmd = `{\n${process.env.ORCH_RUNNER_FAKE_REVIEW}\n} ${redir} ${q(reviewStream)} 2>&1`;
    } else {
      reviewCmd = `{ echo '{"model":"${reviewer}"}'; codex exec${skipGitFlag} -s read-only -m ${reviewer} -c model_reasoning_effort=medium -C ${q(repoAbs)} -o ${q(reviewMdAbs)} --json ${q(reviewPrompt)} < /dev/null; } ${redir} ${q(reviewStream)} 2>&1`;
    }

    const reviewRes = await runBash(reviewCmd, { cwd: repoAbs, timeoutMin: remainingMin(), exitPath: reviewExit });

    if (reviewRes.timedOut) {
      state.outcome = "interrupted";
      save(state);
      break;
    }

    if (reviewRes.exit !== 0) {
      let streamText = "";
      if (fs.existsSync(reviewStream)) {
        // Tail only: the reviewer's own text earlier in the stream can mention "quota".
        try { streamText = fs.readFileSync(reviewStream, "utf8").slice(-2000); } catch {}
      }
      if (/usage limit|quota|rate.?limit|\b429\b/i.test(streamText)) {
        state.outcome = "review_pending";
        state.review.verdict = "pending";
        state.review.reason = "codex quota used up";
      } else {
        state.outcome = "review_error";
        state.review.verdict = "error";
      }
      save(state);
      break;
    }

    let firstLine = "";
    if (fs.existsSync(reviewMdAbs)) {
      const content = fs.readFileSync(reviewMdAbs, "utf8");
      const lines = content.split(/\r?\n/);
      firstLine = lines[0]?.trim() ?? "";
    }

    if (firstLine === "VERDICT: PASS") {
      state.outcome = "review_pass";
      state.review.verdict = "PASS";
      save(state);
      break;
    } else if (firstLine === "VERDICT: FAIL") {
      state.outcome = "review_fail";
      state.review.verdict = "FAIL";
      save(state);
      break;
    }

    if (attempt === 1) {
      state.outcome = "review_error";
      state.review.verdict = firstLine || "error";
      save(state);
    }
  }
}
