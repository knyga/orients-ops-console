/**
 * CLI: publish per-flight-day verdicts to Slack — DRY-RUN BY DEFAULT.
 *
 * Usage:
 *   npm run field-publish -- --start 2026-06-01 --end 2026-06-19            # dry-run (prints, sends nothing)
 *   npm run field-publish -- --start … --end … --channel field-qa          # dry-run targeting a channel
 *   npm run field-publish -- --start … --end … --channel <test> --publish  # ACTUALLY POST (needs chat:write)
 * Defaults to the current Europe/Kyiv month.
 *
 * This is the ONLY outward-facing write in the console. Safety:
 *  - `--dry-run` is the default; a real post requires the explicit `--publish` flag.
 *  - `--publish` REQUIRES `--channel <name>` (a tracked channel) — no default target.
 *    Use a private test channel before #field-qa until the output is trusted.
 *  - Idempotent: already-posted days (reports/published/<period>.json) are skipped.
 *  - Reads the committed field-verdict artifact; posts only SETTLED verdicts
 *    (ACCEPTED / NEEDS_REVIEW / ACCEPTED_EXCEPTION), never PENDING.
 *
 * Runs under `--conditions=react-server` so the server-only Slack import resolves.
 */
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { readReportJson, periodKey } from "../lib/reports";
import { readPublished } from "../lib/published";
import { publishSettledDays } from "../lib/publishVerdicts";
import type { DayVerdict } from "../lib/fieldDayVerdict";
import {
  buildPlan,
  formatDryRun,
  parseArgs,
  resolvePeriod,
  type Period,
} from "./fieldPublishReport";

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
  const today = todayInFieldTz();
  const period: Period = resolvePeriod(args, today);

  const report = await readReportJson<VerdictReport>("field-verdict", periodKey(period));
  if (!report) {
    process.stderr.write(
      `field-publish: no committed field-verdict report for ${periodKey(period)} — run \`npm run field-verdict -- --start ${period.start} --end ${period.end} --write\` first.\n`,
    );
    process.exit(1);
  }

  const log = await readPublished(period);
  const plan = buildPlan(report.days, log);

  // Dry-run (default): print exactly what would be posted; write nothing.
  if (!args.publish) {
    console.log(formatDryRun(plan, args.channel, period));
    return;
  }

  // --- Real publish path (explicit --publish) ---
  if (!args.channel) {
    process.stderr.write("field-publish: --publish requires --channel <name> (no default target).\n");
    process.exit(1);
  }
  const channel = TRACKED_CHANNELS.find((c) => c.name === args.channel);
  if (!channel) {
    process.stderr.write(
      `field-publish: unknown channel "${args.channel}" (tracked: ${TRACKED_CHANNELS.map((c) => c.name).join(", ")}).\n`,
    );
    process.exit(1);
  }

  // The real-post loop is the shared lib/publishVerdicts (also used by the cron);
  // "cli" preserves the audit-log origin for hand-run publishes.
  const { posted, skipped } = await publishSettledDays(report.days, channel, period, {
    onLog: (m) => process.stderr.write(`${m}\n`),
    trigger: "cli",
  });
  if (posted.length === 0) {
    process.stderr.write("field-publish: nothing new to post (all publishable days already published).\n");
    return;
  }
  process.stderr.write(
    `field-publish: posted ${posted.length} verdict(s) to #${channel.name} (skipped ${skipped.length}).\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-publish: ${message}\n`);
  process.exit(1);
});
