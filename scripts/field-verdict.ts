/**
 * CLI: compute the per-flight-day bonus-acceptance verdict for a window.
 *
 * Usage: npm run field-verdict -- --start 2026-06-01 --end 2026-06-19 [--format table]
 *        npm run field-verdict -- --start … --end … --write
 * Defaults to the current Europe/Kyiv month.
 *
 * Inputs:
 *  - airborne minutes per flight day ← committed reports/field-qa/<period>.json (S2)
 *  - video minutes per flight day    ← live Vimeo, attributed by videoFlightDate
 *  - #datasets notice per day         ← the local Slack mirror (run `npm run slack-sync` first)
 *  - exceptions                       ← reports/resolutions/store.json
 * `--write` persists reports/field-verdict/<period>.{json,csv}.
 *
 * Runs under `--conditions=react-server` so the server-only Vimeo import resolves.
 */
import { fetchVideosInPeriod } from "../lib/vimeo";
import { FIELD_TIMEZONE, videoFlightDate } from "../lib/reconcile";
import { readReportJson, writeReport, periodKey } from "../lib/reports";
import { readChannelMessages } from "../lib/slackMirror";
import { hasDatasetNotice } from "../lib/datasetNotice";
import { verdictForDay, type DayVerdict } from "../lib/fieldDayVerdict";
import { applyResolution, readResolutions } from "../lib/resolutions";
import { addWorkingDays } from "../lib/workdays";
import {
  buildReport,
  formatTable,
  parseArgs,
  resolvePeriod,
  toCsv,
  type Period,
} from "./fieldVerdictReport";

const GRACE_WORKING_DAYS = 3;
const DATASETS_CHANNEL = "datasets";

/** Shape of the committed field-qa report we read airborne minutes from (S2). */
interface FieldQaReport {
  days: { date: string; airborneMinutes: number }[];
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

  // 1. Airborne minutes per flight day — committed S2 report.
  const fq = readReportJson<FieldQaReport>("field-qa", periodKey(period));
  if (!fq) {
    process.stderr.write(
      `field-verdict: no committed field-qa report for ${periodKey(period)} — run \`npm run field-qa -- --start ${period.start} --end ${period.end} --write\` first.\n`,
    );
  }
  const airborneByDate = new Map<string, number>(
    (fq?.days ?? []).map((d) => [d.date, d.airborneMinutes]),
  );

  // 2. Video minutes per flight day — live Vimeo, attributed by name date.
  const videos = await fetchVideosInPeriod(period.start, period.end);
  const videoMinutesByDate = new Map<string, number>();
  for (const v of videos) {
    const d = videoFlightDate(v.name, v.created_time);
    videoMinutesByDate.set(d, (videoMinutesByDate.get(d) ?? 0) + v.duration / 60);
  }

  // 3. #datasets notices — from the local Slack mirror (read-only). Drop
  // tombstoned records: a retracted (deleted) notice must not count as posted.
  const datasetMessages = readChannelMessages(DATASETS_CHANNEL, period)
    .filter((m) => !m.deleted)
    .map((m) => ({ isoTime: m.isoTime, text: m.text }));

  // 4. Resolutions (exceptions).
  const resolutions = readResolutions();

  // Flight days = days the bot reported airborne time (the field-qa report).
  const flightDates = [...airborneByDate.keys()].sort();
  const days: DayVerdict[] = flightDates.map((date) => {
    const airborneMinutes = airborneByDate.get(date) ?? 0;
    const videoMinutes = Math.round((videoMinutesByDate.get(date) ?? 0) * 10) / 10;
    const windowEnd = addWorkingDays(date, GRACE_WORKING_DAYS);
    const datasetPosted = hasDatasetNotice(datasetMessages, date, windowEnd);
    const base = verdictForDay({
      flightDate: date,
      airborneMinutes,
      videoMinutes,
      datasetPosted,
      today,
      graceWorkingDays: GRACE_WORKING_DAYS,
    });
    return applyResolution(base, resolutions);
  });

  const report = buildReport(days, period, today, GRACE_WORKING_DAYS);

  if (args.format === "table") console.log(formatTable(report));
  else console.log(JSON.stringify(report, null, 2));

  if (args.write) {
    const { jsonPath, csvPath } = writeReport("field-verdict", period, {
      json: JSON.stringify(report, null, 2),
      csv: toCsv(report),
    });
    const s = report.summary;
    process.stderr.write(
      `field-verdict: wrote ${jsonPath} and ${csvPath} (✅${s.accepted} ⏳${s.pending} ⚠️${s.needsReview} 🟡${s.acceptedException})\n`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-verdict: ${message}\n`);
  process.exit(1);
});
