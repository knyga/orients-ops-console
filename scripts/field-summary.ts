/**
 * CLI: post a compact Ukrainian per-day summary of a period's flight days to a
 * tracked channel (one line per day: crew, window, airborne, drones, status,
 * approver, gate exclusions, links). Reads the committed field-verdict,
 * field-bonus and field-qa reports (run `field-verdict --write` and
 * `field-bonus --write` first). Never mentions money.
 *
 *   npm run field-summary -- --start 2026-08-01 --end 2026-08-31                       # DRY-RUN: prints the exact text
 *   npm run field-summary -- --start 2026-08-01 --end 2026-08-31 --channel field-qa --publish
 *
 * DRY-RUN by default. `--publish` requires `--channel <name>`. Long text is
 * ONE short anchor in the channel (header, status counts, legend) + the per-day
 * lines as thread replies packed under Slack's msg_too_long cap. Idempotent per (period, Kyiv day, chunk) via outbound keys.
 * Same code path as the agent's confirm-first `field_summary_post` tool
 * (lib/fieldSummaryPost.ts). Runs under `--conditions=react-server`.
 */
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { assembleSummaryDays, postFieldSummary } from "../lib/fieldSummaryPost";
import { buildMonthSummary } from "../lib/fieldMonthSummary";
import { parseArgs, resolvePeriod, type Period } from "./fieldPublishReport";

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }
  const args = parseArgs(process.argv.slice(2));
  const today = todayInFieldTz();
  const period: Period = resolvePeriod(args, today);

  if (!args.publish) {
    const days = await assembleSummaryDays(period);
    const { anchor, details } = buildMonthSummary(period, today, days);
    process.stdout.write(
      `DRY RUN — would post 1 anchor + ${details.length} thread repl${details.length === 1 ? "y" : "ies"} [${period.start} … ${period.end}]\n\n` +
        `=== ANCHOR ===\n${anchor}\n\n` +
        details.map((d, i) => `=== THREAD ${i + 1}/${details.length} ===\n${d}`).join("\n\n") +
        `\n\nNo messages were sent. Re-run with --publish --channel <name>.\n`,
    );
    return;
  }
  if (!args.channel) {
    process.stderr.write("field-summary: --publish requires --channel <name>.\n");
    process.exit(1);
  }
  const channel = TRACKED_CHANNELS.find((c) => c.name === args.channel);
  if (!channel) {
    process.stderr.write(`field-summary: unknown channel "${args.channel}".\n`);
    process.exit(1);
  }
  const r = await postFieldSummary({ channelId: channel.id, period, today, trigger: "cli" });
  process.stderr.write(`field-summary: posted anchor (ts ${r.anchorTs}) + ${r.replies} thread repl${r.replies === 1 ? "y" : "ies"} for ${r.days} days to #${channel.name}\n`);
}

main().catch((e) => {
  process.stderr.write(`field-summary: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
