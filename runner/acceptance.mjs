import fs from "node:fs";

export const k = (n) => `${Math.round(n / 1000)}k`;

export function formatLedgerLines(ledger, sep = "\n") {
  if (!Array.isArray(ledger) || ledger.length === 0) return "n/a";
  return ledger
    .map((item) => `${item.role} ${item.model}: fresh ${k(item.fresh)}, cached ${k(item.cached)}, out ${k(item.out)}  (${item.file})`)
    .join(sep);
}

export function appendAcceptanceDraft(ctx) {
  const { state, cardAbs, check, risk } = ctx;

  const draftOutcomes = new Set(["review_pass", "passed_no_review", "fix_passed", "recon_done", "review_pending", "review_fail", "check_failed"]);
  if (draftOutcomes.has(state.outcome)) {
    const currentCardText = fs.readFileSync(cardAbs, "utf8");
    const cLines = currentCardText.split(/\r?\n/);
    const keptLines = [];
    let inDraft = false;
    for (const line of cLines) {
      if (/^##\s+Acceptance\s+\(draft\)\s*$/i.test(line.trim())) {
        inDraft = true;
        continue;
      }
      if (inDraft) {
        if (/^##\s+/.test(line)) {
          inDraft = false;
          keptLines.push(line);
        }
        continue;
      }
      keptLines.push(line);
    }
    const cleanCardText = keptLines.join("\n").trimEnd();

    const allTouched = state.allTouched || (state.rounds ? state.rounds.flatMap((r) => r.touched || []) : state.touched) || [];
    const allTouchedList = allTouched.length > 0 ? allTouched.join(", ") : "-";
    const checkExitVal = state.checkResult?.exit !== null && state.checkResult?.exit !== undefined ? state.checkResult.exit : 0;
    const checkLine = check ? `- check: \`${check}\` → exit ${checkExitVal} (run by run-card)` : "- check: -";

    const tokenLines = [];
    if (state.rounds && state.rounds.length > 0) {
      for (const r of state.rounds) {
        const roundLabel = (r.round === "1" || r.round === "round 1") ? "round 1" : r.round;
        tokenLines.push(`  - ${roundLabel}: ${formatLedgerLines(r.ledger, " · ")}`);
      }
    } else {
      tokenLines.push(`  - round 1: ${formatLedgerLines(state.ledger, " · ")}`);
    }

    const reviewerStr = state.review?.model || "no review";
    const verdictLine = state.outcome === "review_pending"
      ? "- verdict: review pending (codex quota used up) — TODO accept provisionally"
      : "- verdict: TODO (accepted / review pending / rejected)";
    const draftSection = [
      "## Acceptance (draft)",
      verdictLine,
      `- files: ${allTouchedList}`,
      checkLine,
      "- tokens:",
      ...tokenLines,
      `- review findings: TODO N real / M false positive / K missed (${risk}, ${reviewerStr})`
    ].join("\n");

    fs.writeFileSync(cardAbs, `${cleanCardText}\n\n${draftSection}\n`, "utf8");
  }
}
