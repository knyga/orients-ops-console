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
import { downloadFileBase64, fetchRawMessages } from "./slack";
import { TRACKED_CHANNELS } from "./slackChannels";
import { extractAirborne } from "./flightExtract";
import { parseAirborneFromText } from "./flightTextParse";
import { extractDroneReports, kyivPostDate } from "./extractDroneReports";
import { anchorDateFromText } from "./droneReminderPlan";
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

  // fetchRawMessages (not fetchMessages): drone-count submissions can be
  // replies inside the 11:00 reminder thread, and conversations.history alone
  // never returns thread replies. Raw messages also carry authorId + thread_ts,
  // which the per-person gate and the anchor-date defaulting need.
  const fieldQaChannel = TRACKED_CHANNELS.find((c) => c.name === FIELD_QA_CHANNEL);
  if (!fieldQaChannel) throw new Error(`field-qa extract: no tracked channel "${FIELD_QA_CHANNEL}"`);
  const messages = await fetchRawMessages({ start: period.start, end: period.end }, [fieldQaChannel]);
  const summaries = messages.filter((m) => m.text.startsWith(SUMMARY_PREFIX));

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

  // Per-day drone-count entries from the period's #field-qa messages INCLUDING
  // thread replies (a separate free-text report, not the stat card). Attributed
  // by explicit date / reminder-anchor date / post date. A date whose
  // classification failed gets NO droneReport key (unknown — the verdict skips
  // the drone gate for it); a classified-and-none day gets [].
  // Reminder anchors: the bot's 11:00 reminder's stable first line names its
  // target date; a dateless reply in that thread defaults to it.
  const anchorDateByThreadTs = new Map<string, string>();
  for (const m of messages) {
    const anchorDate = anchorDateFromText(m.text, kyivPostDate(m.ts));
    if (anchorDate) anchorDateByThreadTs.set(m.ts, anchorDate);
  }
  // Same cache treatment for the drone-count classify calls, keyed by
  // text + default date (the two inputs the classifier sees). The preload key
  // must mirror extractDroneReports' default-date rule: anchor date for a reply
  // inside a reminder thread, else the Kyiv post date.
  const defaultDateOf = (m: { ts: string; thread_ts?: string }) =>
    (m.thread_ts !== undefined && anchorDateByThreadTs.get(m.thread_ts)) || kyivPostDate(m.ts);
  const droneStore = dbExtractCacheStore("drone");
  const dronePreloaded = await droneStore.readMany(
    messages.map((m) => droneKey(m.text, defaultDateOf(m))),
  );
  const { classifier: cachedDroneClassifier, misses: droneMisses } = makeCachedDroneClassifier(
    droneStore,
    dronePreloaded,
    classifyDroneCount,
  );
  const { byDate: droneByDate, submittersByDate, failedDates: droneFailedDates } = await extractDroneReports(
    messages.map((m) => ({ ts: m.ts, text: m.text, authorId: m.authorId, threadTs: m.thread_ts })),
    cachedDroneClassifier,
    { anchorDateByThreadTs },
  );
  log(`field-qa: Claude calls — ${cachedAirborne.misses()} vision, ${droneMisses()} drone (rest cached)`);
  if (droneFailedDates.size > 0) {
    log(`field-qa: drone-count classification failed for ${[...droneFailedDates].sort().join(", ")} — those days carry no droneReport key (gate skipped)`);
  }

  const report = buildReport(days, period, permalinkByTs, droneByDate, droneFailedDates, submittersByDate);
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
