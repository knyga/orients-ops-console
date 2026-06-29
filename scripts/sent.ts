/**
 * CLI: print the durable record of every Slack message the bot posted/edited in
 * a period (audit log). Read-only — the outbound_messages table is the canonical
 * store. Defaults to the current Europe/Kyiv month.
 *
 * Usage:
 *   npm run sent -- --start 2026-06-01 --end 2026-06-28
 *   npm run sent -- --format table
 *
 * Runs under `--conditions=react-server` so the server-only import chain resolves.
 */
import { readOutbound } from "../lib/outbound";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { summarizeSent, toSentView } from "../lib/sentLog";
import { formatTable, parseArgs, resolvePeriod, type Period } from "./sentReport";

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    /* rely on ambient env */
  }

  const args = parseArgs(process.argv.slice(2));
  const period: Period = resolvePeriod(args, todayInFieldTz());

  const rows = toSentView(await readOutbound(period));
  const summary = summarizeSent(rows);

  if (args.format === "table") {
    console.log(formatTable(rows, summary, period));
  } else {
    console.log(JSON.stringify({ period, count: rows.length, summary, messages: rows }, null, 2));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sent: ${message}\n`);
  process.exit(1);
});
