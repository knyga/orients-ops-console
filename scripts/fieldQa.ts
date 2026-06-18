/**
 * CLI: extract #field-qa flight hours for a window and (optionally) persist them.
 *
 * Usage: npm run field-qa -- --start 2026-06-01 --end 2026-06-18 [--format table]
 *        npm run field-qa -- --start 2026-06-01 --end 2026-06-18 --write
 * Defaults to the current Europe/Kyiv month when bounds are omitted.
 *
 * `--write` writes the reconciliation input reports/field-ops/inputs/<period>.csv
 * (the contract scripts/fieldops.ts reads) AND the provenance artifact
 * reports/field-qa/<period>.{json,csv}. Flight hours are extracted by Claude
 * (non-deterministic) — review the committed diff before running fieldops.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so the
 * `server-only` imports in ../lib/slack and ../lib/flightExtract resolve.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchMessages } from "../lib/slack";
import { extractFlightDays } from "../lib/flightExtract";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { defaultBaseDir, periodKey, writeReport } from "../lib/reports";
import {
  buildReport,
  formatTable,
  parseArgs,
  resolvePeriod,
  toInputsCsv,
  validateDays,
  type Period,
} from "./fieldQaReport";

const FIELD_QA_CHANNEL = "field-qa";

/** Today's date (YYYY-MM-DD) in the field timezone. */
function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Reconciliation input path for a period (matches scripts/fieldops.ts). */
function inputsPath(period: Period): string {
  return join(defaultBaseDir(), "field-ops", "inputs", `${periodKey(period)}.csv`);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayInFieldTz());

  const messages = await fetchMessages({ start: period.start, end: period.end });
  const fieldQa = messages.filter((m) => m.channel === FIELD_QA_CHANNEL);

  const days = validateDays(await extractFlightDays(fieldQa));
  const permalinkByTs = new Map(fieldQa.map((m) => [m.ts, m.permalink]));
  const report = buildReport(days, period, permalinkByTs);

  if (args.format === "table") {
    console.log(formatTable(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  if (args.write) {
    const csv = toInputsCsv(days);
    const inputs = inputsPath(period);
    mkdirSync(dirname(inputs), { recursive: true });
    writeFileSync(inputs, csv);
    const { jsonPath } = writeReport("field-qa", period, {
      json: JSON.stringify(report, null, 2),
      csv,
    });
    process.stderr.write(
      `field-qa: wrote ${inputs} + ${jsonPath} (${report.totals.days} days, ${report.totals.flightHours} h)\n`,
    );
  }
}

main().catch((error: unknown) => {
  // Both SlackError and FlightExtractError extend Error, so a uniform message
  // is enough; no need to import or branch on the specific types.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-qa: ${message}\n`);
  process.exit(1);
});
