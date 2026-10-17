import fs from "node:fs";
import path from "node:path";
import { q, runBash, quotaOf } from "./lib.mjs";

export async function runReviewOnly(args, { stateDir, liveDir }) {
  if (typeof args.name !== "string" || !/^[\w.-]+$/.test(args.name)) {
    console.error("Argument --name required (letters, digits, _ . - only)");
    process.exit(2);
  }
  const stateFile = path.join(stateDir, `${args.name}.json`);
  if (!fs.existsSync(stateFile)) {
    console.error("No state file found:", stateFile);
    process.exit(2);
  }
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const outcome = state.outcome;
  const save = (st) => {
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(st, null, 2), "utf8");
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  };
  const taskDir = path.relative(state.repo, path.dirname(state.card)).replaceAll("\\", "/");
  await runReview({ args, executor: state.executor, risk: state.risk, state, save,
    isGit: state.git !== false, cardAbs: state.card, liveDir, name: state.name, repoAbs: state.repo, taskDir, remainingMin: () => 30 });
  state.reviewOnly = { verdict: state.review.verdict, at: new Date().toISOString() };
  if (!["out_of_scope", "review_error", "review_pending"].includes(outcome) || !["PASS", "FAIL"].includes(state.review.verdict)) state.outcome = outcome;
  state.stage = "done";
  save(state);
  console.log(`ORCH-RUNNER ${state.name} outcome=${state.outcome} risk=${state.risk}\nreview: ${state.review.model} ${state.review.verdict}\nreview file: ${path.join(path.dirname(state.card), "review.md")}`);
  process.exit(state.review.verdict === "PASS" ? 0 : 1);
}

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
  const reviewer = "gpt-6.1-sol"; // sol is the only review gate (ADR-0003)

  state.review = { model: reviewer, verdict: null };

  if (quotaOf("codex")?.full) {
    state.outcome = "review_pending";
    state.review.verdict = "pending";
    state.review.reason = "codex quota used up";
    save(state);
    return;
  }
  save(state);

  const touchedList = (state.touched || []).join(", ") || "none";
  const beforePathsList = Object.keys(state.before || {}).sort();
  const beforePathsStr = beforePathsList.length > 0 ? beforePathsList.join(", ") : "none";
  const where = isGit
    ? `Run git diff (and read untracked files the card creates) for these files only. These files already had uncommitted changes before this task: ${beforePathsStr}. Those earlier changes are not part of it, but review any further change this task made in them.`
    : "This folder is not a git repository; read those files and the card.";
  const reviewPrompt = `Review the changes against ${cardAbs}. The runner found that the task changed exactly these files: ${touchedList}. Review only these files; file scope was already checked by the runner, so do not judge it. ${where} Read the card and the code the changes touch. Do not run tests or scripts (the Check was already run) and do not modify or create files. card.md, review.md and reply.md under docs/orch/<task>/ are always allowed (reply.md is written by the runner). Report only problems this diff introduces; list pre-existing problems in one line at the end, outside the verdict. No style or naming remarks. If a finding is one instance of a whole class of bug, name the class and use grep to list every occurrence. Reply: first line exactly VERDICT: PASS or VERDICT: FAIL, then at most 5 findings, most severe first, each starting with a priority tag, then file:line, the problem, the fix and the code line that confirms it (read it; drop any finding you cannot confirm in the code) — wrong behaviour, a Parameters value not matching the card, a bypassed check, steps not followed, copied code, junk files. Priority: [P0]/[P1] = changes behaviour, a computed result or a Parameters value, breaks the card's Goal or Check, bypasses a check, or skips a step; [P2]/[P3] = everything else. VERDICT: FAIL only when at least one [P0] or [P1] finding exists. Also list bloat the diff adds (re-implemented helper or stdlib, an abstraction with one use, dead code, unrequested options); bloat alone does not make it FAIL.`;

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
