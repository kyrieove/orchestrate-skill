import path from "node:path";

export function parseArgs(args) {
  const booleanFlags = new Set(["recon", "commit", "fresh", "recheck"]);
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
      if (secTitle.toLowerCase() === title.toLowerCase()) {
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

export function lintCard(cardText, { recon = false, risk = "" } = {}) {
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
  }

  return problems;
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
