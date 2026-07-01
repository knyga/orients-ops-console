/**
 * Shared field-day verdict computation. SERVER-ONLY (fetches live Vimeo). One
 * source of truth for the verdict pass, called by BOTH the `field-verdict` CLI
 * and the nightly pipeline (`lib/runNightly` / `/api/cron/field-nightly`).
 * Inputs: airborne minutes ← committed
 * field-qa report (S2), video minutes ← live Vimeo attributed by name date,
 * #datasets notices ← the Slack mirror, exceptions ← the resolutions store.
 * With `write`, persists reports/field-verdict/<period>.{json,csv}.
 */
import "server-only";
import { fetchVideosInPeriod } from "./vimeo";
import { videoFlightDate } from "./reconcile";
import { readReportJson, writeReport, periodKey } from "./reports";
import { readChannelMessages } from "./slackMirror";
import { hasDatasetNotice } from "./datasetNotice";
import { verdictForDay, type DayVerdict } from "./fieldDayVerdict";
import { applyResolution, deriveDatasetStatus, readResolutions } from "./resolutions";
import { addWorkingDays } from "./workdays";
import { parseMonth } from "./fieldReports";
import { readAliases, mergeAliases } from "./rosterAliases";
import { SEED_ALIASES } from "./fieldRoster";
import { readRosterCorrections } from "./rosterCorrections";
import { overlayAirborne, readAirborneOverrides } from "./airborneOverrides";
import { applyRosterCorrection } from "./rosterCorrection";
import { buildReport, mergeFlightDays, toCsv, type Period, type VerdictReport } from "../scripts/fieldVerdictReport";
import { todayInFieldTz } from "./syncChannels";

export const GRACE_WORKING_DAYS = 3;
const DATASETS_CHANNEL = "datasets";

/** Shape of the committed field-qa report we read airborne minutes from (S2). */
interface FieldQaReport {
  days: { date: string; airborneMinutes: number }[];
}

export interface ComputeVerdictsOptions {
  /** The "now" calendar day (field tz). Defaults to today. */
  today?: string;
  /** Persist the committed reports/field-verdict/<period>.{json,csv}. */
  write?: boolean;
  /** Optional progress sink (the CLI passes stderr; the cron route omits it). */
  onLog?: (message: string) => void;
}

export { todayInFieldTz };

/**
 * Compute the per-flight-day verdict report for a period. Pure-ish orchestration
 * over the live + committed inputs; the per-day decision lives in
 * lib/fieldDayVerdict and the resolution overlay in lib/resolutions.
 */
export async function computeVerdicts(
  period: Period,
  opts: ComputeVerdictsOptions = {},
): Promise<VerdictReport> {
  const log = opts.onLog ?? (() => {});
  const today = opts.today ?? todayInFieldTz();

  // 1. Airborne minutes per flight day — committed S2 report.
  const fq = await readReportJson<FieldQaReport>("field-qa", periodKey(period));
  if (!fq) {
    log(
      `field-verdict: no committed field-qa report for ${periodKey(period)} — run \`npm run field-qa -- --start ${period.start} --end ${period.end} --write\` first.`,
    );
  }
  // Approver airborne-minutes overrides win over (and can surface a date absent
  // from) the committed field-qa figure.
  const airborneByDate = overlayAirborne(
    new Map<string, number>((fq?.days ?? []).map((d) => [d.date, d.airborneMinutes])),
    await readAirborneOverrides(),
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
  const datasetMessages = (await readChannelMessages(DATASETS_CHANNEL, period))
    .filter((m) => !m.deleted)
    .map((m) => ({ isoTime: m.isoTime, text: m.text }));

  // 4. Resolutions (exceptions).
  const resolutions = await readResolutions();

  // 5. Crew per flight day — parsed from the #field-qa "Звіт" reports + corrections.
  const aliases = mergeAliases(SEED_ALIASES, await readAliases());
  const fieldQaMessages = (await readChannelMessages("field-qa", period)).filter((m) => !m.deleted);
  const parsedReports = parseMonth(fieldQaMessages, aliases);
  const parsedByDate = new Map(parsedReports.map((r) => [r.flightDate, r]));
  const corrections = await readRosterCorrections();

  // Flight days = union of days the bot reported airborne time AND days with a
  // parsed "Звіт" that has a deployment window (deployMin != null). The latter
  // surface as NEEDS_REVIEW ("flight reported but airborne time not recorded")
  // instead of vanishing.
  const flightDays = mergeFlightDays(airborneByDate, parsedReports);
  const days: DayVerdict[] = flightDays.map((fd) => {
    const date = fd.date;
    const airborneMinutes = fd.airborneMinutes;
    const videoMinutes = Math.round((videoMinutesByDate.get(date) ?? 0) * 10) / 10;
    const windowEnd = addWorkingDays(date, GRACE_WORKING_DAYS);
    const datasetPosted = hasDatasetNotice(datasetMessages, date, windowEnd);
    const { status: datasetStatus, note: datasetNote } = deriveDatasetStatus(datasetPosted, date, resolutions);
    const base = verdictForDay({
      flightDate: date,
      airborneMinutes,
      videoMinutes,
      datasetStatus,
      today,
      graceWorkingDays: GRACE_WORKING_DAYS,
      airborneReported: fd.airborneReported,
      deployWindow: fd.deployWindow,
    });
    // Surface the verbatim waiver/decline reason in the verdict reasons.
    const withNote = datasetNote ? { ...base, reasons: [...base.reasons, datasetNote] } : base;
    const resolved = applyResolution(withNote, resolutions);
    // Attach the effective crew (parsed "Звіт" roster + any approver correction).
    const parsed = parsedByDate.get(date);
    const eff = applyRosterCorrection(parsed?.roster ?? [], true, corrections.find((c) => c.date === date));
    return { ...resolved, roster: eff.roster, unknownInitials: parsed?.unknownInitials ?? [] };
  });

  const report = buildReport(days, period, today, GRACE_WORKING_DAYS);

  if (opts.write) {
    await writeReport("field-verdict", period, {
      json: JSON.stringify(report, null, 2),
      csv: toCsv(report),
    });
    const s = report.summary;
    log(
      `field-verdict: wrote field-verdict/${periodKey(period)} (✅${s.accepted} ⏳${s.pending} ⚠️${s.needsReview} 🟡${s.acceptedException} ⛔${s.rejected})`,
    );
  }

  return report;
}
