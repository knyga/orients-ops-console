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

  const extracted: ExtractedDay[] = [];
  for (const m of summaries) {
    const date = TITLE_DATE.exec(m.text)?.[1];
    if (!date) continue;
    // The bot posts the card as text too; parse that deterministically when
    // present and only fall back to reading the image via Claude vision.
    let a = parseAirborneFromText(m.text);
    if (!a) {
      const image = m.files?.find((f) => f.mimetype.startsWith("image/"));
      if (!image) continue;
      const { base64, mediaType } = await downloadFileBase64(image.urlPrivate);
      a = await extractAirborne(base64, mediaType);
    }
    // Keep telemetry-confirmed no-fly days (flew:false / 0 sec) — a known zero is
    // data, not absence. validateDays/buildReport keep them; toInputsCsv still
    // excludes them from the flight-hours feed.
    extracted.push({ date, airborneSeconds: a.airborneSeconds, flights: a.flights, flew: a.flew, sourceTs: m.ts });
  }

  const days = validateDays(extracted);
  const permalinkByTs = new Map(summaries.map((m) => [m.ts, m.permalink]));
  const report = buildReport(days, period, permalinkByTs);
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
