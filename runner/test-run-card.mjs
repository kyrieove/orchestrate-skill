import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runCardScript = path.resolve(__dirname, "run-card.mjs").replaceAll("\\", "/");
const runLongScript = path.resolve(__dirname, "run-long.mjs").replaceAll("\\", "/");
const statsScript = path.resolve(__dirname, "stats.mjs").replaceAll("\\", "/");

// Run inside a git hook, GIT_DIR/GIT_INDEX_FILE etc. are inherited and would point the temp-repo git calls at the outer repo.
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];

const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-repo-")).replaceAll("\\", "/");
const tempLive = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-live-")).replaceAll("\\", "/");
let fakeBin = null;

let passedCount = 0;

try {
  spawnSync("git", ["init"], { cwd: tempRepo, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: tempRepo, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tempRepo, stdio: "ignore" });

  fs.writeFileSync(path.join(tempRepo, "a.txt"), "1", "utf8");
  fs.mkdirSync(path.join(tempRepo, "data"), { recursive: true });
  fs.writeFileSync(path.join(tempRepo, "data/f.txt"), "d", "utf8");
  spawnSync("git", ["add", "a.txt", "data/f.txt"], { cwd: tempRepo, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "initial commit"], { cwd: tempRepo, stdio: "ignore" });

  const cardDir = path.join(tempRepo, "docs/orch/t");
  fs.mkdirSync(cardDir, { recursive: true });
  const cardPath = path.join(cardDir, "card.md").replaceAll("\\", "/");

  function writeCard(checkCmd = 'node -e "process.exit(0)"', cardRisk = "low") {
    const cardContent = `# test-task — test card

## Goal
Test run-card.mjs cases.

## Risk
${cardRisk}

## Files
may change: \`a.txt\`, \`b.txt\` / read-only: \`data/\`

## Steps (N = 1)
1. Step 1.

## Check
\`${checkCmd}\`

## Don't
Run scripts in the foreground and wait
Reuse existing functions
No rm, no git push
`;
    fs.writeFileSync(cardPath, cardContent, "utf8");
  }

  writeCard();
  spawnSync("git", ["add", "docs/orch/t/card.md"], { cwd: tempRepo, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "add test card"], { cwd: tempRepo, stdio: "ignore" });

  function resetRepo() {
    spawnSync("git", ["reset", "--hard", "HEAD"], { cwd: tempRepo, stdio: "ignore" });
    spawnSync("git", ["clean", "-fd"], { cwd: tempRepo, stdio: "ignore" });
  }

  function readState(name) {
    const stateFile = path.join(tempLive, "orch-runner", `${name}.json`);
    const content = fs.readFileSync(stateFile, "utf8");
    return JSON.parse(content);
  }

  const baseEnv = {
    ...process.env,
    ORCH_RUNNER_LIVE_DIR: tempLive,
    ORCH_AGY_FALLBACK_FILE: `${tempLive}/agy-fallback`,
    ORCH_QUOTA_SCRIPT: `${tempLive}/no-quota.mjs`
  };

  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-bin-")).replaceAll("\\", "/");
  const stream = (reply) => [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: reply }),
  ].join("\n");
  fs.writeFileSync(path.join(fakeBin, "codebuddy"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${fakeBin}/argv"\ncase "$*" in\n  *disallowedTools*) cat <<'EOF'\n${stream("VERDICT: PASS")}\nEOF\n  ;;\n  *) cat <<'EOF'\n${stream("STATUS: done")}\nEOF\n  ;;\nesac\n`,
    { mode: 0o755 });
  const wbEnv = { ...baseEnv, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` };

  function runCard(name, { risk, env = baseEnv, args = [], card } = {}) {
    const isCommit = args.includes("--commit");
    const isFixRun = args.includes("--fix");
    const cmdArgs = [runCardScript];

    if (!args.includes("--name") && name) {
      cmdArgs.push("--name", name);
    }
    if (!isCommit && !args.includes("--card")) {
      cmdArgs.push("--card", card ?? cardPath);
    }
    if (!isCommit && !isFixRun && !args.includes("--risk")) {
      cmdArgs.push("--risk", risk ?? "low");
    } else if (risk && !args.includes("--risk")) {
      cmdArgs.push("--risk", risk);
    }
    if (!isCommit && !isFixRun && !args.includes("--executor")) {
      cmdArgs.push("--executor", "agy");
    }
    if (!isCommit && !args.includes("--repo")) {
      cmdArgs.push("--repo", tempRepo);
    }
    cmdArgs.push(...args);
    return spawnSync(process.execPath, cmdArgs, { env, encoding: "utf8" });
  }

  // Case A: write "2" to a.txt (pre-dirty), fake exec echo 3 > a.txt; echo x > b.txt; echo 'STATUS: done', check
  // node -e "process.exit(0)", risk low → passed_no_review; touched contains a.txt and b.txt
  {
    resetRepo();
    writeCard('node -e "process.exit(0)"');
    fs.writeFileSync(path.join(tempRepo, "a.txt"), "2", "utf8");
    const envA = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 3 > a.txt; echo x > b.txt; echo 'STATUS: done'"
    };
    delete envA.ORCH_RUNNER_FAKE_REVIEW;

    const res = runCard("case-a", { env: envA });

    assert.strictEqual(res.status, 0, `Case A exit status was ${res.status}: ${res.stderr}`);
    const state = readState("case-a");
    assert.strictEqual(state.outcome, "passed_no_review");
    assert.ok(state.touched.includes("a.txt"), "touched should contain a.txt");
    assert.ok(state.touched.includes("b.txt"), "touched should contain b.txt");
    passedCount++;
  }

  // Case B: fake exec creates c.txt → out_of_scope, outOfScope = ["c.txt"], checkResult not run.
  {
    resetRepo();
    writeCard('node -e "process.exit(0)"');
    const envB = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo c > c.txt; echo 'STATUS: done'"
    };
    delete envB.ORCH_RUNNER_FAKE_REVIEW;

    const res = runCard("case-b", { env: envB });

    assert.strictEqual(res.status, 0, `Case B exit status was ${res.status}: ${res.stderr}`);
    const state = readState("case-b");
    assert.strictEqual(state.outcome, "out_of_scope");
    assert.deepStrictEqual(state.outOfScope, ["c.txt"]);
    assert.strictEqual(state.checkResult.exit, null, "checkResult should not have run");
    passedCount++;
  }

  // Case C: check node -e "process.exit(3)" → check_failed, exit 3.
  {
    resetRepo();
    writeCard('node -e "process.exit(3)"');
    const envC = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 3 > a.txt; echo 'STATUS: done'"
    };
    delete envC.ORCH_RUNNER_FAKE_REVIEW;

    const res = runCard("case-c", { env: envC });

    assert.strictEqual(res.status, 0, `Case C exit status was ${res.status}: ${res.stderr}`);
    const state = readState("case-c");
    assert.strictEqual(state.outcome, "check_failed");
    assert.strictEqual(state.checkResult.exit, 3);
    passedCount++;
  }

  // Case D: fake exec echo 'STATUS: blocked' (exit 0) → blocked, Check not run.
  {
    resetRepo();
    writeCard('node -e "process.exit(0)"');
    const envD = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 'STATUS: blocked'"
    };
    delete envD.ORCH_RUNNER_FAKE_REVIEW;

    const res = runCard("case-d", { env: envD });

    assert.strictEqual(res.status, 0, `Case D exit status was ${res.status}: ${res.stderr}`);
    const state = readState("case-d");
    assert.strictEqual(state.outcome, "blocked");
    assert.strictEqual(state.checkResult.exit, null, "checkResult should not have run");
    passedCount++;
  }

  // Case E: fake exec sleep 8; echo x > marker.txt, --timeout-min 0.05 → interrupted within 6 s; then wait 7 s and assert
  // marker.txt does not exist (the descendant was killed).
  {
    resetRepo();
    writeCard('node -e "process.exit(0)"');
    const envE = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "sleep 8; echo x > marker.txt"
    };
    delete envE.ORCH_RUNNER_FAKE_REVIEW;

    const start = Date.now();
    const res = runCard("case-e", { env: envE, args: ["--timeout-min", "0.05"] });

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 6000, `Interrupted elapsed time was ${elapsed}ms, expected < 6000ms`);

    assert.strictEqual(res.status, 0, `Case E exit status was ${res.status}: ${res.stderr}`);
    const state = readState("case-e");
    assert.strictEqual(state.outcome, "interrupted");

    await new Promise((r) => setTimeout(r, 7000));
    const markerExists = fs.existsSync(path.join(tempRepo, "marker.txt"));
    assert.strictEqual(markerExists, false, "marker.txt should not exist, descendant was killed");
    passedCount++;
  }

  // Case F: risk medium, fake review printf 'VERDICT: PASS\n' > docs/orch/t/review.md → review_pass; review.md not in touched.
  {
    resetRepo();
    writeCard('node -e "process.exit(0)"', "medium");
    // Pre-write VERDICT: PASS to docs/orch/t/review.md, use fake review exit 1 → assert review_error
    fs.writeFileSync(path.join(tempRepo, "docs/orch/t/review.md"), "VERDICT: PASS\n", "utf8");
    const envF1 = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 3 > a.txt; echo 'STATUS: done'",
      ORCH_RUNNER_FAKE_REVIEW: "exit 1"
    };

    const res1 = runCard("case-f-stale", { risk: "medium", env: envF1 });

    assert.strictEqual(res1.status, 0, `Case F stale review exit status was ${res1.status}: ${res1.stderr}`);
    const state1 = readState("case-f-stale");
    assert.strictEqual(state1.outcome, "review_error");

    // Keep existing F (fake review writes PASS, exit 0) → review_pass
    resetRepo();
    writeCard('node -e "process.exit(0)"', "medium");
    const envF = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 3 > a.txt; echo 'STATUS: done'",
      ORCH_RUNNER_FAKE_REVIEW: "printf 'VERDICT: PASS\\n' > docs/orch/t/review.md"
    };

    const res = runCard("case-f", { risk: "medium", env: envF });

    assert.strictEqual(res.status, 0, `Case F exit status was ${res.status}: ${res.stderr}`);
    const state = readState("case-f");
    assert.strictEqual(state.outcome, "review_pass");
    assert.ok(!state.touched.includes("docs/orch/t/review.md"), "docs/orch/t/review.md should not be in touched");
    assert.ok(!state.touched.includes("review.md"), "review.md should not be in touched");
    passedCount++;
  }

  // Case G: card without ## Don't → exit status 2, stderr contains lint:, no state file for that name.
  {
    resetRepo();
    const cardG = `# test-task — test card

## Goal
Test run-card.mjs cases.

## Risk
low

## Files
may change: \`a.txt\`, \`b.txt\` / read-only: \`data/\`

## Steps (N = 1)
1. Step 1.

## Check
\`node -e "process.exit(0)"\`
`;
    fs.writeFileSync(cardPath, cardG, "utf8");
    const markerStream = path.join(tempLive, "agy-case-g.jsonl").replaceAll("\\", "/");
    fs.writeFileSync(markerStream, "marker", "utf8");

    const res = runCard("case-g");

    assert.strictEqual(res.status, 2, `Case G exit status was ${res.status}: ${res.stderr}`);
    assert.ok(res.stderr.includes("lint:"), "Case G stderr should contain lint:");
    const stateFile = path.join(tempLive, "orch-runner", "case-g.json");
    assert.strictEqual(fs.existsSync(stateFile), false, "State file must not exist for case-g");
    assert.strictEqual(fs.existsSync(markerStream), true, "Stream file must not be cleared");
    fs.rmSync(markerStream, { force: true });
    passedCount++;
  }

  // Case H: card whose ## Risk says high run with --risk low → exit 2, stderr contains lint:.
  {
    resetRepo();
    writeCard('node -e "process.exit(0)"', "high");
    const markerStream = path.join(tempLive, "agy-case-h.jsonl").replaceAll("\\", "/");
    fs.writeFileSync(markerStream, "marker", "utf8");

    const res = runCard("case-h", { risk: "low" });

    assert.strictEqual(res.status, 2, `Case H exit status was ${res.status}: ${res.stderr}`);
    assert.ok(res.stderr.includes("lint:"), "Case H stderr should contain lint:");
    const stateFile = path.join(tempLive, "orch-runner", "case-h.json");
    assert.strictEqual(fs.existsSync(stateFile), false, "State file must not exist for case-h");
    assert.strictEqual(fs.existsSync(markerStream), true, "Stream file must not be cleared");
    fs.rmSync(markerStream, { force: true });
    passedCount++;
  }

  // Case I: fake exec echo x > x.log; echo 'STATUS: done' → out_of_scope, state.junk = ["x.log"].
  {
    resetRepo();
    writeCard('node -e "process.exit(0)"');
    const envI = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo x > x.log; echo 'STATUS: done'"
    };
    delete envI.ORCH_RUNNER_FAKE_REVIEW;

    const res = runCard("case-i", { env: envI });

    assert.strictEqual(res.status, 0, `Case I exit status was ${res.status}: ${res.stderr}`);
    const state = readState("case-i");
    assert.strictEqual(state.outcome, "out_of_scope");
    assert.deepStrictEqual(state.junk, ["x.log"]);
    passedCount++;
  }

  // Case J: fake exec echo changed > data/f.txt; echo 'STATUS: done' → readonly_violated, readOnlyChanged contains data/f.txt.
  {
    resetRepo();
    writeCard('node -e "process.exit(0)"');
    const envJ = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo changed > data/f.txt; echo 'STATUS: done'"
    };
    delete envJ.ORCH_RUNNER_FAKE_REVIEW;

    const res = runCard("case-j", { env: envJ });

    assert.strictEqual(res.status, 0, `Case J exit status was ${res.status}: ${res.stderr}`);
    const state = readState("case-j");
    assert.strictEqual(state.outcome, "readonly_violated");
    assert.ok(state.readOnlyChanged && state.readOnlyChanged.includes("data/f.txt"), "readOnlyChanged should contain data/f.txt");
    passedCount++;
  }

  // Case K: --recon, fake exec echo 'STATUS: done'; echo 'answer: 42' → recon_done, Check not run (checkResult unset).
  {
    resetRepo();
    const cardK = `# test-task — recon card

## Goal
Recon goal.

## Risk
low

## Files
may change: \`a.txt\` / read-only: \`data/\`

## Steps (N = 1)
1. Step 1.

## Don't
Run scripts in the foreground and wait
Reuse existing functions
No rm, no git push
`;
    fs.writeFileSync(cardPath, cardK, "utf8");
    const envK = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 'STATUS: done'; echo 'answer: 42'"
    };
    delete envK.ORCH_RUNNER_FAKE_REVIEW;

    const res = runCard("case-k", { env: envK, args: ["--recon"] });

    assert.strictEqual(res.status, 0, `Case K exit status was ${res.status}: ${res.stderr}`);
    const state = readState("case-k");
    assert.strictEqual(state.outcome, "recon_done");
    assert.strictEqual(state.checkResult.exit, null, "checkResult should not have run");
    passedCount++;
  }

  // Case L: risk medium, fake review that writes no verdict here on its first call and VERDICT: PASS on its second → review_pass, state.review.retried === true.
  {
    resetRepo();
    writeCard('node -e "process.exit(0)"', "medium");
    const counterFile = path.posix.join(tempLive, "review-counter.txt");
    if (fs.existsSync(counterFile)) fs.rmSync(counterFile, { force: true });
    const envL = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 3 > a.txt; echo 'STATUS: done'",
      ORCH_RUNNER_FAKE_REVIEW: `if [ ! -f '${counterFile}' ]; then echo 1 > '${counterFile}'; echo 'no verdict here' > docs/orch/t/review.md; else echo 'VERDICT: PASS' > docs/orch/t/review.md; fi`
    };

    const res = runCard("case-l", { risk: "medium", env: envL });

    assert.strictEqual(res.status, 0, `Case L exit status was ${res.status}: ${res.stderr}`);
    const state = readState("case-l");
    assert.strictEqual(state.outcome, "review_pass");
    assert.strictEqual(state.review.retried, true);
    passedCount++;
  }

  // Case M (fix): case-A-like run (passes, risk low) → card gets ## Acceptance (draft); append ## Fix 1 to the card
  // (commit nothing), run --fix 1 with fake exec echo y > b.txt; echo 'STATUS: done' → fix_passed,
  // state.fixes.length === 1, the .fix1.diff file contains +y, and the card has exactly one
  // ## Acceptance (draft) whose tokens part has a Fix 1 line.
  {
    resetRepo();
    writeCard('node -e "process.exit(0)"', "low");
    fs.writeFileSync(path.join(tempRepo, "a.txt"), "2", "utf8");
    const envM1 = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 3 > a.txt; echo x > b.txt; echo 'STATUS: done'"
    };
    delete envM1.ORCH_RUNNER_FAKE_REVIEW;

    const resM1 = runCard("case-m", { env: envM1 });

    assert.strictEqual(resM1.status, 0, `Case M (round 1) exit status was ${resM1.status}: ${resM1.stderr}`);
    const stateM1 = readState("case-m");
    assert.strictEqual(stateM1.outcome, "passed_no_review");
    const cardM1 = fs.readFileSync(cardPath, "utf8");
    assert.ok(cardM1.includes("## Acceptance (draft)"), "Card should get ## Acceptance (draft)");

    fs.writeFileSync(cardPath, cardM1.replace("`b.txt` /", "`b.txt`, `c.txt` /"), "utf8");
    fs.appendFileSync(cardPath, "\n## Fix 1\n1. Fix step.\n", "utf8");

    const envM2 = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo y > b.txt; echo z > c.txt; echo 'STATUS: done'"
    };
    delete envM2.ORCH_RUNNER_FAKE_REVIEW;

    const resM2 = runCard("case-m", { args: ["--fix", "1"], env: envM2 });

    assert.strictEqual(resM2.status, 0, `Case M (fix 1) exit status was ${resM2.status}: ${resM2.stderr}`);
    const stateM2 = readState("case-m");
    assert.strictEqual(stateM2.outcome, "fix_passed");
    assert.ok(stateM2.mayChange.includes("c.txt"), "mayChange should include c.txt");
    assert.ok(stateM2.fixes && stateM2.fixes.length === 1, "state.fixes.length should be 1");

    const diffFile = path.join(tempLive, "orch-runner", "case-m.fix1.diff");
    assert.ok(fs.existsSync(diffFile), "diff file should exist");
    const diffText = fs.readFileSync(diffFile, "utf8");
    assert.ok(diffText.includes("+y"), "diff file should contain +y");

    const cardM2 = fs.readFileSync(cardPath, "utf8");
    const draftMatches = cardM2.match(/##\s+Acceptance\s+\(draft\)/g) || [];
    assert.strictEqual(draftMatches.length, 1, "card should have exactly one ## Acceptance (draft)");
    assert.ok(cardM2.includes("Fix 1:"), "tokens part should have a Fix 1 line");
    passedCount++;
  }

  // Case N (fix guards): right after M, --fix 3 → exit 2; on a fresh name with no state file --fix 1 → exit 2.
  {
    const resN1 = runCard("case-m", { args: ["--fix", "3"] });
    assert.strictEqual(resN1.status, 2, `Expected exit 2 for --fix 3, got ${resN1.status}`);

    const resN2 = runCard("non-existent-name", { args: ["--fix", "1"] });
    assert.strictEqual(resN2.status, 2, `Expected exit 2 for fresh name with no state file, got ${resN2.status}`);
    passedCount++;
  }

  // Case O (commit): after M, --commit refuses (exit 2) while the draft heading is there; then replace the draft section
  // by ## Acceptance + - verdict: accepted, create an unrelated untracked z.txt, run --commit --message t
  // → exit 0 and git show --name-only --format= HEAD lists exactly a.txt, b.txt, c.txt, docs/orch/t/card.md.
  {
    const resO1 = runCard("case-m", { args: ["--commit", "--message", "t"] });
    assert.strictEqual(resO1.status, 2, `Expected exit 2 while draft heading is present, got ${resO1.status}`);

    assert.ok(["review_pass", "passed_no_review", "fix_passed", "recon_done"].includes(readState("case-m").outcome),
      `case-m outcome must allow an accepted commit, got ${readState("case-m").outcome}`);
    const cardContent = fs.readFileSync(cardPath, "utf8");
    const withoutDraft = cardContent.replace(/##\s+Acceptance\s+\(draft\)[\s\S]*$/, "").trimEnd();
    fs.writeFileSync(cardPath, `${withoutDraft}\n\n## Acceptance\n- verdict: accepted\n`, "utf8");

    fs.writeFileSync(path.join(tempRepo, "z.txt"), "unrelated untracked", "utf8");

    const resO2 = runCard("case-m", { args: ["--commit", "--message", "t"] });
    assert.strictEqual(resO2.status, 0, `Expected exit 0 for --commit, got ${resO2.status}: ${resO2.stderr}`);

    const showRes = spawnSync("git", ["-C", tempRepo, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" });
    assert.strictEqual(showRes.status, 0);
    const committedFiles = showRes.stdout.trim().split(/\r?\n/).filter(Boolean).sort();
    assert.deepStrictEqual(committedFiles, ["a.txt", "b.txt", "c.txt", "docs/orch/t/card.md"]);
    passedCount++;
  }

  // Case O5 (commit-gate):
  // (a) risk medium with ORCH_RUNNER_FAKE_REVIEW writing VERDICT: FAIL to docs/orch/t/review.md → outcome review_fail;
  // replace the draft Acceptance with ## Acceptance\n- verdict: accepted\n; --commit --message t → exit 2,
  // stderr contains commit refused: outcome=review_fail, verdict=accepted, and git rev-parse HEAD is unchanged.
  // (b) same card, add the line - claude fix: fixed the finding → --commit exits 0.
  // (c) a fresh pass run (fake review PASS) with - verdict: review pending → exit 2 with outcome does not allow this verdict.
  // (d) a fresh pass run with - verdict: rejected → exit 2 with rejected cards are not committed.
  // (e) a fresh pass run whose Acceptance has no verdict line (just ## Acceptance\n- files: a.txt\n) → exit 2 with no "- verdict:" line.
  {
    // (a)
    resetRepo();
    writeCard('node -e "process.exit(0)"', "medium");
    const envO5a = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 3 > a.txt; echo 'STATUS: done'",
      ORCH_RUNNER_FAKE_REVIEW: "printf 'VERDICT: FAIL\\n' > docs/orch/t/review.md"
    };
    const resO5a = runCard("case-o5-a", { risk: "medium", env: envO5a });
    assert.strictEqual(resO5a.status, 0, `Case O5(a) run status was ${resO5a.status}: ${resO5a.stderr}`);
    const stateO5a = readState("case-o5-a");
    assert.strictEqual(stateO5a.outcome, "review_fail");

    const headBefore = spawnSync("git", ["-C", tempRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

    const cardContentA = fs.readFileSync(cardPath, "utf8");
    const withoutDraftA = cardContentA.replace(/##\s+Acceptance\s+\(draft\)[\s\S]*$/, "").trimEnd();
    fs.writeFileSync(cardPath, `${withoutDraftA}\n\n## Acceptance\n- verdict: accepted\n`, "utf8");

    const resO5aCommit = runCard("case-o5-a", { args: ["--commit", "--message", "t"] });
    assert.strictEqual(resO5aCommit.status, 2, `Expected exit 2 for Case O5(a) commit, got ${resO5aCommit.status}`);
    assert.ok(
      resO5aCommit.stderr.includes("commit refused: outcome=review_fail, verdict=accepted"),
      `Case O5(a) stderr should contain 'commit refused: outcome=review_fail, verdict=accepted', got: ${resO5aCommit.stderr}`
    );
    const headAfter = spawnSync("git", ["-C", tempRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    assert.strictEqual(headAfter, headBefore, "git rev-parse HEAD must be unchanged");

    // (b)
    fs.appendFileSync(cardPath, "- claude fix: fixed the finding\n", "utf8");
    const resO5bCommit = runCard("case-o5-a", { args: ["--commit", "--message", "t"] });
    assert.strictEqual(resO5bCommit.status, 0, `Case O5(b) commit status was ${resO5bCommit.status}: ${resO5bCommit.stderr}`);

    // (c)
    resetRepo();
    writeCard('node -e "process.exit(0)"', "medium");
    const envO5Pass = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 3 > a.txt; echo 'STATUS: done'",
      ORCH_RUNNER_FAKE_REVIEW: "printf 'VERDICT: PASS\\n' > docs/orch/t/review.md"
    };
    const resO5cRun = runCard("case-o5-c", { risk: "medium", env: envO5Pass });
    assert.strictEqual(resO5cRun.status, 0, `Case O5(c) run status was ${resO5cRun.status}: ${resO5cRun.stderr}`);
    const stateO5c = readState("case-o5-c");
    assert.strictEqual(stateO5c.outcome, "review_pass");

    const cardContentC = fs.readFileSync(cardPath, "utf8");
    const withoutDraftC = cardContentC.replace(/##\s+Acceptance\s+\(draft\)[\s\S]*$/, "").trimEnd();
    fs.writeFileSync(cardPath, `${withoutDraftC}\n\n## Acceptance\n- verdict: review pending\n`, "utf8");

    const resO5cCommit = runCard("case-o5-c", { args: ["--commit", "--message", "t"] });
    assert.strictEqual(resO5cCommit.status, 2, `Expected exit 2 for Case O5(c), got ${resO5cCommit.status}`);
    assert.ok(
      resO5cCommit.stderr.includes("outcome does not allow this verdict"),
      `Case O5(c) stderr should contain 'outcome does not allow this verdict', got: ${resO5cCommit.stderr}`
    );

    // (d)
    resetRepo();
    writeCard('node -e "process.exit(0)"', "medium");
    const resO5dRun = runCard("case-o5-d", { risk: "medium", env: envO5Pass });
    assert.strictEqual(resO5dRun.status, 0, `Case O5(d) run status was ${resO5dRun.status}: ${resO5dRun.stderr}`);
    const stateO5d = readState("case-o5-d");
    assert.strictEqual(stateO5d.outcome, "review_pass");

    const cardContentD = fs.readFileSync(cardPath, "utf8");
    const withoutDraftD = cardContentD.replace(/##\s+Acceptance\s+\(draft\)[\s\S]*$/, "").trimEnd();
    fs.writeFileSync(cardPath, `${withoutDraftD}\n\n## Acceptance\n- verdict: rejected\n`, "utf8");

    const resO5dCommit = runCard("case-o5-d", { args: ["--commit", "--message", "t"] });
    assert.strictEqual(resO5dCommit.status, 2, `Expected exit 2 for Case O5(d), got ${resO5dCommit.status}`);
    assert.ok(
      resO5dCommit.stderr.includes("rejected cards are not committed"),
      `Case O5(d) stderr should contain 'rejected cards are not committed', got: ${resO5dCommit.stderr}`
    );

    // (e)
    resetRepo();
    writeCard('node -e "process.exit(0)"', "medium");
    const resO5eRun = runCard("case-o5-e", { risk: "medium", env: envO5Pass });
    assert.strictEqual(resO5eRun.status, 0, `Case O5(e) run status was ${resO5eRun.status}: ${resO5eRun.stderr}`);
    const stateO5e = readState("case-o5-e");
    assert.strictEqual(stateO5e.outcome, "review_pass");

    const cardContentE = fs.readFileSync(cardPath, "utf8");
    const withoutDraftE = cardContentE.replace(/##\s+Acceptance\s+\(draft\)[\s\S]*$/, "").trimEnd();
    fs.writeFileSync(cardPath, `${withoutDraftE}\n\n## Acceptance\n- files: a.txt\n`, "utf8");

    const resO5eCommit = runCard("case-o5-e", { args: ["--commit", "--message", "t"] });
    assert.strictEqual(resO5eCommit.status, 2, `Expected exit 2 for Case O5(e), got ${resO5eCommit.status}`);
    assert.ok(
      resO5eCommit.stderr.includes('no "- verdict:" line'),
      `Case O5(e) stderr should contain 'no "- verdict:" line', got: ${resO5eCommit.stderr}`
    );

    passedCount++;
  }

  // Case P (ledger): write agy-ledgertest.jsonl into the temp live dir with an init line, two step_update lines carrying
  // usage {input_tokens: 100, cache_read_tokens: 1000, output_tokens: 10} each (same shape as the real stream), and a
  // result line with cumulative usage {input_tokens: 999999, …}; node ledger.mjs ledgertest --json with
  // ORCH_RUNNER_LIVE_DIR → fresh 200, cached 2000, out 20.
  {
    const ledgerFile = path.join(tempLive, "agy-ledgertest.jsonl");
    const lines = [
      JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-high" } }),
      JSON.stringify({ event: "step_update", step_update: { usage: { input_tokens: 100, cache_read_tokens: 1000, output_tokens: 10 } } }),
      JSON.stringify({ event: "step_update", step_update: { usage: { input_tokens: 100, cache_read_tokens: 1000, output_tokens: 10 } } }),
      JSON.stringify({ event: "result", result: { usage: { input_tokens: 999999, cache_read_tokens: 999999, output_tokens: 999999 } } })
    ];
    fs.writeFileSync(ledgerFile, lines.join("\n") + "\n", "utf8");

    const ledgerScript = path.resolve(__dirname, "../ledger.mjs");
    const resP = spawnSync(process.execPath, [ledgerScript, "ledgertest", "--json"], {
      env: baseEnv,
      encoding: "utf8"
    });
    assert.strictEqual(resP.status, 0, `Expected exit 0 for ledger, got ${resP.status}: ${resP.stderr}`);
    const parsed = JSON.parse(resP.stdout.trim());
    assert.ok(Array.isArray(parsed) && parsed.length === 1, "ledger --json should return an array with 1 item");
    assert.strictEqual(parsed[0].fresh, 200);
    assert.strictEqual(parsed[0].cached, 2000);
    assert.strictEqual(parsed[0].out, 20);
    passedCount++;
  }

  // Case Q (run-long): (a) --out = an existing temp dir, no --resume → exit 2 and no stream file; (b) a fresh
  // --out path (not created), command echo hello → exit 0, exit file 0, stream contains hello; (c) fresh out,
  // command sleep 8, --timeout-min 0.05 → exit file interrupted within 6 s.
  {
    const existingOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-out-"));
    const streamFileQ1 = path.join(tempLive, "run-case-q1.jsonl");
    const resQ1 = spawnSync(process.execPath, [
      runLongScript,
      "--name", "case-q1",
      "--out", existingOutDir,
      "--", "echo", "hi"
    ], { env: baseEnv, encoding: "utf8" });
    assert.strictEqual(resQ1.status, 2, `Expected exit 2 for existing out dir without --resume, got ${resQ1.status}`);
    assert.ok(!fs.existsSync(streamFileQ1), "stream file should not exist when exit 2");
    fs.rmSync(existingOutDir, { recursive: true, force: true });

    const freshOutDirQ2 = path.join(os.tmpdir(), `orch-test-fresh-out-${Date.now()}-q2`);
    const streamFileQ2 = path.join(tempLive, "run-case-q2.jsonl");
    const exitFileQ2 = path.join(tempLive, "run-case-q2.exit");
    const resQ2 = spawnSync(process.execPath, [
      runLongScript,
      "--name", "case-q2",
      "--out", freshOutDirQ2,
      "--", "echo", "hello"
    ], { env: baseEnv, encoding: "utf8" });
    assert.strictEqual(resQ2.status, 0, `Expected exit 0 for run-long echo hello, got ${resQ2.status}: ${resQ2.stderr}`);
    assert.ok(fs.existsSync(exitFileQ2), "exit file should exist");
    assert.strictEqual(fs.readFileSync(exitFileQ2, "utf8").trim(), "0");
    assert.ok(fs.existsSync(streamFileQ2), "stream file should exist");
    assert.ok(fs.readFileSync(streamFileQ2, "utf8").includes("hello"), "stream should contain hello");

    const freshOutDirQ3 = path.join(os.tmpdir(), `orch-test-fresh-out-${Date.now()}-q3`);
    const exitFileQ3 = path.join(tempLive, "run-case-q3.exit");
    const startQ3 = Date.now();
    const resQ3 = spawnSync(process.execPath, [
      runLongScript,
      "--name", "case-q3",
      "--out", freshOutDirQ3,
      "--timeout-min", "0.05",
      "--", "sleep", "8"
    ], { env: baseEnv, encoding: "utf8" });
    const elapsedQ3 = (Date.now() - startQ3) / 1000;
    assert.strictEqual(resQ3.status, 0, `Expected exit 0 for run-long wrapper, got ${resQ3.status}: ${resQ3.stderr}`);
    assert.ok(elapsedQ3 < 6.0, `Expected timeout within 6s, took ${elapsedQ3}s`);
    assert.ok(fs.existsSync(exitFileQ3), "exit file should exist");
    assert.strictEqual(fs.readFileSync(exitFileQ3, "utf8").trim(), "interrupted");

    // Case Q4 (run-long --resume): a stale exit file from a previous run is removed before the command starts;
    // the stream is appended, not truncated.
    {
      const outQ4 = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-out-q4-"));
      const exitFileQ4 = path.join(tempLive, "run-case-q4.exit");
      const streamFileQ4 = path.join(tempLive, "run-case-q4.jsonl");
      fs.writeFileSync(exitFileQ4, "1\n");
      fs.writeFileSync(streamFileQ4, "old-line\n");
      const probe = `process.exit(require("fs").existsSync(${JSON.stringify(exitFileQ4)}) ? 3 : 0)`;
      const resQ4 = spawnSync(process.execPath, [
        runLongScript, "--name", "case-q4", "--out", outQ4, "--resume",
        "--", process.execPath.replaceAll("\\", "/"), "-e", probe
      ], { env: baseEnv, encoding: "utf8" });
      assert.strictEqual(resQ4.status, 0, `run-long wrapper should exit 0, got ${resQ4.status}: ${resQ4.stderr}`);
      assert.strictEqual(fs.readFileSync(exitFileQ4, "utf8").trim(), "0", "stale exit file must be gone while the command runs; new exit must be 0");
      assert.ok(fs.readFileSync(streamFileQ4, "utf8").includes("old-line"), "--resume must append to the stream, not truncate it");
      fs.rmSync(outQ4, { recursive: true, force: true });
    }

    const freshOutDirQ4 = path.join(os.tmpdir(), `orch-test-fresh-out-${Date.now()}-q4`);
    const streamFileQ4 = path.join(tempLive, "run-case-q4.jsonl");
    const exitFileQ4 = path.join(tempLive, "run-case-q4.exit");
    const resQ4 = spawnSync(process.execPath, [
      runLongScript,
      "--name", "case-q4",
      "--out", freshOutDirQ4,
      "--", "printf", "%s\n", "a b"
    ], { env: baseEnv, encoding: "utf8" });
    assert.strictEqual(resQ4.status, 0, `Expected exit 0 for run-long printf, got ${resQ4.status}: ${resQ4.stderr}`);
    assert.ok(fs.existsSync(exitFileQ4), "exit file should exist");
    assert.strictEqual(fs.readFileSync(exitFileQ4, "utf8").trim(), "0");
    assert.ok(fs.existsSync(streamFileQ4), "stream file should exist");
    assert.ok(fs.readFileSync(streamFileQ4, "utf8").split(/\r?\n/).includes("a b"), "stream should contain the line 'a b'");
    passedCount++;
  }

  // Case R (non-git): a temp folder (no git init) with a.txt, a card at docs/orch/t/card.md listing a.txt, b.txt;
  // fake exec echo x > b.txt; echo 'STATUS: done', risk low → passed_no_review, touched = ["b.txt"]; then fake
  // exec echo y > c.txt; echo 'STATUS: done' on a new name → out_of_scope with c.txt.
  {
    const nonGitRepo = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-nongit-")).replaceAll("\\", "/");
    try {
      fs.writeFileSync(path.join(nonGitRepo, "a.txt"), "hello a", "utf8");
      const nonGitCardDir = path.join(nonGitRepo, "docs/orch/t");
      fs.mkdirSync(nonGitCardDir, { recursive: true });
      const nonGitCardPath = path.join(nonGitCardDir, "card.md").replaceAll("\\", "/");
      const cardContentR = `# non-git-task — test non-git

## Goal
Test non-git folder in run-card.mjs.

## Risk
low

## Files
may change: \`a.txt\`, \`b.txt\` / read-only: \`docs/\`

## Steps (N = 1)
1. Step 1.

## Check
\`node -e "process.exit(0)"\`

## Don't
Run scripts in the foreground and wait
Reuse existing functions
No rm, no git push
`;
      fs.writeFileSync(nonGitCardPath, cardContentR, "utf8");

      const envR1 = {
        ...baseEnv,
        ORCH_RUNNER_FAKE_EXEC: "echo x > b.txt; echo 'STATUS: done'"
      };
      delete envR1.ORCH_RUNNER_FAKE_REVIEW;

      const resR1 = runCard("case-r1", {
        card: nonGitCardPath,
        args: ["--repo", nonGitRepo],
        env: envR1
      });

      assert.strictEqual(resR1.status, 0, `Case R1 exit status was ${resR1.status}: ${resR1.stderr}`);
      const stateR1 = readState("case-r1");
      assert.strictEqual(stateR1.outcome, "passed_no_review");
      assert.deepStrictEqual(stateR1.touched, ["b.txt"]);

      const envR2 = {
        ...baseEnv,
        ORCH_RUNNER_FAKE_EXEC: "echo y > c.txt; echo 'STATUS: done'"
      };
      delete envR2.ORCH_RUNNER_FAKE_REVIEW;

      const resR2 = runCard("case-r2", {
        card: nonGitCardPath,
        args: ["--repo", nonGitRepo],
        env: envR2
      });

      assert.strictEqual(resR2.status, 0, `Case R2 exit status was ${resR2.status}: ${resR2.stderr}`);
      const stateR2 = readState("case-r2");
      assert.strictEqual(stateR2.outcome, "out_of_scope");
      assert.ok(stateR2.outOfScope && stateR2.outOfScope.includes("c.txt"), `Expected c.txt in outOfScope, got ${stateR2.outOfScope}`);
      passedCount++;
    } finally {
      fs.rmSync(nonGitRepo, { recursive: true, force: true });
    }
  }

  // Case S (stats): write five state JSONs into a temp live dir's orch-runner/ (two agy/medium, one sol/high,
  // one agy/low with rounds, one luna/low with rounds but no round seconds, with exec.seconds, outcome,
  // ledger exec rows and fixes) → output has a line starting agy/medium containing cards 2 and fixes 1,
  // a line starting sol/high containing cards 1, a line starting agy/low containing fresh 120k and exec 1.5m,
  // a line starting luna/low containing exec 2.0m, and total cards 5.
  {
    const statsLive = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-stats-live-")).replaceAll("\\", "/");
    const statsStateDir = path.join(statsLive, "orch-runner");
    fs.mkdirSync(statsStateDir, { recursive: true });

    const state1 = {
      name: "stats-1",
      executor: "agy",
      risk: "medium",
      outcome: "review_pass",
      exec: { seconds: 120 },
      ledger: [{ role: "exec", fresh: 100000, cached: 500000, out: 10000 }],
      fixes: [{ n: 1 }]
    };
    const state2 = {
      name: "stats-2",
      executor: "agy",
      risk: "medium",
      outcome: "review_fail",
      exec: { seconds: 180 },
      ledger: [{ role: "exec", fresh: 200000, cached: 600000, out: 20000 }],
      fixes: []
    };
    const state3 = {
      name: "stats-3",
      executor: "sol",
      risk: "high",
      outcome: "review_pass",
      exec: { seconds: 300 },
      ledger: [{ role: "exec", fresh: 300000, cached: 800000, out: 30000 }],
      fixes: []
    };
    const state4 = {
      name: "stats-4",
      executor: "agy",
      risk: "low",
      outcome: "fix_passed",
      exec: { seconds: 30 },
      ledger: [{ role: "exec", fresh: 20000, cached: 0, out: 0 }],
      fixes: [{ n: 1 }],
      rounds: [
        { round: "1", ledger: [{ role: "exec", fresh: 100000, cached: 0, out: 0 }], seconds: 60 },
        { round: "Fix 1", ledger: [{ role: "exec", fresh: 20000, cached: 0, out: 0 }], seconds: 30 }
      ]
    };
    const state5 = {
      name: "stats-5",
      executor: "luna",
      risk: "low",
      outcome: "fix_passed",
      exec: { seconds: 120 },
      fixes: [{ n: 1 }],
      rounds: [
        { round: "1", ledger: [] },
        { round: "Fix 1", ledger: [] }
      ]
    };

    fs.writeFileSync(path.join(statsStateDir, "stats-1.json"), JSON.stringify(state1), "utf8");
    fs.writeFileSync(path.join(statsStateDir, "stats-2.json"), JSON.stringify(state2), "utf8");
    fs.writeFileSync(path.join(statsStateDir, "stats-3.json"), JSON.stringify(state3), "utf8");
    fs.writeFileSync(path.join(statsStateDir, "stats-4.json"), JSON.stringify(state4), "utf8");
    fs.writeFileSync(path.join(statsStateDir, "stats-5.json"), JSON.stringify(state5), "utf8");

    const statsRes = spawnSync(process.execPath, [statsScript], {
      env: { ...process.env, ORCH_RUNNER_LIVE_DIR: statsLive },
      encoding: "utf8"
    });
    assert.strictEqual(statsRes.status, 0, `Expected exit 0 for stats.mjs, got ${statsRes.status}: ${statsRes.stderr}`);
    const statsOut = statsRes.stdout;
    const lines = statsOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    const agyMediumLine = lines.find((l) => l.startsWith("agy/medium"));
    assert.ok(agyMediumLine, "Expected a line starting with agy/medium");
    assert.ok(agyMediumLine.includes("cards 2"), "agy/medium line should contain 'cards 2'");
    assert.ok(agyMediumLine.includes("fixes 1"), "agy/medium line should contain 'fixes 1'");

    const agyLowLine = lines.find((l) => l.startsWith("agy/low"));
    assert.ok(agyLowLine, "Expected a line starting with agy/low");
    assert.ok(agyLowLine.includes("fresh 120k"), "agy/low line should contain 'fresh 120k'");
    assert.ok(agyLowLine.includes("exec 1.5m"), "agy/low line should contain 'exec 1.5m'");

    const lunaLowLine = lines.find((l) => l.startsWith("luna/low"));
    assert.ok(lunaLowLine, "Expected a line starting with luna/low");
    assert.ok(lunaLowLine.includes("exec 2.0m"), "luna/low line should contain 'exec 2.0m'");

    const solHighLine = lines.find((l) => l.startsWith("sol/high"));
    assert.ok(solHighLine, "Expected a line starting with sol/high");
    assert.ok(solHighLine.includes("cards 1"), "sol/high line should contain 'cards 1'");

    assert.ok(lines.some((l) => l === "total cards 5"), "Output should contain 'total cards 5'");

    fs.rmSync(statsLive, { recursive: true, force: true });
    passedCount++;
  }

  // Case T: fake exec only writes b.txt (allowed); Check node -e "require('fs').writeFileSync('z.txt','1')" →
  // out_of_scope with z.txt in outOfScope.
  {
    resetRepo();
    writeCard('node -e "require(\'fs\').writeFileSync(\'z.txt\',\'1\')"');
    const envT = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo b > b.txt; echo 'STATUS: done'"
    };
    delete envT.ORCH_RUNNER_FAKE_REVIEW;

    const res = runCard("case-t", { env: envT });
    assert.strictEqual(res.status, 0, `Case T exit status was ${res.status}: ${res.stderr}`);
    const state = readState("case-t");
    assert.strictEqual(state.outcome, "out_of_scope");
    assert.ok(state.outOfScope && state.outOfScope.includes("z.txt"), `Expected z.txt in outOfScope, got ${state.outOfScope}`);
    passedCount++;
  }

  // Case U: the read-only dir data/ contains a directory symlink data/link → a temp dir outside the repo holding f.txt
  // (create with fs.symlinkSync(target, link, "junction")); fake exec appends to <target>/f.txt → readonly_violated.
  {
    resetRepo();
    writeCard('node -e "process.exit(0)"');
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-ext-")).replaceAll("\\", "/");
    const linkPath = path.join(tempRepo, "data/link").replaceAll("\\", "/");
    try {
      fs.writeFileSync(path.join(extDir, "f.txt"), "hello", "utf8");
      fs.symlinkSync(extDir, linkPath, "junction");

      const targetFile = path.join(extDir, "f.txt").replaceAll("\\", "/");
      const envU = {
        ...baseEnv,
        ORCH_RUNNER_FAKE_EXEC: `node -e "require('fs').appendFileSync('${targetFile}','more')"; echo 'STATUS: done'`
      };
      delete envU.ORCH_RUNNER_FAKE_REVIEW;

      const res = runCard("case-u", { env: envU });
      assert.strictEqual(res.status, 0, `Case U exit status was ${res.status}: ${res.stderr}`);
      const state = readState("case-u");
      assert.strictEqual(state.outcome, "readonly_violated");
      assert.ok(state.readOnlyChanged && state.readOnlyChanged.some((p) => p.includes("f.txt")), "readOnlyChanged should include f.txt");
      passedCount++;
    } finally {
      try { fs.rmSync(linkPath, { force: true }); } catch {}
      fs.rmSync(extDir, { recursive: true, force: true });
    }
  }

  // Case V: --timeout-min 0.1, fake exec sleep 4; echo 'STATUS: done', Check sleep 4 (bash) → finishes within 12 s with
  // outcome interrupted (the Check got only the remaining ~2 s).
  {
    resetRepo();
    writeCard("sleep 4");
    const envV = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "sleep 4; echo 'STATUS: done'"
    };
    delete envV.ORCH_RUNNER_FAKE_REVIEW;

    const startV = Date.now();
    const res = runCard("case-v", { env: envV, args: ["--timeout-min", "0.1"] });
    const elapsedV = (Date.now() - startV) / 1000;

    assert.strictEqual(res.status, 0, `Case V exit status was ${res.status}: ${res.stderr}`);
    assert.ok(elapsedV < 12.0, `Expected finish within 12s, took ${elapsedV}s`);
    const state = readState("case-v");
    assert.strictEqual(state.outcome, "interrupted");
    passedCount++;
  }

  // Case W: card Files may change: `src/`, repo commits src/old.txt = "a"; round 1 fake exec writes src/new.txt
  // (risk low → passed_no_review); append ## Fix 1; --fix 1 fake exec echo b > src/old.txt → the fix diff
  // contains -a and +b for src/old.txt (not a whole-file add).
  {
    resetRepo();
    const srcDir = path.join(tempRepo, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "old.txt"), "a\n", "utf8");
    spawnSync("git", ["add", "src/old.txt"], { cwd: tempRepo, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "commit src/old.txt"], { cwd: tempRepo, stdio: "ignore" });

    const cardW = `# test-task — test card

## Goal
Test fix with dir.

## Risk
low

## Files
may change: \`src/\` / read-only: \`data/\`

## Steps (N = 1)
1. Step 1.

## Check
\`node -e "process.exit(0)"\`

## Don't
Run scripts in the foreground and wait
Reuse existing functions
No rm, no git push
`;
    fs.writeFileSync(cardPath, cardW, "utf8");

    const envW1 = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo new > src/new.txt; echo 'STATUS: done'"
    };
    delete envW1.ORCH_RUNNER_FAKE_REVIEW;

    const resW1 = runCard("case-w", { env: envW1 });
    assert.strictEqual(resW1.status, 0, `Case W1 exit status was ${resW1.status}: ${resW1.stderr}`);
    const stateW1 = readState("case-w");
    assert.strictEqual(stateW1.outcome, "passed_no_review");

    fs.appendFileSync(cardPath, "\n## Fix 1\n1. Fix step.\n", "utf8");

    const envW2 = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo b > src/old.txt; echo 'STATUS: done'"
    };
    delete envW2.ORCH_RUNNER_FAKE_REVIEW;

    const resW2 = runCard("case-w", { args: ["--fix", "1"], env: envW2 });
    assert.strictEqual(resW2.status, 0, `Case W2 exit status was ${resW2.status}: ${resW2.stderr}`);
    const stateW2 = readState("case-w");
    assert.strictEqual(stateW2.outcome, "fix_passed");

    const diffFile = path.join(tempLive, "orch-runner", "case-w.fix1.diff");
    assert.ok(fs.existsSync(diffFile), "diff file should exist");
    const diffText = fs.readFileSync(diffFile, "utf8");
    assert.ok(diffText.includes("-a") && diffText.includes("+b"), `diff should contain -a and +b, got: ${diffText}`);
    passedCount++;
  }

  // Case X: card Files may change: `src/`; src/old.txt committed = "a\n", src/big.bin (2 MiB, git-ignored) written but
  // not committed; round 1 → passed_no_review; append ## Fix 1; --fix 1 appends to src/big.bin → the base dir has no
  // src/big.bin copy (stat-only), and the diff lists src/big.bin as a changed large/ignored file.
  {
    resetRepo();
    const srcDirX = path.join(tempRepo, "src");
    fs.mkdirSync(srcDirX, { recursive: true });
    fs.writeFileSync(path.join(srcDirX, "old.txt"), "a\n", "utf8");
    fs.writeFileSync(path.join(srcDirX, "big.bin"), "x".repeat(2 * 1024 * 1024), "utf8");
    fs.writeFileSync(path.join(tempRepo, ".gitignore"), "src/big.bin\n", "utf8");
    spawnSync("git", ["add", "src/old.txt", ".gitignore"], { cwd: tempRepo, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "commit src/old.txt and .gitignore"], { cwd: tempRepo, stdio: "ignore" });

    const cardX = `# test-task — test card

## Goal
Test fix base with a large git-ignored file.

## Risk
low

## Files
may change: \`src/\` / read-only: \`data/\`

## Steps (N = 1)
1. Step 1.

## Check
\`node -e "process.exit(0)"\`

## Don't
Run scripts in the foreground and wait
Reuse existing functions
No rm, no git push
`;
    fs.writeFileSync(cardPath, cardX, "utf8");

    const envX1 = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo new > src/new.txt; echo 'STATUS: done'"
    };
    delete envX1.ORCH_RUNNER_FAKE_REVIEW;

    const resX1 = runCard("case-x", { env: envX1 });
    assert.strictEqual(resX1.status, 0, `Case X1 exit status was ${resX1.status}: ${resX1.stderr}`);
    const stateX1 = readState("case-x");
    assert.strictEqual(stateX1.outcome, "passed_no_review");

    fs.appendFileSync(cardPath, "\n## Fix 1\n1. Fix step.\n", "utf8");

    const envX2 = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo b > src/old.txt; echo y >> src/big.bin; echo 'STATUS: done'"
    };
    delete envX2.ORCH_RUNNER_FAKE_REVIEW;

    const resX2 = runCard("case-x", { args: ["--fix", "1"], env: envX2 });
    assert.strictEqual(resX2.status, 0, `Case X2 exit status was ${resX2.status}: ${resX2.stderr}`);
    const stateX2 = readState("case-x");
    assert.strictEqual(stateX2.outcome, "fix_passed");

    const baseBig = path.join(tempLive, "orch-runner", "case-x.fix1.base", "src/big.bin");
    assert.strictEqual(fs.existsSync(baseBig), false, "src/big.bin should not be copied into the base dir");

    const diffFile = path.join(tempLive, "orch-runner", "case-x.fix1.diff");
    assert.ok(fs.existsSync(diffFile), "diff file should exist");
    const diffText = fs.readFileSync(diffFile, "utf8");
    assert.ok(diffText.includes("-a") && diffText.includes("+b"), `diff should contain -a and +b, got: ${diffText}`);
    assert.ok(diffText.includes("# large or ignored file changed (not diffed): src/big.bin"), `diff should list src/big.bin, got: ${diffText}`);
    passedCount++;
  }

  // Case Y: agy-fallback "on" + --executor agy, risk medium, fake codebuddy for exec, ORCH_RUNNER_FAKE_REVIEW for review:
  // review_pass, exactly 1 codebuddy call with --model deepseek-v4.1-flash, state.execViaWb === true, state.review.model === "gpt-6-luna".
  {
    resetRepo();
    fs.writeFileSync(`${tempLive}/agy-fallback`, "on\n");
    writeCard(undefined, "medium");
    const envY = {
      ...wbEnv,
      ORCH_RUNNER_FAKE_REVIEW: "printf 'VERDICT: PASS\\n' > docs/orch/t/review.md"
    };
    const resY = runCard("case-y", { risk: "medium", env: envY, args: ["--executor", "agy"] });

    assert.strictEqual(resY.status, 0, `Case Y exit status was ${resY.status}: ${resY.stderr}`);
    const stateY = readState("case-y");
    assert.strictEqual(stateY.outcome, "review_pass");
    assert.strictEqual(stateY.exec.status, "done");
    assert.strictEqual(stateY.execViaWb, true);
    assert.strictEqual(stateY.review.model, "gpt-6-luna");
    const reviewY = fs.readFileSync(path.join(tempRepo, "docs/orch/t/review.md"), "utf8").split(/\r?\n/)[0].trim();
    assert.strictEqual(reviewY, "VERDICT: PASS");
    const argvY = fs.readFileSync(`${fakeBin}/argv`, "utf8").trim().split("\n");
    assert.strictEqual(argvY.length, 1, `expected 1 codebuddy call, got: ${argvY.join(" | ")}`);
    assert.ok(argvY[0].includes("--model deepseek-v4.1-flash"), `codebuddy argv lacks the model: ${argvY[0]}`);
    fs.rmSync(`${fakeBin}/argv`, { force: true });
    fs.rmSync(`${tempLive}/agy-fallback`, { force: true });
    passedCount++;
  }

  // Case Z (--executor wb, switch off): risk low → the fake codebuddy exec replies STATUS: done → passed_no_review.
  {
    resetRepo();
    writeCard();
    const resZ = runCard("case-z", { env: wbEnv, args: ["--executor", "wb"] });

    assert.strictEqual(resZ.status, 0, `Case Z exit status was ${resZ.status}: ${resZ.stderr}`);
    const stateZ = readState("case-z");
    assert.strictEqual(stateZ.outcome, "passed_no_review");
    assert.strictEqual(stateZ.exec.status, "done");
    passedCount++;
  }

  // Case Q: --executor luna with the codex-full quota script and no fallback file: exit 2, stderr has
  // codex quota used up (5h 100%, 7d 40% and pick another executor, no state file.
  {
    resetRepo();
    writeCard(undefined, "medium");
    fs.writeFileSync(`${tempLive}/quota-full.mjs`, 'console.log(JSON.stringify({ codex: { five: { pct: 100, resetMs: Date.now() + 3600000 }, week: { pct: 40, resetMs: Date.now() + 86400000 } } }))', "utf8");
    const envQ = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 3 > a.txt; echo 'STATUS: done'",
      ORCH_RUNNER_FAKE_REVIEW: "printf 'VERDICT: PASS\\n' > docs/orch/t/review.md",
      ORCH_QUOTA_SCRIPT: `${tempLive}/quota-full.mjs`
    };
    fs.rmSync(`${tempLive}/agy-fallback`, { force: true });

    const res = runCard("case-q", { risk: "medium", env: envQ, args: ["--executor", "luna"] });

    assert.strictEqual(res.status, 2, `Case Q exit status was ${res.status}: ${res.stderr}`);
    assert.ok(res.stderr.includes("codex quota used up (5h 100%, 7d 40%"), `Case Q stderr should carry the quota line: ${res.stderr}`);
    assert.ok(res.stderr.includes("pick another executor"), `Case Q stderr should mention picking another executor: ${res.stderr}`);
    const stateFileQ = path.join(tempLive, "orch-runner", "case-q.json");
    assert.strictEqual(fs.existsSync(stateFileQ), false, "State file must not exist for case-q");
    passedCount++;
  }

  // Case Q2: --executor agy (fake exec), risk medium, codex-full quota script: exit 0, outcome review_pending,
  // review.verdict === "pending", the fake review never ran (its marker file absent), summary stdout contains review: pending.
  {
    resetRepo();
    writeCard(undefined, "medium");
    const marker = path.join(tempLive, "q2-review-ran").replaceAll("\\", "/");
    fs.rmSync(marker, { force: true });
    const envQ2 = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 3 > a.txt; echo 'STATUS: done'",
      ORCH_RUNNER_FAKE_REVIEW: `node -e "require('fs').writeFileSync('${marker}','')"; printf 'VERDICT: PASS\\n' > docs/orch/t/review.md`,
      ORCH_QUOTA_SCRIPT: `${tempLive}/quota-full.mjs`
    };

    const res2 = runCard("case-q2", { risk: "medium", env: envQ2, args: ["--executor", "agy"] });

    assert.strictEqual(res2.status, 0, `Case Q2 exit status was ${res2.status}: ${res2.stderr}`);
    const stateQ2 = readState("case-q2");
    assert.strictEqual(stateQ2.outcome, "review_pending");
    assert.strictEqual(stateQ2.review.verdict, "pending");
    assert.strictEqual(fs.existsSync(marker), false, "fake review must not run when codex quota is full");
    assert.ok(res2.stdout.includes("review: pending"), `stdout should contain 'review: pending', got: ${res2.stdout}`);
    passedCount++;
  }

  // Case Q3: risk medium, quota script missing, ORCH_RUNNER_FAKE_REVIEW = echo 'Error: usage limit reached'; exit 1:
  // outcome review_pending.
  {
    resetRepo();
    writeCard(undefined, "medium");
    const envQ3 = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 3 > a.txt; echo 'STATUS: done'",
      ORCH_RUNNER_FAKE_REVIEW: "echo 'Error: usage limit reached'; exit 1",
      ORCH_QUOTA_SCRIPT: `${tempLive}/missing-quota.mjs`
    };

    const res3 = runCard("case-q3", { risk: "medium", env: envQ3, args: ["--executor", "agy"] });

    assert.strictEqual(res3.status, 0, `Case Q3 exit status was ${res3.status}: ${res3.stderr}`);
    const stateQ3 = readState("case-q3");
    assert.strictEqual(stateQ3.outcome, "review_pending");
    passedCount++;
  }

  // Case Q4 (new): agy-fallback absent (= auto), quota script reporting antigravity 5h at 100% and codex at 10%,
  // --executor agy, risk low, fake codebuddy exec: state.execViaWb === true, 1 codebuddy call.
  {
    resetRepo();
    writeCard();
    fs.rmSync(`${tempLive}/agy-fallback`, { force: true });
    fs.rmSync(`${fakeBin}/argv`, { force: true });
    fs.writeFileSync(`${tempLive}/quota-agy-full.mjs`, 'console.log(JSON.stringify({ antigravity: { five: { pct: 100, resetMs: Date.now() + 3600000 }, week: { pct: 20, resetMs: Date.now() + 86400000 } }, codex: { five: { pct: 10, resetMs: Date.now() + 3600000 }, week: { pct: 10, resetMs: Date.now() + 86400000 } } }))', "utf8");
    const envQ4 = {
      ...wbEnv,
      ORCH_QUOTA_SCRIPT: `${tempLive}/quota-agy-full.mjs`
    };
    delete envQ4.ORCH_RUNNER_FAKE_EXEC;
    delete envQ4.ORCH_RUNNER_FAKE_REVIEW;

    const res4 = runCard("case-q4", { risk: "low", env: envQ4, args: ["--executor", "agy"] });

    assert.strictEqual(res4.status, 0, `Case Q4 exit status was ${res4.status}: ${res4.stderr}`);
    const stateQ4 = readState("case-q4");
    assert.strictEqual(stateQ4.execViaWb, true);
    assert.strictEqual(stateQ4.outcome, "passed_no_review");
    const argvQ4 = fs.readFileSync(`${fakeBin}/argv`, "utf8").trim().split("\n");
    assert.strictEqual(argvQ4.length, 1, `expected 1 codebuddy call, got: ${argvQ4.join(" | ")}`);
    fs.rmSync(`${fakeBin}/argv`, { force: true });
    passedCount++;
  }

  // Case Q5 (new): risk high, --reviewer luna, fake exec + fake review PASS:
  // state.review.model === "gpt-6.1-sol", state.review.raised === true, summary contains floor sol.
  {
    resetRepo();
    writeCard(undefined, "high");
    const envQ5 = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo 3 > a.txt; echo 'STATUS: done'",
      ORCH_RUNNER_FAKE_REVIEW: "printf 'VERDICT: PASS\\n' > docs/orch/t/review.md"
    };

    const res5 = runCard("case-q5", { risk: "high", env: envQ5, args: ["--reviewer", "luna"] });

    assert.strictEqual(res5.status, 0, `Case Q5 exit status was ${res5.status}: ${res5.stderr}`);
    const stateQ5 = readState("case-q5");
    assert.strictEqual(stateQ5.review.model, "gpt-6.1-sol");
    assert.strictEqual(stateQ5.review.raised, true);
    assert.ok(res5.stdout.includes("floor sol"), `stdout should contain 'floor sol', got: ${res5.stdout}`);
    passedCount++;
  }

  if (passedCount === 32) {
    console.log("32/32 passed");
    process.exitCode = 0;
  } else {
    console.error(`Only ${passedCount}/32 passed`);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(tempRepo, { recursive: true, force: true });
  fs.rmSync(tempLive, { recursive: true, force: true });
  if (fakeBin) fs.rmSync(fakeBin, { recursive: true, force: true });
}
