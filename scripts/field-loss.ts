/**
 * CLI: the drone-loss ledger for a period — effective losses, the unrecovered
 * counter vs the >3 team cutoff, and crew penalty exposure from the committed
 * field-bonus report. READ-ONLY (corrections go through
 * `npm run field-instructions -- --date D --loss found|lost`).
 *
 * Usage:
 *   npm run field-loss                                       # current Kyiv month, JSON
 *   npm run field-loss -- --start 2026-07-01 --end 2026-07-31 --format table
 * Mirrors GET /api/field-loss. Needs POSTGRES_URL. Runs under --conditions=react-server.
 */
import { readLossRecords } from "../lib/lossStore";
import { readReportJson, periodKey } from "../lib/reports";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import type { BonusReport } from "../lib/fieldBonus";
import { buildLossReport, parseArgs, renderTable } from "./fieldLossReport";

function kyivMonth(): { start: string; end: string } {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const [y, m] = today.split("-").map(Number);
  const mm = String(m).padStart(2, "0");
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }
  const args = parseArgs(process.argv.slice(2));
  const fallback = kyivMonth();
  const period = { start: args.start ?? fallback.start, end: args.end ?? fallback.end };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.start) || !/^\d{4}-\d{2}-\d{2}$/.test(period.end)) {
    console.error("field-loss: --start/--end must be YYYY-MM-DD");
    process.exit(1);
  }
  const rows = await readLossRecords();
  const bonus = await readReportJson<BonusReport>("field-bonus", periodKey(period));
  const report = buildLossReport(rows, period, bonus?.penalties ?? []);
  if (args.format === "table") console.log(renderTable(report));
  else console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(`field-loss: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
