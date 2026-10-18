import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// Everything under docs/orch/ (cards, reviews, replies, other tasks' files) is never scope or read-only evidence.
export const exemptTaskPath = /^docs\/orch\//;

export function concurrentClaims(stateDir, self) {
  const claims = [];
  for (const file of fs.readdirSync(stateDir)) {
    if (!file.endsWith(".json") || file === `${self.name}.json`) continue;
    try {
      const abs = path.join(stateDir, file);
      const other = JSON.parse(fs.readFileSync(abs, "utf8"));
      if (self.repo && other.repo !== self.repo) continue;
      if (other.outcome && fs.statSync(abs).mtimeMs <= Date.parse(self.startedAt)) continue;
      claims.push({ name: other.name ?? file.slice(0, -5), mayChange: (other.mayChange || []).map((p) => self.repo ? p : path.resolve(other.repo, p).replaceAll("\\", "/") + (p.endsWith("/") ? "/" : "")) });
    } catch {}
  }
  return claims;
}

export function claimedPath(p, entries) {
  return entries.some((entry) => entry.endsWith("/") ? p.startsWith(entry) : p === entry);
}

export function outOfScopePaths(paths, stateDir, state) {
  const claims = concurrentClaims(stateDir, state);
  return paths.filter((p) => {
    if (!state.recon && claimedPath(p, state.mayChange || [])) return false;
    // Flagged concurrent earlier in this run: stays someone else's even after that run's claim expires.
    if (state.concurrent?.some((c) => c.path === p)) return false;
    const claim = claims.find((c) => claimedPath(p, c.mayChange));
    if (!claim) return true;
    state.concurrent ??= [];
    if (!state.concurrent.some((c) => c.path === p && c.name === claim.name)) state.concurrent.push({ path: p, name: claim.name });
    return false;
  });
}

export function filterReadOnly(paths, stateDir, state) {
  const claims = concurrentClaims(stateDir, { ...state, repo: null });
  return (paths || []).filter((p) => {
    const abs = path.resolve(state.repo, p).replaceAll("\\", "/");
    if (exemptTaskPath.test(path.posix.relative(state.repo, abs))) return false;
    const claim = claims.find((c) => claimedPath(abs, c.mayChange));
    if (!claim) return true;
    state.concurrent ??= [];
    if (!state.concurrent.some((c) => c.path === p && c.name === claim.name)) state.concurrent.push({ path: p, name: claim.name });
    return false;
  });
}

export function parseArgs(args) {
  const booleanFlags = new Set(["recon", "commit", "fresh", "recheck", "review-only", "exec-check"]);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (booleanFlags.has(key)) {
        parsed[key] = true;
        continue;
      }
      const val = args[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        parsed[key] = val;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }
  return parsed;
}

export function getSection(text, title) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  const sectionLines = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (inSection) break;
      const secTitle = line.replace(/^##\s+/, "").trim().split(/\s+/)[0];
      if (title.startsWith("Fix ") ? new RegExp(`^## ${title}(\\s|$)`).test(line.trim()) : secTitle.toLowerCase() === title.toLowerCase()) {
        inSection = true;
        continue;
      }
    }
    if (inSection) {
      sectionLines.push(line);
    }
  }
  return inSection ? sectionLines.join("\n") : null;
}

