/**
 * CLI: apply AUTHORIZED approvers' data-overwrite instructions to published
 * verdicts — DRY-RUN BY DEFAULT. Two modes:
 *
 *  SWEEP (default): scan each published verdict thread in the window, classify
 *  every approver reply via Claude, and apply the LAST decisive instruction per
 *  day (crew / eligibility / day / dataset / video / airborne). The operator
 *  running --write IS the confirmation, so it applies directly (no two-phase).
 *
 *  MANUAL (--date D + one of --set-crew/--add-crew/--remove-crew/--airborne/
 *  --accept/--reject): apply one specific correction the approver decided out of
 *  band. Used to clear a day the thread never stated as a clean instruction.
 *
 * Usage:
 *   npm run field-instructions -- --start 2026-06-01 --end 2026-06-30          # dry-run sweep
 *   npm run field-instructions -- --start … --end … --write                    # apply sweep
 *   npm run field-instructions -- --date 2026-06-25 --set-crew "Влад,Тарас" --by "Oleksandr K" --write
 * Defaults to the current Kyiv month. Run `npm run slack-sync` first.
 * Classification needs ANTHROPIC_API_KEY. Runs under --conditions=react-server.
 */
import { classifyInstruction } from "../lib/instructionClassify";
import { applyInstruction } from "../lib/applyInstruction";
import { approverFor, APPROVERS } from "../lib/approvers";
import { readChannelMessages } from "../lib/slackMirror";
import { readPublished } from "../lib/published";
import { readProposalsInWindow } from "../lib/proposals";
import { permalinkFor } from "../lib/slack";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import {
  buildManualInstruction,
  filterEntriesToWindow,
  parseArgs,
  resolvePeriod,
  type Period,
} from "./fieldInstructionsReport";
import { renderProposalSummary } from "../lib/proposalSummary";
import type { InstructionAxis, InstructionClassification } from "../lib/instructionClassifyPrompt";

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }

  const args = parseArgs(process.argv.slice(2));
  const today = todayInFieldTz();
  const period: Period = resolvePeriod(args, today);
  const by = args.by ?? APPROVERS[0].name;

  const published = await readPublished(period);
  const entries = filterEntriesToWindow(Object.values(published), period.start, period.end);

  // --list: show pending proposals + published days in the window (read-only).
  if (args.list) {
    const proposals = await readProposalsInWindow(period.start, period.end);
    process.stdout.write(JSON.stringify({ period, proposals, published: entries.map((e) => ({ date: e.date, channel: e.channel })) }, null, 2) + "\n");
    return;
  }

  if (entries.length === 0) {
    process.stderr.write(`field-instructions: no published verdicts for ${period.start}…${period.end}.\n`);
    return;
  }

  // MANUAL mode — a single explicit correction for --date.
  const manual = buildManualInstruction(args);
  if (args.date && manual) {
    const entry = entries.find((e) => e.date === args.date);
    if (!entry) { process.stderr.write(`field-instructions: no published verdict for ${args.date}.\n`); return; }
    process.stdout.write(`• ${args.date} ⇒ ${args.write ? "applying" : "would apply"}: ${renderProposalSummary(args.date, manual.instruction)} (by ${by})\n`);
    if (args.write) {
      const res = await applyInstruction({ entry, period, axis: manual.axis, instruction: manual.instruction, by, evidence: "manual", trigger: "cli" });
      process.stderr.write(`field-instructions: ${res.applied ? "applied" : "no change"} for ${args.date}.\n`);
    } else {
      process.stderr.write("field-instructions: DRY RUN — re-run with --write to apply.\n");
    }
    return;
  }

  // SWEEP mode — classify approver replies in each verdict thread.
  const readWindow = { start: period.start, end: today > period.end ? today : period.end };
  let applied = 0;
  for (const entry of entries) {
    const replies = (await readChannelMessages(entry.channel, readWindow)).filter(
      (m) => m.thread_ts === entry.ts && m.ts !== entry.ts && !m.deleted,
    );
    if (replies.length === 0) continue;

    // The last decisive (intent=instruction) approver reply wins for the day.
    let chosen: { axis: InstructionAxis; instruction: InstructionClassification; permalink: string } | null = null;
    for (const r of replies) {
      const approver = approverFor(r.authorId);
      if (!approver) { console.log(`• ${entry.date} — ignoring reply from non-approver ${r.author}.`); continue; }
      const c = await classifyInstruction(entry.text, r.text, null);
      console.log(`• ${entry.date} ← ${approver.name}: "${r.text.slice(0, 70)}" → ${c.intent}${c.axis ? `/${c.axis}` : ""}`);
      if (c.intent === "instruction" && c.axis) chosen = { axis: c.axis, instruction: c, permalink: permalinkFor(entry.channel, r.ts) };
    }
    if (!chosen) continue;

    process.stdout.write(`  ⇒ ${args.write ? "applying" : "would apply"}: ${entry.date} → ${renderProposalSummary(entry.date, chosen.instruction)}\n`);
    if (args.write) {
      const res = await applyInstruction({ entry, period, axis: chosen.axis, instruction: chosen.instruction, by, evidence: chosen.permalink, trigger: "cli" });
      if (res.applied) applied += 1;
    }
  }

  if (args.write) process.stderr.write(`field-instructions: applied ${applied} instruction(s). Re-run \`npm run field-verdict -- --write\` + \`npm run field-bonus\` to reflect them.\n`);
  else process.stderr.write("field-instructions: DRY RUN — nothing written. Re-run with --write to apply.\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-instructions: ${message}\n`);
  process.exit(1);
});
