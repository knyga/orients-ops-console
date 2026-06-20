/**
 * CLI: ingest AUTHORIZED approvers' in-thread replies to published verdicts and
 * record their override — DRY-RUN BY DEFAULT. For each posted verdict it reads
 * the threaded replies from the local Slack mirror, keeps only those authored by
 * an approver (lib/approvers), classifies each as approve/disapprove via Claude,
 * and (with --write) writes a resolution: approve → accepted_exception, disapprove
 * → rejected. The next `field-verdict` run reflects it (ACCEPTED_EXCEPTION / REJECTED).
 *
 * Usage:
 *   npm run field-approvals -- --start 2026-06-01 --end 2026-06-19          # dry-run
 *   npm run field-approvals -- --start … --end … --write                   # apply overrides
 * Defaults to the current Europe/Kyiv month. Run `npm run slack-sync` first so the
 * approver replies are mirrored. Classification needs ANTHROPIC_API_KEY.
 *
 * Runs under `--conditions=react-server` so the server-only imports resolve.
 */
import { classifyApproval } from "../lib/approvalClassify";
import { approverFor } from "../lib/approvers";
import { readChannelMessages } from "../lib/slackMirror";
import { readPublished } from "../lib/published";
import { upsertResolution } from "../lib/resolutions";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import {
  decideApproval,
  parseArgs,
  resolvePeriod,
  type ApproverReply,
  type Period,
} from "./fieldApprovalsReport";

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }

  const args = parseArgs(process.argv.slice(2));
  const today = todayInFieldTz();
  const period: Period = resolvePeriod(args, today);

  const published = readPublished(period);
  const entries = Object.values(published);
  if (entries.length === 0) {
    process.stderr.write(`field-approvals: no published verdicts for ${period.start}…${period.end} (run \`npm run field-publish --publish\` first).\n`);
    return;
  }

  let applied = 0;

  for (const entry of entries) {
    // Threaded replies to the bot's verdict (exclude the verdict itself + tombstones).
    const replies = readChannelMessages(entry.channel, period).filter(
      (m) => m.thread_ts === entry.ts && m.ts !== entry.ts && !m.deleted,
    );
    if (replies.length === 0) continue;

    const approverReplies: ApproverReply[] = [];
    for (const r of replies) {
      const approver = approverFor(r.authorId);
      if (!approver) {
        console.log(`• ${entry.date} — ignoring reply from non-approver ${r.author}.`);
        continue;
      }
      const classification = await classifyApproval(entry.text, r.text);
      approverReplies.push({ classification, by: approver.name, permalink: r.permalink, ts: r.ts });
      console.log(`• ${entry.date} ← ${approver.name}: "${r.text.slice(0, 80)}" → ${classification.decision}`);
    }

    const outcome = decideApproval(approverReplies);
    if (!outcome) continue;

    const decision = outcome.decision === "approve" ? "accepted_exception" : "rejected";
    console.log(
      `  ⇒ ${args.write ? "applying" : "would apply"}: ${entry.date} → ${decision} by ${outcome.by} — ${outcome.reason}`,
    );

    if (args.write) {
      upsertResolution({
        date: entry.date,
        decision,
        note: outcome.reason,
        source: outcome.evidencePermalink || "slack",
        recordedAt: new Date().toISOString(),
        by: outcome.by,
      });
      applied += 1;
    }
  }

  if (args.write) {
    process.stderr.write(`field-approvals: wrote ${applied} resolution(s). Re-run \`npm run field-verdict -- --write\` to reflect them.\n`);
  } else {
    process.stderr.write("field-approvals: DRY RUN — no resolutions written. Re-run with --write to apply.\n");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-approvals: ${message}\n`);
  process.exit(1);
});
