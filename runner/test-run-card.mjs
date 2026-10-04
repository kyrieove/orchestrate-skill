import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runCardScript = path.resolve(__dirname, "run-card.mjs").replaceAll("\\", "/");

const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-repo-")).replaceAll("\\", "/");
const tempLive = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-live-")).replaceAll("\\", "/");

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
    ORCH_RUNNER_LIVE_DIR: tempLive
  };

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

    const res = spawnSync(process.execPath, [
      runCardScript,
      "--card", cardPath,
      "--name", "case-a",
      "--executor", "agy",
      "--risk", "low",
      "--repo", tempRepo
    ], { env: envA, encoding: "utf8" });

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

    const res = spawnSync(process.execPath, [
      runCardScript,
      "--card", cardPath,
      "--name", "case-b",
      "--executor", "agy",
      "--risk", "low",
      "--repo", tempRepo
    ], { env: envB, encoding: "utf8" });

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

    const res = spawnSync(process.execPath, [
      runCardScript,
      "--card", cardPath,
      "--name", "case-c",
      "--executor", "agy",
      "--risk", "low",
      "--repo", tempRepo
    ], { env: envC, encoding: "utf8" });

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

    const res = spawnSync(process.execPath, [
      runCardScript,
      "--card", cardPath,
      "--name", "case-d",
      "--executor", "agy",
      "--risk", "low",
      "--repo", tempRepo
    ], { env: envD, encoding: "utf8" });

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
    const res = spawnSync(process.execPath, [
      runCardScript,
      "--card", cardPath,
      "--name", "case-e",
      "--executor", "agy",
      "--risk", "low",
      "--repo", tempRepo,
      "--timeout-min", "0.05"
    ], { env: envE, encoding: "utf8" });

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

    const res1 = spawnSync(process.execPath, [
      runCardScript,
      "--card", cardPath,
      "--name", "case-f-stale",
      "--executor", "agy",
      "--risk", "medium",
      "--repo", tempRepo
    ], { env: envF1, encoding: "utf8" });

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

    const res = spawnSync(process.execPath, [
      runCardScript,
      "--card", cardPath,
      "--name", "case-f",
      "--executor", "agy",
      "--risk", "medium",
      "--repo", tempRepo
    ], { env: envF, encoding: "utf8" });

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

    const res = spawnSync(process.execPath, [
      runCardScript,
      "--card", cardPath,
      "--name", "case-g",
      "--executor", "agy",
      "--risk", "low",
      "--repo", tempRepo
    ], { env: baseEnv, encoding: "utf8" });

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

    const res = spawnSync(process.execPath, [
      runCardScript,
      "--card", cardPath,
      "--name", "case-h",
      "--executor", "agy",
      "--risk", "low",
      "--repo", tempRepo
    ], { env: baseEnv, encoding: "utf8" });

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

    const res = spawnSync(process.execPath, [
      runCardScript,
      "--card", cardPath,
      "--name", "case-i",
      "--executor", "agy",
      "--risk", "low",
      "--repo", tempRepo
    ], { env: envI, encoding: "utf8" });

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

    const res = spawnSync(process.execPath, [
      runCardScript,
      "--card", cardPath,
      "--name", "case-j",
      "--executor", "agy",
      "--risk", "low",
      "--repo", tempRepo
    ], { env: envJ, encoding: "utf8" });

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

    const res = spawnSync(process.execPath, [
      runCardScript,
      "--recon",
      "--card", cardPath,
      "--name", "case-k",
      "--executor", "agy",
      "--risk", "low",
      "--repo", tempRepo
    ], { env: envK, encoding: "utf8" });

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

    const res = spawnSync(process.execPath, [
      runCardScript,
      "--card", cardPath,
      "--name", "case-l",
      "--executor", "agy",
      "--risk", "medium",
      "--repo", tempRepo
    ], { env: envL, encoding: "utf8" });

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

    const resM1 = spawnSync(process.execPath, [
      runCardScript,
      "--card", cardPath,
      "--name", "case-m",
      "--executor", "agy",
      "--risk", "low",
      "--repo", tempRepo
    ], { env: envM1, encoding: "utf8" });

    assert.strictEqual(resM1.status, 0, `Case M (round 1) exit status was ${resM1.status}: ${resM1.stderr}`);
    const stateM1 = readState("case-m");
    assert.strictEqual(stateM1.outcome, "passed_no_review");
    const cardM1 = fs.readFileSync(cardPath, "utf8");
    assert.ok(cardM1.includes("## Acceptance (draft)"), "Card should get ## Acceptance (draft)");

    fs.appendFileSync(cardPath, "\n## Fix 1\n1. Fix step.\n", "utf8");

    const envM2 = {
      ...baseEnv,
      ORCH_RUNNER_FAKE_EXEC: "echo y > b.txt; echo 'STATUS: done'"
    };
    delete envM2.ORCH_RUNNER_FAKE_REVIEW;

    const resM2 = spawnSync(process.execPath, [
      runCardScript,
      "--fix", "1",
      "--card", cardPath,
      "--name", "case-m",
      "--repo", tempRepo
    ], { env: envM2, encoding: "utf8" });

    assert.strictEqual(resM2.status, 0, `Case M (fix 1) exit status was ${resM2.status}: ${resM2.stderr}`);
    const stateM2 = readState("case-m");
    assert.strictEqual(stateM2.outcome, "fix_passed");
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
    const resN1 = spawnSync(process.execPath, [
      runCardScript,
      "--fix", "3",
      "--card", cardPath,
      "--name", "case-m",
      "--repo", tempRepo
    ], { env: baseEnv, encoding: "utf8" });
    assert.strictEqual(resN1.status, 2, `Expected exit 2 for --fix 3, got ${resN1.status}`);

    const resN2 = spawnSync(process.execPath, [
      runCardScript,
      "--fix", "1",
      "--card", cardPath,
      "--name", "non-existent-name",
      "--repo", tempRepo
    ], { env: baseEnv, encoding: "utf8" });
    assert.strictEqual(resN2.status, 2, `Expected exit 2 for fresh name with no state file, got ${resN2.status}`);
    passedCount++;
  }

  // Case O (commit): after M, --commit refuses (exit 2) while the draft heading is there; then replace the draft section
  // by ## Acceptance + - verdict: accepted, create an unrelated untracked z.txt, run --commit --message t
  // → exit 0 and git show --name-only --format= HEAD lists exactly a.txt, b.txt, docs/orch/t/card.md.
  {
    const resO1 = spawnSync(process.execPath, [
      runCardScript,
      "--commit",
      "--name", "case-m",
      "--message", "t"
    ], { env: baseEnv, encoding: "utf8" });
    assert.strictEqual(resO1.status, 2, `Expected exit 2 while draft heading is present, got ${resO1.status}`);

    const cardContent = fs.readFileSync(cardPath, "utf8");
    const withoutDraft = cardContent.replace(/##\s+Acceptance\s+\(draft\)[\s\S]*$/, "").trimEnd();
    fs.writeFileSync(cardPath, `${withoutDraft}\n\n## Acceptance\n- verdict: accepted\n`, "utf8");

    fs.writeFileSync(path.join(tempRepo, "z.txt"), "unrelated untracked", "utf8");

    const resO2 = spawnSync(process.execPath, [
      runCardScript,
      "--commit",
      "--name", "case-m",
      "--message", "t"
    ], { env: baseEnv, encoding: "utf8" });
    assert.strictEqual(resO2.status, 0, `Expected exit 0 for --commit, got ${resO2.status}: ${resO2.stderr}`);

    const showRes = spawnSync("git", ["-C", tempRepo, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" });
    assert.strictEqual(showRes.status, 0);
    const committedFiles = showRes.stdout.trim().split(/\r?\n/).filter(Boolean).sort();
    assert.deepStrictEqual(committedFiles, ["a.txt", "b.txt", "docs/orch/t/card.md"]);
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

  if (passedCount === 16) {
    console.log("16/16 passed");
    process.exitCode = 0;
  } else {
    console.error(`Only ${passedCount}/16 passed`);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(tempRepo, { recursive: true, force: true });
  fs.rmSync(tempLive, { recursive: true, force: true });
}
