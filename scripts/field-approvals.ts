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
import { postMessage, updateMessage } from "../lib/slack";
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { readChannelMessages } from "../lib/slackMirror";
import { readPublished, recordPublished, writePublished } from "../lib/published";
import { upsertResolution } from "../lib/resolutions";
import { formatOverride } from "../lib/verdictPublish";
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

  let published = await readPublished(period); // mutated as overrides are acknowledged
  const entries = Object.values(published);
  if (entries.length === 0) {
    process.stderr.write(`field-approvals: no published verdicts for ${period.start}…${period.end} (run \`npm run field-publish --publish\` first).\n`);
    return;
  }

  let applied = 0;

  // Verdicts are posted AND replied to after the flight period (the bot posts
  // "now", approvers reply later), so read the channel through today — not the
  // flight period — or every reply gets filtered out by date.
  const readWindow = { start: period.start, end: today > period.end ? today : period.end };

  for (const entry of entries) {
    // Threaded replies to the bot's verdict (exclude the verdict itself + tombstones).
    const replies = (await readChannelMessages(entry.channel, readWindow)).filter(
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

    // Idempotent ack: skip if this same decision was already acknowledged (edited
    // + replied). A changed decision re-acks (striking the ORIGINAL text again).
    const alreadyAcked = entry.override?.decision === decision;
    console.log(
      `  ⇒ ${args.write ? "applying" : "would apply"}: ${entry.date} → ${decision} by ${outcome.by} — ${outcome.reason}` +
        (alreadyAcked ? "  (already acknowledged — skipping)" : ""),
    );
    if (alreadyAcked) continue;

    if (args.write) {
      await upsertResolution({
        date: entry.date,
        decision,
        note: outcome.reason,
        source: outcome.evidencePermalink || "slack",
        recordedAt: new Date().toISOString(),
        by: outcome.by,
      });

      // Acknowledge in Slack: amend the original verdict (strike + new state) and
      // post a threaded confirmation. entry.text is the ORIGINAL posted verdict.
      const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
      if (channel) {
        const { updatedText, replyText } = formatOverride(entry.text, decision, outcome.by, outcome.reason);
        await updateMessage(channel.id, entry.ts, updatedText);
        await postMessage(channel.id, replyText, entry.ts);
        published = recordPublished(published, {
          ...entry,
          override: { decision, by: outcome.by, ackedAt: new Date().toISOString() },
        });
        process.stderr.write(`field-approvals: amended + acknowledged ${entry.date} in #${channel.name}.\n`);
      } else {
        process.stderr.write(`field-approvals: channel "${entry.channel}" not tracked — wrote resolution but could not edit/reply.\n`);
      }
      applied += 1;
    }
  }

  if (args.write) {
    await writePublished(period, published);
    process.stderr.write(`field-approvals: applied ${applied} override(s). Re-run \`npm run field-verdict -- --write\` to reflect them.\n`);
  } else {
    process.stderr.write("field-approvals: DRY RUN — no resolutions written, no messages edited. Re-run with --write to apply.\n");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-approvals: ${message}\n`);
  process.exit(1);
});
