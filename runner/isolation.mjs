import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseFiles, exemptTaskPath } from "./card.mjs";

// --isolation worktree (ADR-0003): a card runs in its own git worktree on branch orch/<name>,
// --commit commits there and cherry-picks onto the main tree's current branch.
export const MAX_PARALLEL = 2;
const RUNNING_MAX_MS = 3 * 3600 * 1000; // a state file with no "done" stage older than this is a dead run

const git = (repo, ...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
const norm = (p) => p.replaceAll("\\", "/").replace(/\/+$/, "");
const overlap = (a, b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
const expand = (repo, p) => norm(path.resolve(repo, p.replace(/^~(?=\/|$)/, os.homedir())));
const isTaskDoc = (repo, abs) => exemptTaskPath.test(path.posix.relative(repo, abs) + "/");

function runningCards(stateDir, mainRepo, self) {
  const out = [];
  for (const file of fs.readdirSync(stateDir)) {
    if (!file.endsWith(".json") || file === `${self}.json`) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(stateDir, file), "utf8"));
      const oMain = norm(o.isolation?.mainRepo ?? o.repo ?? "");
      if (oMain !== mainRepo || o.stage === "done" || o.outcome || !(Date.now() - Date.parse(o.startedAt) < RUNNING_MAX_MS)) continue;
      // paths of an isolated card live under its worktree; compare them as main-tree paths
      const toMain = (p) => o.isolation && p.startsWith(norm(o.repo) + "/") ? norm(path.join(mainRepo, p.slice(norm(o.repo).length))) : norm(p);
      out.push({
        name: o.name ?? file.slice(0, -5),
        isolated: Boolean(o.isolation),
        mayChange: (o.mayChange || []).map((p) => expand(mainRepo, p)),
        readOnly: (o.readOnlyPaths || []).map(toMain)
      });
    } catch {}
  }
  return out;
}

// Returns a refusal message, or null when the card may start next to the cards already running.
export function conflictProblem({ stateDir, mainRepo, name, cardText }) {
  const { mayChange, readOnly } = parseFiles(cardText);
  const mine = mayChange.map((p) => expand(mainRepo, p)).filter((p) => !isTaskDoc(mainRepo, p));
  const myRo = readOnly.map((p) => expand(mainRepo, p));
  const others = runningCards(stateDir, mainRepo, name);
  if (others.filter((o) => o.isolated).length >= MAX_PARALLEL) {
    return `at most ${MAX_PARALLEL} isolated cards run at once: ${others.filter((o) => o.isolated).map((o) => o.name).join(", ")}`;
  }
  for (const o of others) {
    const oMay = o.mayChange.filter((p) => !isTaskDoc(mainRepo, p));
    const hit = mine.find((m) => oMay.some((x) => overlap(m, x)) || o.readOnly.some((x) => overlap(m, x))) ??
      oMay.find((x) => myRo.some((r) => overlap(x, r)));
    if (hit) return `paths overlap with running card '${o.name}' at ${path.posix.relative(mainRepo, hit) || "."}`;
  }
  const dirty = !mine.length ? [] : git(mainRepo, "status", "--porcelain", "--untracked-files=all", "--", ...mine.map((p) => path.posix.relative(mainRepo, p) || ".")).stdout
    .split(/\r?\n/).filter((l) => l && !exemptTaskPath.test(l.slice(3)));
  if (dirty.length) return `the main tree has uncommitted changes in this card's may-change paths: ${dirty.map((l) => l.slice(3)).join(", ")}`;
  return null;
}

