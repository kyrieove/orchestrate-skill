import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { exemptTaskPath } from "./card.mjs";

export function snapshot(repoAbs, isGit) {
  if (!isGit) {
    const result = {};
    function walk(dir) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const fullPath = path.posix.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile()) {
            const st = fs.statSync(fullPath);
            const rel = path.posix.relative(repoAbs, fullPath).replaceAll("\\", "/");
            result[rel] = {
              st: "",
              hash: `${st.size}:${st.mtimeMs}`
            };
          }
        } catch {}
      }
    }
    walk(repoAbs);
    return result;
  }

  const res = spawnSync("git", ["-C", repoAbs, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024
  });
  if (res.status !== 0) {
    throw new Error(`git status failed: ${res.stderr}`);
  }
  const parts = res.stdout.split("\0");
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const st = part.slice(0, 2);
    const p = part.slice(3).replaceAll("\\", "/");
    entries.push({ st, path: p });
    if (/[RC]/.test(st)) {
      i++;
    }
  }
  const existing = [];
  for (const entry of entries) {
    const absP = path.resolve(repoAbs, entry.path);
    try {
      if (fs.existsSync(absP) && fs.statSync(absP).isFile()) {
        existing.push(entry.path);
      }
    } catch {}
  }
  const hashes = new Map();
  if (existing.length > 0) {
    // stdin, not argv: a long dirty list overflows the Windows command line
    const hashRes = spawnSync("git", ["-C", repoAbs, "hash-object", "--stdin-paths"], {
      input: existing.join("\n") + "\n",
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024
    });
    if (hashRes.status !== 0) {
      throw new Error(`git hash-object failed: ${hashRes.stderr}`);
    }
    const lines = hashRes.stdout.trim().split(/\r?\n/);
    for (let j = 0; j < existing.length; j++) {
      hashes.set(existing[j], lines[j]);
    }
  }
  const result = {};
  for (const entry of entries) {
    result[entry.path] = {
      st: entry.st,
      hash: hashes.get(entry.path) ?? null
    };
  }
  return result;
}

// A read-only session must leave the repo as it was: snapshot + HEAD before, changedSince() after.
export function watch(repoAbs, isGit) {
  const head = isGit ? spawnSync("git", ["-C", repoAbs, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() : "";
  return { head, snap: snapshot(repoAbs, isGit) };
}

// Changed paths (task docs, docs/orch/**, excluded), plus "HEAD" when a commit was made.
export function changedSince(prev, repoAbs, isGit) {
  const now = watch(repoAbs, isGit);
  const paths = [...new Set([...Object.keys(prev.snap), ...Object.keys(now.snap)])]
    .filter((p) => !exemptTaskPath.test(p) && JSON.stringify(prev.snap[p] ?? null) !== JSON.stringify(now.snap[p] ?? null));
  if (now.head !== prev.head) paths.push("HEAD");
  return paths.sort();
}

export function statTree(paths, { normLiveDir, cardDirNorm }) {
  const result = {};
  const seenDirs = new Set();

  function walk(dir) {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const fullPath = path.posix.join(dir, entry.name);
      // A listed ancestor must not pull in what the runner and executor write themselves.
      if (fullPath === normLiveDir || fullPath === cardDirNorm) continue;
      try {
        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink() || (!isFile && !isDir)) {
          const st = fs.statSync(fullPath);
          isDir = st.isDirectory();
          isFile = st.isFile();
        }
        if (isDir) {
          walk(fullPath);
        } else if (isFile) {
          const st = fs.statSync(fullPath);
          result[fullPath] = [st.size, st.mtimeMs];
        }
      } catch {}
    }
  }

  for (const p of paths) {
    const absP = path.resolve(p).replaceAll("\\", "/");
    if (!fs.existsSync(absP)) continue;
    try {
      const st = fs.statSync(absP);
      if (st.isDirectory()) {
        walk(absP);
      } else if (st.isFile()) {
        result[absP] = [st.size, st.mtimeMs];
      }
    } catch {}
  }

  return result;
}

export function getReadOnlyDiff(beforeStats, paths, { repoAbs, normLiveDir, cardDirNorm }) {
  const currentStats = statTree(paths, { normLiveDir, cardDirNorm });
  const beforeKeys = Object.keys(beforeStats || {});
  const currentKeys = Object.keys(currentStats || {});
  const allKeys = new Set([...beforeKeys, ...currentKeys]);
  const diffs = [];

  for (const k of allKeys) {
    const b = beforeStats ? beforeStats[k] : undefined;
    const c = currentStats ? currentStats[k] : undefined;
    if (!b || !c) {
      diffs.push(k);
    } else if (b[0] !== c[0] || b[1] !== c[1]) {
      diffs.push(k);
    }
  }

  const repoPrefix = repoAbs.endsWith("/") ? repoAbs : repoAbs + "/";
  const formatted = diffs.map((absP) => {
    if (absP === repoAbs) return ".";
    if (absP.startsWith(repoPrefix)) {
      return path.posix.relative(repoAbs, absP);
    }
    return absP;
  });
  const kept = formatted.filter((p) => !exemptTaskPath.test(p)).sort();
  return kept.length ? kept : null;
}
