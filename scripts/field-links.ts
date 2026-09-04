/**
 * CLI: cross-links (🔗) between a period's per-day #field-qa bot messages —
 * drone reminder, verdict, bonus breakdown, the bot's Звіт-thread reply and the
 * monthly summary line. DRY-RUN by default: prints each day's node table and
 * every planned edit/post, sends nothing.
 *
 *   npm run field-links -- --start 2026-09-01 --end 2026-09-04                      # dry-run, JSON
 *   npm run field-links -- --start 2026-09-01 --end 2026-09-04 --format table
 *   npm run field-links -- --start 2026-09-01 --end 2026-09-04 --publish --channel orients-ops-console-test
 *   npm run field-links -- --start 2026-07-01 --end 2026-07-31 --publish --channel field-qa --zvit-reply   # backfill incl. new Звіт replies
 *
 * `--publish` requires `--channel <name>` (tracked). New Звіт-thread replies are
 * posted only for a period ending within the last 14 days unless `--zvit-reply`
 * / `--no-zvit-reply` says otherwise (edits are always allowed). Mirrors
 * GET /api/field-links. Runs under --conditions=react-server.
 */
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { planRelinkForPeriod, relinkDays } from "../lib/relinkDay";
import { parseLinksArgs, renderLinksTable, resolveZvitReply } from "./fieldLinksReport";
import { resolvePeriod } from "./fieldPublishReport";

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }
  const args = parseLinksArgs(process.argv.slice(2));
  const today = todayInFieldTz();
  const period = resolvePeriod({ start: args.start, end: args.end, publish: args.publish }, today);
  const zvitReply = resolveZvitReply(args.zvitReply, period, today);
  const channelName = args.channel ?? "field-qa";

  if (!args.publish) {
    const plan = await planRelinkForPeriod(period, null, channelName, zvitReply);
    if (args.format === "table") {
      process.stdout.write(`DRY RUN — #${channelName} ${period.start}..${period.end} (zvitReply=${zvitReply})\n${renderLinksTable(plan.days)}\nNo messages were sent. Re-run with --publish --channel <name>.\n`);
    } else {
      console.log(JSON.stringify({ period, channel: channelName, zvitReply, days: plan.days }, null, 2));
    }
    return;
  }
  if (!args.channel) { process.stderr.write("field-links: --publish requires --channel <name>.\n"); process.exit(1); }
  if (!TRACKED_CHANNELS.some((c) => c.name === args.channel)) { process.stderr.write(`field-links: unknown channel "${args.channel}".\n`); process.exit(1); }
  const r = await relinkDays(period, null, { publish: true, trigger: "cli", zvitReply, channel: args.channel, onLog: (m) => process.stderr.write(`${m}\n`) });
  process.stderr.write(`field-links: ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed in #${r.channel}\n`);
  if (r.failed > 0) process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`field-links: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