// One dispatcher at a time checks and reserves, so two cards started together cannot both pass the checks.
function withAdmissionLock(stateDir, fn) {
  const lock = path.join(stateDir, ".admit.lock");
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "pid"), String(process.pid)); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        // a crashed dispatcher's: its process is gone (or the lock is 10 minutes old)
        const pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
        let alive = true;
        try { process.kill(pid, 0); } catch (err) { alive = err.code === "EPERM"; }
        if (!alive || Date.now() - fs.statSync(lock).mtimeMs > 600000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (i > 1200) return { error: "the admission lock is busy" };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

// -> { error } or { info, repo, card }; repo and card are the worktree's, and the card there is a copy of the main one.
// On success a reservation state file (declared paths, no outcome) is already written: other dispatchers see it at once.
export function startIsolation({ stateDir, name, mainRepo, mainCard, cardText }) {
  const cardRel = path.posix.relative(mainRepo, mainCard);
  if (cardRel.startsWith("..")) return { error: "the card must be inside the repo to run in a worktree" };
  return withAdmissionLock(stateDir, () => {
    const problem = conflictProblem({ stateDir, mainRepo, name, cardText });
    if (problem) return { error: problem };
    const wt = norm(path.join(stateDir, "wt", name));
    const branch = `orch/${name}`;
    // A leftover of an earlier run of this name is replaced only if nothing was committed on its branch.
    if (git(mainRepo, "rev-list", "--count", `HEAD..${branch}`).stdout.trim() > 0) {
      return { error: `branch ${branch} holds commits that are not on the current branch: merge or delete it (git branch -D ${branch}), or use another name` };
    }
    if (fs.existsSync(wt)) git(mainRepo, "worktree", "remove", "--force", wt);
    fs.rmSync(wt, { recursive: true, force: true });
    git(mainRepo, "worktree", "prune");
    git(mainRepo, "branch", "-D", branch);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    const add = git(mainRepo, "worktree", "add", "-b", branch, wt, "HEAD");
    if (add.status !== 0) return { error: `git worktree add failed: ${add.stderr.trim()}` };
    const card = norm(path.join(wt, cardRel));
    fs.mkdirSync(path.dirname(card), { recursive: true });
    fs.copyFileSync(mainCard, card);
    const info = { mainRepo, mainCard, wt, branch };
    const { mayChange, readOnly } = parseFiles(cardText);
    const readOnlyPaths = readOnly.map((p) => expand(mainRepo, p));
    fs.writeFileSync(path.join(stateDir, `${name}.json`), JSON.stringify({
      name, repo: wt, card, isolation: info, stage: "executing", outcome: null, startedAt: new Date().toISOString(),
      mayChange, readOnlyPaths
    }), "utf8");
    return { info, repo: wt, card, readOnlyPaths };
  });
}

// Cherry-pick the worktree's commit onto the main tree's current branch; on success the worktree and branch go.
// -> { ok: true, commit } or { ok: false, error }
export function mergeBack(isolation, taskDocs) {
  const { mainRepo, wt, branch } = isolation;
  // The worktree's card, review and reply supersede whatever the main tree holds of them.
  // Refuse before touching anything when a doc has staged changes (they could not be put back exactly).
  const staged = taskDocs.filter((d) => git(mainRepo, "diff", "--cached", "--quiet", "--", d).status !== 0);
  if (staged.length) return { ok: false, error: `staged changes in ${staged.join(", ")}: commit or unstage them first` };
  const saved = new Map(); // abs -> original bytes, or null when the file did not exist
  for (const d of taskDocs) {
    const abs = path.resolve(mainRepo, d);
    const tracked = git(mainRepo, "ls-files", "--error-unmatch", "--", d).status === 0;
    if (tracked && git(mainRepo, "diff", "--quiet", "HEAD", "--", d).status === 0) continue; // same as HEAD: the pick applies cleanly
    if (!tracked && !fs.existsSync(abs)) continue;
    saved.set(abs, fs.existsSync(abs) ? fs.readFileSync(abs) : null);
    if (tracked) git(mainRepo, "checkout", "HEAD", "--", d);
    else fs.rmSync(abs, { force: true });
  }
  const sha = git(wt, "rev-parse", "HEAD").stdout.trim();
  const pick = git(mainRepo, "cherry-pick", sha);
  if (pick.status !== 0) {
    git(mainRepo, "cherry-pick", "--abort");
    for (const [abs, buf] of saved) buf === null ? fs.rmSync(abs, { force: true }) : (fs.mkdirSync(path.dirname(abs), { recursive: true }), fs.writeFileSync(abs, buf));
    return { ok: false, error: (pick.stderr || pick.stdout).trim() };
  }
  git(mainRepo, "worktree", "remove", "--force", wt);
  git(mainRepo, "branch", "-D", branch);
  return { ok: true, commit: git(mainRepo, "rev-parse", "--short", "HEAD").stdout.trim() };
}
