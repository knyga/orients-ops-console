/**
 * CLI: proactively ask the team about a flight day's missing info — DRY-RUN BY
 * DEFAULT. For each NEEDS_REVIEW day it derives askable gaps (no dataset notice;
 * video < 50% of airborne) and posts a clear Ukrainian question in the relevant
 * channel, ONCE per (gapType, date).
 *
 * Usage:
 *   npm run field-ask -- --start 2026-06-01 --end 2026-06-19            # dry-run
 *   npm run field-ask -- --start … --end … --publish                   # ACTUALLY ASK (needs chat:write)
 * Defaults to the current Europe/Kyiv month.
 *
 * Safety: dry-run default; `--publish` required for a real post; idempotent
 * (already-asked gaps in reports/asks/<period>.json are skipped); posts only its
 * own question text to each gap's tracked channel. The bot's question ts is
 * recorded so S6 (`field-remember`) can read the human's threaded reply.
 *
 * Runs under `--conditions=react-server` so the server-only Slack import resolves.
 */
import { postMessage } from "../lib/slack";
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { readReportJson, periodKey } from "../lib/reports";
import { readAsks, recordAsk, writeAsks } from "../lib/asks";
import type { DayVerdict } from "../lib/fieldDayVerdict";
import {
  buildAskPlan,
  formatDryRun,
  parseArgs,
  pendingAsks,
  resolvePeriod,
  type Period,
} from "./fieldAskReport";

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

  const report = readReportJson<VerdictReport>("field-verdict", periodKey(period));
  if (!report) {
    process.stderr.write(
      `field-ask: no committed field-verdict report for ${periodKey(period)} — run \`npm run field-verdict -- --start ${period.start} --end ${period.end} --write\` first.\n`,
    );
    process.exit(1);
  }

  const log = readAsks(period);
  const plan = buildAskPlan(report.days, log);
  const pending = pendingAsks(plan);

  if (!args.publish) {
    console.log(formatDryRun(plan, period));
    return;
  }

  // --- Real ask path (explicit --publish) ---
  if (pending.length === 0) {
    process.stderr.write("field-ask: nothing new to ask (all askable gaps already asked).\n");
    return;
  }

  let nextLog = log;
  let asked = 0;
  for (const item of pending) {
    const channel = TRACKED_CHANNELS.find((c) => c.name === item.gap.channel);
    if (!channel) {
      process.stderr.write(`field-ask: gap channel "${item.gap.channel}" is not tracked — skipping ${item.key}.\n`);
      continue;
    }
    const ts = await postMessage(channel.id, item.gap.question);
    nextLog = recordAsk(nextLog, item.key, {
      gapType: item.gap.gapType,
      date: item.gap.date,
      channel: channel.name,
      question: item.gap.question,
      state: "ASKED",
      askedTs: ts,
      askedAt: new Date().toISOString(),
    });
    writeAsks(period, nextLog); // persist after each so a mid-run failure is not lost
    asked += 1;
    process.stderr.write(`field-ask: asked ${item.key} in #${channel.name} (ts ${ts})\n`);
  }
  process.stderr.write(`field-ask: asked ${asked} question(s).\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-ask: ${message}\n`);
  process.exit(1);
});