// Backticked paths of ## Files: before "read-only" = may change, after = read-only.
export function parseFiles(cardText) {
  const files = getSection(cardText, "Files") || "";
  const idx = files.search(/read-only/i);
  const ticks = (t) => [...t.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  return {
    mayChange: ticks(idx >= 0 ? files.slice(0, idx) : files).map((e) => e.replace(/\s+\(new\)$/i, "")),
    readOnly: idx >= 0 ? ticks(files.slice(idx + "read-only".length)) : [],
  };
}

export const extractCheck = (cardText) => extractCommand(cardText, "Check");

// The fenced block (or first backticked span) of a section; dropComments ignores <!-- --> (the template's hints).
export function extractCommand(cardText, title, dropComments = false) {
  const sec = dropComments ? getSection(cardText, title)?.replace(/<!--[\s\S]*?-->/g, "") : getSection(cardText, title);
  if (sec === undefined || sec === null) return null;
  const fenced = sec.match(/```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return sec.match(/`([^`]+)`/)?.[1].trim() ?? null;
}

export function lintCard(cardText, { recon = false, risk = "", repo = process.cwd() } = {}) {
  const problems = [];
  const requiredSections = ["Goal", "Risk", "Files", "Steps", "Don't"];
  if (!recon) {
    requiredSections.push("Check");
  }
  for (const sec of requiredSections) {
    if (getSection(cardText, sec) === null) {
      problems.push(`missing ## ${sec} section`);
    }
  }

  const riskSection = getSection(cardText, "Risk");
  if (riskSection !== null) {
    const firstWord = riskSection.trim().split(/\s+/)[0]?.toLowerCase();
    if (firstWord !== (risk ?? "").toLowerCase()) {
      problems.push(`Risk '${firstWord}' does not match --risk '${risk}'`);
    }
  }

  const stepsLine = cardText.split(/\r?\n/).find((l) => /^##\s+Steps\b/i.test(l)) || "";
  const stepsSection = getSection(cardText, "Steps") || "";
  if (!/N\s*=\s*\d+/.test(stepsLine) && !/N\s*=\s*\d+/.test(stepsSection)) {
    problems.push("Steps section heading or body must match /N\\s*=\\s*\\d+/");
  }

  const dontSection = getSection(cardText, "Don't");
  if (dontSection !== null) {
    const requiredDontPhrases = [
      "Run scripts in the foreground and wait",
      "Reuse existing functions",
      "No rm, no git push"
    ];
    for (const phrase of requiredDontPhrases) {
      if (!dontSection.includes(phrase)) {
        problems.push(`Don't section missing phrase: "${phrase}"`);
      }
    }
  }

  if (!recon) {
    const filesSection = getSection(cardText, "Files") || "";
    const roIdx = filesSection.search(/read-only/i);
    const beforeRo = roIdx >= 0 ? filesSection.slice(0, roIdx) : filesSection;
    if (!/`[^`]+`/.test(beforeRo)) {
      problems.push("Files section before read-only must have at least one backticked path");
    }

    const checkSection = getSection(cardText, "Check") || "";
    const hasFenced = /```[\s\S]*?```/.test(checkSection);
    const hasInline = /`[^`]+`/.test(checkSection);
    if (!hasFenced && !hasInline) {
      problems.push("Check section must have a fenced block or backticked span");
    }

    // A may-change path inside a read-only path can never pass: the guard ends the run readonly_violated.
    const { mayChange, readOnly } = parseFiles(cardText);
    const abs = (p) => path.resolve(repo, p.replace(/^~(?=\/|$)/, os.homedir()));
    const inside = (child, parent) => { const r = path.relative(parent, child); return r === "" || (r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r)); };
    for (const m of mayChange) {
      if (exemptTaskPath.test(path.relative(repo, abs(m)).replaceAll("\\", "/") + "/")) continue;
      const ro = readOnly.find((r) => inside(abs(m), abs(r)));
      if (ro) problems.push(`Files: may-change '${m}' is inside read-only '${ro}'`);
    }

    // The first word of the Check is an absolute path that does not exist: the Check cannot run.
    // Tested with bash, which is what runs the Check (handles /d/x and C:/x alike).
    const first = extractCheck(cardText)?.match(/^\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|<>()]+))/)?.slice(1).find((x) => x !== undefined)?.replaceAll("\\", "/");
    if (first && /^([A-Za-z]:)?\//.test(first) && spawnSync("bash", ["-c", 'test -e "$1"', "_", first]).status !== 0) {
      problems.push(`Check: '${first}' does not exist`);
    }
  }

  return problems;
}

// "N real / M false positive (scope S, card C, wrong W) / K missed"; the split is optional only when M is 0.
// scope = the file was not this card's; card = the card was wrong; wrong = the reviewer misread the code.
export function parseFindings(line) {
  const m = line.match(/^(?:- review findings: )?(\d+) real \/ (\d+) false positive(?: \(scope (\d+), card (\d+), wrong (\d+)\))? \/ (\d+) missed(?: \([^()]*\))?$/);
  if (!m) return null;
  const [real, fp, missed] = [+m[1], +m[2], +m[6]];
  const split = m[3] === undefined ? null : { scope: +m[3], card: +m[4], wrong: +m[5] };
  if (split ? split.scope + split.card + split.wrong !== fp : fp > 0) return null;
  return { real, falsePositive: fp, ...(split ?? { scope: 0, card: 0, wrong: 0 }), missed };
}

export function isJunkPath(repoRelPath) {
  const norm = repoRelPath.replaceAll("\\", "/");
  const segments = norm.split("/");
  if (segments.includes("__pycache__")) return true;
  const base = path.posix.basename(norm);
  if (base.endsWith(".log")) return true;
  if (base.startsWith("tmp")) return true;
  return false;
}
