/**
 * CLI: reconcile field-ops video against committed flight hours for a window.
 *
 * Usage: npm run fieldops -- --start 2026-05-01 --end 2026-05-31 [--format table]
 *        npm run fieldops -- --start 2026-05-01 --end 2026-05-31 --write
 * Defaults to the current Europe/Kyiv calendar month when bounds are omitted.
 *
 * Flight hours are committed (not pasted) so the gate is reproducible: by
 * default they're read from reports/field-ops/inputs/<period>.csv
 * (`date,flight_hours`); override with `--inputs <path>`. Videos are fetched
 * live from Vimeo. `--write` persists reports/field-ops/<period>.{json,csv} (the
 * lossless reconciliation JSON is the web's render source; the CSV is a flat
 * per-day record). A missing inputs file is a warning, not an error — every day
 * then reconciles as video-only (FLAG).
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so
 * the `server-only` import in ../lib/vimeo resolves to its empty module.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchVideosInPeriod } from "../lib/vimeo";
import { FIELD_TIMEZONE, type ReconVideo } from "../lib/reconcile";
import { parseFlightHoursCsv, toFlightDays } from "../lib/flightHours";
import { defaultBaseDir, periodKey, writeReport } from "../lib/reports";
import {
  buildReconciliation,
  formatTable,
  parseArgs,
  resolvePeriod,
  toCsv,
  type Period,
} from "./fieldopsReport";

/** Today's date (YYYY-MM-DD) in the field timezone. */
function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Default committed flight-hours CSV path for a period. */
function defaultInputsPath(period: Period): string {
  return join(defaultBaseDir(), "field-ops", "inputs", `${periodKey(period)}.csv`);
}

async function main(): Promise<void> {
  // Load .env (where VIMEO_TOKEN lives) if present; ignore if absent.
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayInFieldTz());

  // Committed flight hours (reproducible input). Missing file → no flight days.
  const inputsPath = args.inputs ?? defaultInputsPath(period);
  let flightInputPath: string | null = inputsPath;
  let flightCsv = "";
  try {
    flightCsv = readFileSync(inputsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(
        `fieldops: no flight-hours file at ${inputsPath} — every day reconciles as video-only (FLAG).\n`,
      );
      flightInputPath = null;
    } else {
      throw error;
    }
  }
  const flightDays = toFlightDays(parseFlightHoursCsv(flightCsv));

  const videos = await fetchVideosInPeriod(period.start, period.end);
  const reconVideos: ReconVideo[] = videos.map((v) => ({
    createdTime: v.created_time,
    durationSeconds: v.duration,
  }));

  const report = buildReconciliation(reconVideos, flightDays, period, flightInputPath);

  if (args.format === "table") {
    console.log(formatTable(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  if (args.write) {
    const { jsonPath, csvPath } = writeReport("field-ops", period, {
      json: JSON.stringify(report, null, 2),
      csv: toCsv(report),
    });
    process.stderr.write(
      `fieldops: wrote ${jsonPath} and ${csvPath} (${report.daily.length} days, ${report.summary.flaggedDays.length} flagged)\n`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fieldops: ${message}\n`);
  process.exit(1);
});
