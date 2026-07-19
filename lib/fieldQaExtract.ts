/**
 * Shared #field-qa airborne-time extraction. SERVER-ONLY (fetches live Slack and
 * may call Claude vision). One source of truth for turning the stats bot's daily
 * "Статистика польотів" cards into the committed field-qa report, called by BOTH
 * the `field-qa` CLI and the `/api/cron/field-nightly` route.
 *
 * With `write`, persists the DB field-qa report (reports/field-qa/<period>) — its
 * CSV sidecar is the fieldops inputs CSV. It NEVER writes the repo filesystem;
 * the fs inputs artifact stays a CLI-only concern (callers use `inputsCsv`).
 */
import "server-only";
import { downloadFileBase64, fetchMessages } from "./slack";
import { extractAirborne } from "./flightExtract";
import { parseAirborneFromText } from "./flightTextParse";
import { extractDroneReports, kyivPostDate } from "./extractDroneReports";
import { classifyDroneCount } from "./droneCountReport";
import {
  airborneKey,
  droneKey,
  dbExtractCacheStore,
  makeCachedAirborne,
  makeCachedDroneClassifier,
} from "./extractCache";
import { writeReport } from "./reports";
import {
  buildReport,
  toInputsCsv,
  validateDays,
  type ExtractedDay,
  type FieldQaReport,
  type Period,
} from "../scripts/fieldQaReport";

const FIELD_QA_CHANNEL = "field-qa";
const SUMMARY_PREFIX = "Статистика польотів за ";
const TITLE_DATE = /Статистика польотів за (\d{4}-\d{2}-\d{2})/;

export interface ExtractFieldQaResult {
  report: FieldQaReport;
  days: ExtractedDay[];
  inputsCsv: string;
}

export interface ExtractFieldQaOptions {
  write?: boolean;
  onLog?: (message: string) => void;
}

export async function extractFieldQa(
  period: Period,
  opts: ExtractFieldQaOptions = {},
): Promise<ExtractFieldQaResult> {
  const log = opts.onLog ?? (() => {});

  const messages = await fetchMessages({ start: period.start, end: period.end });
  const summaries = messages.filter(
    (m) => m.channel === FIELD_QA_CHANNEL && m.text.startsWith(SUMMARY_PREFIX),
  );

  // Cache the expensive vision reads by image identity (stable urlPrivate). Only
  // summaries that fail the deterministic text parse and carry an image hit
  // Claude; preload their cache rows in one query so the loop stays hit-only for
  // unchanged days — the whole point is to keep the nightly under the 60s cap.
  const airborneStore = dbExtractCacheStore("airborne");
  const visionImageIds = summaries
    .filter((m) => TITLE_DATE.exec(m.text)?.[1] && !parseAirborneFromText(m.text))
    .map((m) => m.files?.find((f) => f.mimetype.startsWith("image/"))?.urlPrivate)
    .filter((u): u is string => !!u);
  const airbornePreloaded = await airborneStore.readMany(visionImageIds.map(airborneKey));
  const cachedAirborne = makeCachedAirborne(airborneStore, airbornePreloaded, extractAirborne);

  const extracted: ExtractedDay[] = [];
  for (const m of summaries) {
    const date = TITLE_DATE.exec(m.text)?.[1];
    if (!date) continue;
    // The bot posts the card as text too; parse that deterministically when
    // present and only fall back to reading the image via Claude vision (cached).
    let a = parseAirborneFromText(m.text);
    if (!a) {
      const image = m.files?.find((f) => f.mimetype.startsWith("image/"));
      if (!image) continue;
      a = await cachedAirborne.run(image.urlPrivate, () => downloadFileBase64(image.urlPrivate));
    }
    // Keep telemetry-confirmed no-fly days (flew:false / 0 sec) — a known zero is
    // data, not absence. validateDays/buildReport keep them; toInputsCsv still
    // excludes them from the flight-hours feed.
    extracted.push({ date, airborneSeconds: a.airborneSeconds, flights: a.flights, flew: a.flew, sourceTs: m.ts });
  }

  const days = validateDays(extracted);
  const permalinkByTs = new Map(summaries.map((m) => [m.ts, m.permalink]));

  // Per-day drone-count entries from that day's #field-qa messages (a separate
  // free-text report, not the stat card). Attributed by post date / explicit date.
  // A date whose classification failed gets NO droneReport key (unknown — the
  // verdict skips the drone gate for it); a classified-and-none day gets [].
  const fieldQaMessages = messages.filter((m) => m.channel === FIELD_QA_CHANNEL);
  // Same cache treatment for the drone-count classify calls, keyed by
  // text + Kyiv post-date (the two inputs the classifier sees).
  const droneStore = dbExtractCacheStore("drone");
  const dronePreloaded = await droneStore.readMany(
    fieldQaMessages.map((m) => droneKey(m.text, kyivPostDate(m.ts))),
  );
  const { classifier: cachedDroneClassifier, misses: droneMisses } = makeCachedDroneClassifier(
    droneStore,
    dronePreloaded,
    classifyDroneCount,
  );
  const { byDate: droneByDate, failedDates: droneFailedDates } = await extractDroneReports(
    fieldQaMessages.map((m) => ({ ts: m.ts, text: m.text })),
    cachedDroneClassifier,
  );
  log(`field-qa: Claude calls — ${cachedAirborne.misses()} vision, ${droneMisses()} drone (rest cached)`);
  if (droneFailedDates.size > 0) {
    log(`field-qa: drone-count classification failed for ${[...droneFailedDates].sort().join(", ")} — those days carry no droneReport key (gate skipped)`);
  }

  const report = buildReport(days, period, permalinkByTs, droneByDate, droneFailedDates);
  const inputsCsv = toInputsCsv(days);

  if (opts.write) {
    const { key } = await writeReport("field-qa", period, {
      json: JSON.stringify(report, null, 2),
      csv: inputsCsv,
    });
    log(`field-qa: wrote field-qa/${key} (${report.totals.days} days, ${report.totals.flightHours} h)`);
  }

  return { report, days, inputsCsv };
}
