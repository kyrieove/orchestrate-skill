import fs from "node:fs";
import path from "node:path";
import { q, runBash, wbCmd, WB_MODEL, codexFallback } from "./lib.mjs";
import { snapshot } from "./snapshot.mjs";

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
  let reviewer;
  if (args.reviewer) {
    reviewer = args.reviewer === "sol" ? "gpt-6.1-sol" : "gpt-6-luna";
  } else if (executor === "luna" || executor === "sol") {
    reviewer = "gpt-6.1-sol";
  } else if (risk === "high") {
    reviewer = "gpt-6.1-sol";
  } else {
    reviewer = "gpt-6-luna";
  }

  const wb = codexFallback();
  if (wb) reviewer = WB_MODEL;
  const preReview = wb ? snapshot(repoAbs, isGit) : null;
  state.review = { model: reviewer, verdict: null };
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
    } else if (wb) {
      reviewCmd = `{ echo '{"model":"${reviewer}"}'; ${wbCmd(reviewPrompt, " --disallowedTools Write,Edit,NotebookEdit --output-format stream-json")} < /dev/null; } ${redir} ${q(reviewStream)} 2>&1`;
    } else {
      reviewCmd = `{ echo '{"model":"${reviewer}"}'; codex exec${skipGitFlag} -s read-only -m ${reviewer} -c model_reasoning_effort=medium -C ${q(repoAbs)} -o ${q(reviewMdAbs)} --json ${q(reviewPrompt)} < /dev/null; } ${redir} ${q(reviewStream)} 2>&1`;
    }

    const reviewRes = await runBash(reviewCmd, { cwd: repoAbs, timeoutMin: remainingMin(), exitPath: reviewExit });
    // wb streams JSON (so its lane shows progress); review.md gets the text of the newest result line.
    if (wb && fs.existsSync(reviewStream)) {
      const result = fs.readFileSync(reviewStream, "utf8").split("\n").reverse()
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o?.type === "result");
      if (result) fs.writeFileSync(reviewMdAbs, result.result ?? "", "utf8");
    }

    if (reviewRes.timedOut) {
      state.outcome = "interrupted";
      save(state);
      break;
    }

    if (reviewRes.exit !== 0) {
      state.outcome = "review_error";
      state.review.verdict = "error";
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

  if (preReview) {
    const post = snapshot(repoAbs, isGit);
    const own = path.posix.join(taskDir, "review.md").replaceAll("\\", "/");
    const wrote = [...new Set([...Object.keys(preReview), ...Object.keys(post)])]
      .filter((p) => p !== own && JSON.stringify(preReview[p]) !== JSON.stringify(post[p])).sort();
    if (wrote.length) {
      state.outcome = "review_error";
      state.review.verdict = "error";
      state.review.wrote = wrote;
      save(state);
    }
  }
}
