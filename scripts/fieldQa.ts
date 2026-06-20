/**
 * CLI: read each #field-qa daily flight-summary image (stats bot), extract the
 * airborne time (Час в повітрі) via Claude vision, and (optionally) persist it as
 * the field-ops reconciliation input.
 *
 * Usage: npm run field-qa -- --start 2026-06-01 --end 2026-06-18 [--format table]
 *        npm run field-qa -- --start … --end … --write
 * Defaults to the current Europe/Kyiv month when bounds are omitted.
 *
 * `--write` writes reports/field-ops/inputs/<period>.csv (the fieldops input) and
 * reports/field-qa/<period>.{json,csv} (provenance). Needs the Slack files:read
 * scope to download the images.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so the
 * `server-only` imports in ../lib/slack and ../lib/flightExtract resolve.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { downloadFileBase64, fetchMessages } from "../lib/slack";
import { extractAirborne } from "../lib/flightExtract";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { defaultBaseDir, periodKey, writeReport } from "../lib/reports";
import {
  buildReport,
  formatTable,
  parseArgs,
  resolvePeriod,
  toInputsCsv,
  validateDays,
  type ExtractedDay,
  type Period,
} from "./fieldQaReport";

const FIELD_QA_CHANNEL = "field-qa";
const SUMMARY_PREFIX = "Статистика польотів за ";
const TITLE_DATE = /Статистика польотів за (\d{4}-\d{2}-\d{2})/;

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
  const summaries = messages.filter(
    (m) =>
      m.channel === FIELD_QA_CHANNEL &&
      m.text.startsWith(SUMMARY_PREFIX) &&
      (m.files?.some((f) => f.mimetype.startsWith("image/")) ?? false),
  );

  const days: ExtractedDay[] = [];
  for (const m of summaries) {
    const date = TITLE_DATE.exec(m.text)?.[1];
    const image = m.files?.find((f) => f.mimetype.startsWith("image/"));
    if (!date || !image) continue;
    const { base64, mediaType } = await downloadFileBase64(image.urlPrivate);
    const a = await extractAirborne(base64, mediaType);
    if (!a.flew || a.airborneSeconds <= 0) continue;
    days.push({ date, airborneSeconds: a.airborneSeconds, flights: a.flights, sourceTs: m.ts });
  }

  const valid = validateDays(days);
  const permalinkByTs = new Map(summaries.map((m) => [m.ts, m.permalink]));
  const report = buildReport(valid, period, permalinkByTs);

  if (args.format === "table") {
    console.log(formatTable(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  if (args.write) {
    const csv = toInputsCsv(valid);
    const inputs = inputsPath(period);
    mkdirSync(dirname(inputs), { recursive: true });
    writeFileSync(inputs, csv);
    const { key } = await writeReport("field-qa", period, {
      json: JSON.stringify(report, null, 2),
      csv,
    });
    process.stderr.write(
      `field-qa: wrote ${inputs} + field-qa/${key} (${report.totals.days} days, ${report.totals.flightHours} h)\n`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-qa: ${message}\n`);
  process.exit(1);
});
