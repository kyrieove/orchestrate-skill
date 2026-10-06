import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getSection } from "./card.mjs";

export function runCommit(args, ctx) {
  const { stateDir } = ctx;
  const name = args.name;
  const message = args.message;
  if (typeof name !== "string" || !/^[\w.-]+$/.test(name)) {
    console.error("Argument --name required for commit (letters, digits, _ . - only)");
    process.exit(2);
  }
  if (!message || typeof message !== "string") {
    console.error("Argument --message required for commit");
    process.exit(2);
  }
  const stateFile = path.posix.join(stateDir, `${name}.json`);
  if (!fs.existsSync(stateFile)) {
    console.error("No state file found:", stateFile);
    process.exit(2);
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (err) {
    console.error("Failed to parse state file:", err);
    process.exit(2);
  }
  if (state.git === false) {
    console.error("not a git repository; nothing to commit");
    process.exit(2);
  }
  const repoAbs = state.repo;
  const cardAbs = state.card;
  if (!cardAbs || !fs.existsSync(cardAbs)) {
    console.error("Card file not found:", cardAbs);
    process.exit(2);
  }
  const cardText = fs.readFileSync(cardAbs, "utf8");

  if (/^##\s+Acceptance\s+\(draft\)\s*$/im.test(cardText)) {
    console.error("Card still contains ## Acceptance (draft)");
    process.exit(2);
  }

  const acceptanceSection = getSection(cardText, "Acceptance");
  if (acceptanceSection === null) {
    console.error("There is no ## Acceptance section in card");
    process.exit(2);
  }
  if (/\bTODO\b/.test(acceptanceSection)) {
    console.error("TODO found in ## Acceptance section");
    process.exit(2);
  }

  const verdictMatch = acceptanceSection.match(/^-\s*verdict:\s*(accepted|review pending|rejected)\b/im);
  const verdict = verdictMatch ? verdictMatch[1].toLowerCase() : "missing";
  const hasClaudeFix = /^-\s*claude fix:\s*\S/im.test(acceptanceSection);
  const outcome = state.outcome ?? "none";

  const passOutcomes = new Set(["review_pass", "passed_no_review", "fix_passed", "recon_done"]);
  const fixableOutcomes = new Set(["review_fail", "check_failed"]);

  let allowed = false;
  if (verdict === "accepted") {
    allowed = passOutcomes.has(outcome) || (fixableOutcomes.has(outcome) && hasClaudeFix);
  } else if (verdict === "review pending") {
    allowed = outcome === "review_pending";
  }

  if (!allowed) {
    let reason = "outcome does not allow this verdict";
    if (verdict === "rejected") {
      reason = "rejected cards are not committed";
    } else if (verdict === "missing") {
      reason = 'no "- verdict:" line in ## Acceptance';
    }
    console.error(`commit refused: outcome=${outcome}, verdict=${verdict}: ${reason}`);
    process.exit(2);
  }

  const allTouched = state.allTouched || (state.rounds ? state.rounds.flatMap((r) => r.touched || []) : state.touched) || [];
  const mayChange = state.mayChange || [];
  const inScope = [...new Set(allTouched)].filter((p) =>
    mayChange.some((entry) => entry.endsWith("/") ? p.startsWith(entry) : p === entry)
  );
  // A file created in one round and removed in a later one was never tracked: git add would fail on it.
  const tracked = new Set(spawnSync("git", ["-C", repoAbs, "ls-files", "-z", "--", ...inScope], { encoding: "utf8" }).stdout.split("\0"));
  const stagedTouched = inScope.filter((p) => tracked.has(p) || fs.existsSync(path.resolve(repoAbs, p)));

  const cardDirNorm = path.resolve(path.dirname(cardAbs)).replaceAll("\\", "/");
  let taskDir = path.posix.relative(repoAbs, cardDirNorm);
  if (taskDir === "") taskDir = ".";
  const cardRel = taskDir === "." ? "card.md" : `${taskDir}/card.md`;
  const reviewRel = taskDir === "." ? "review.md" : `${taskDir}/review.md`;

  const filesToStage = new Set(stagedTouched);
  filesToStage.add(cardRel);
  if (fs.existsSync(path.resolve(repoAbs, reviewRel))) {
    filesToStage.add(reviewRel);
  }

  const reviewLogRel = "docs/review-log.md";
  const reviewLogAbs = path.resolve(repoAbs, reviewLogRel);
  if (fs.existsSync(reviewLogAbs)) {
    const yyyymmdd = new Date().toISOString().slice(0, 10);
    const goalSec = getSection(cardText, "Goal") || "";
    const goalFirstLine = goalSec.trim().split(/\r?\n/)[0]?.trim() || "";
    const logLine = `- ${yyyymmdd} ${state.name}: ${goalFirstLine} (${cardRel})\n`;
    fs.appendFileSync(reviewLogAbs, logLine, "utf8");
    filesToStage.add(reviewLogRel);
  }

  const fileList = Array.from(filesToStage).sort();
  const addRes = spawnSync("git", ["-C", repoAbs, "add", "--", ...fileList], { encoding: "utf8" });
  if (addRes.status !== 0) {
    console.error("git add failed:", addRes.stderr);
    process.exit(1);
  }
  const commitRes = spawnSync("git", ["-C", repoAbs, "commit", "-m", message, "--", ...fileList], { encoding: "utf8" });
  if (commitRes.status !== 0) {
    console.error("git commit failed:", commitRes.stderr);
    process.exit(1);
  }
  const revRes = spawnSync("git", ["-C", repoAbs, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  if (revRes.status !== 0) {
    console.error("git rev-parse failed:", revRes.stderr);
    process.exit(1);
  }
  const shortHead = revRes.stdout.trim();
  console.log(shortHead);
  state.commit = shortHead;
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, stateFile);
  process.exit(0);
}
