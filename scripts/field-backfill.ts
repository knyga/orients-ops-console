/**
 * CLI: one-time backfill — rewrite already-published verdict messages to the
 * current Ukrainian format. DRY-RUN BY DEFAULT.
 *
 * Why: the Ukrainian-messages feature only changed FUTURE posts; verdicts posted
 * to #field-qa before it are still English. This re-renders each via the current
 * formatDayMessage and edits the existing Slack message (chat.update) in place.
 *
 * Usage:
 *   npm run field-backfill -- --start 2026-06-01 --end 2026-06-30                 # dry-run (prints, sends nothing)
 *   npm run field-backfill -- --start … --end … --channel field-qa --publish      # ACTUALLY edit (needs chat:write)
 * Defaults to the current Europe/Kyiv month.
 *
 * Safety (same posture as field-publish, the only other outward write):
 *  - dry-run is the default; a real edit needs explicit --publish.
 *  - --publish REQUIRES --channel <name>, and every update must target THAT
 *    channel (refuses on mismatch — no accidental cross-posting).
 *  - Idempotent: rewrites the stored text after each edit, so re-runs skip.
 *  - Overridden days are skipped (never clobber a struck approver amendment).
 *  - Reads the SAME DB-backed sources as field-publish (committed verdict report
 *    + published log), never a live recompute.
 *
 * Runs under `--conditions=react-server` so the server-only Slack import resolves.
 */
import { updateMessage } from "../lib/slack";
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { readReportJson, periodKey } from "../lib/reports";
import { readPublished, recordPublished, writePublished } from "../lib/published";
import { computeBackfillPlan } from "../lib/backfillPublished";
import { backfillEditKey, contentRev } from "../lib/outboundKeys";
import type { DayVerdict } from "../lib/fieldDayVerdict";
import { parseArgs, resolvePeriod, type Period } from "./fieldPublishReport";
import { formatDryRun } from "./fieldBackfillReport";

interface VerdictReport {
  days: DayVerdict[];
}

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
  const period: Period = resolvePeriod(args, todayInFieldTz());

  const report = await readReportJson<VerdictReport>("field-verdict", periodKey(period));
  if (!report) {
    process.stderr.write(
      `field-backfill: no committed field-verdict report for ${periodKey(period)} — run \`npm run field-verdict -- --start ${period.start} --end ${period.end} --write\` first.\n`,
    );
    process.exit(1);
  }

  const verdictByDate: Record<string, DayVerdict> = {};
  for (const d of report.days) verdictByDate[d.date] = d;

  const log = await readPublished(period);
  const plan = computeBackfillPlan(log, verdictByDate);
  const updates = plan.filter((p) => p.action === "update");

  // Dry-run (default): print what would change; write nothing.
  if (!args.publish) {
    console.log(formatDryRun(plan, args.channel, period));
    return;
  }

  // --- Real edit path (explicit --publish) ---
  if (!args.channel) {
    process.stderr.write("field-backfill: --publish requires --channel <name> (no default target).\n");
    process.exit(1);
  }
  const channel = TRACKED_CHANNELS.find((c) => c.name === args.channel);
  if (!channel) {
    process.stderr.write(
      `field-backfill: unknown channel "${args.channel}" (tracked: ${TRACKED_CHANNELS.map((c) => c.name).join(", ")}).\n`,
    );
    process.exit(1);
  }
  const wrongChannel = updates.filter((u) => u.channel !== channel.name);
  if (wrongChannel.length) {
    process.stderr.write(
      `field-backfill: ${wrongChannel.length} update(s) were posted to a different channel than --channel ${channel.name} ` +
        `(${[...new Set(wrongChannel.map((u) => u.channel))].join(", ")}). Refusing to edit across channels.\n`,
    );
    process.exit(1);
  }
  if (updates.length === 0) {
    process.stderr.write("field-backfill: nothing to update (all posts already current / skipped).\n");
    return;
  }

  let nextLog = log;
  let edited = 0;
  for (const u of updates) {
    await updateMessage(channel.id, u.ts, u.newText, {
      key: backfillEditKey(u.date, contentRev(u.newText)),
      feature: "verdict",
      channel: channel.name,
      trigger: "cli",
    });
    // Rewrite the stored text so a re-run is a no-op (idempotency).
    nextLog = recordPublished(nextLog, { ...log[u.date], text: u.newText });
    await writePublished(period, nextLog); // persist after each so a mid-run failure is not lost
    edited += 1;
    process.stderr.write(`field-backfill: updated ${u.date} in #${channel.name} (ts ${u.ts})\n`);
  }
  process.stderr.write(`field-backfill: updated ${edited} message(s) in #${channel.name}.\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-backfill: ${message}\n`);
  process.exit(1);
});
