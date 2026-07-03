/**
 * Shared field-bonus computation. SERVER-ONLY (live Vimeo + Claude + DB). Pulls
 * the #field-qa roster reports from the Slack mirror, video minutes from live
 * Vimeo (attributed by name date), and drone losses via Claude, then runs the
 * pure calculator. With write, persists reports/field-bonus/<period>.{json,csv}.
 */
import "server-only";
import { fetchVideosInPeriod } from "./vimeo";
import { videoFlightDate } from "./reconcile";
import { extractDroneReports } from "./extractDroneReports";
import { readChannelMessages } from "./slackMirror";
import { writeReport } from "./reports";
import { parseMonth } from "./fieldReports";
import { computeBonuses, roundVideoMin, MIN_DEPLOY_MIN, MIN_VIDEO_MIN, type BonusReport, type LossRecord } from "./fieldBonus";
import { extractLoss } from "./lossExtract";
import { readAliases, mergeAliases } from "./rosterAliases";
import { readRosterCorrections } from "./rosterCorrections";
import { SEED_ALIASES } from "./fieldRoster";
import { todayInFieldTz } from "./syncChannels";
import { toCsv } from "../scripts/fieldBonusReport";
import type { Period } from "./period";

export { todayInFieldTz };

export async function computeBonusReport(
  period: Period,
  opts: { write?: boolean; onLog?: (m: string) => void } = {},
): Promise<BonusReport> {
  const log = opts.onLog ?? (() => {});

  const aliases = mergeAliases(SEED_ALIASES, await readAliases());
  const messages = (await readChannelMessages("field-qa", period)).filter((m) => !m.deleted);
  const reports = parseMonth(messages, aliases);
  log(`field-bonus: parsed ${reports.length} Звіт reports`);

  const videos = await fetchVideosInPeriod(period.start, period.end);
  const videoMinutesByDate: Record<string, number> = {};
  for (const v of videos) {
    const d = videoFlightDate(v.name, v.created_time);
    videoMinutesByDate[d] = (videoMinutesByDate[d] ?? 0) + v.duration / 60;
  }

  const losses: LossRecord[] = [];
  for (const r of reports) {
    if (!r.crashText) continue;
    const cls = await extractLoss(r.crashText);
    if (cls.lost) losses.push({ date: r.flightDate, found: cls.found, note: cls.note });
  }
  log(`field-bonus: ${losses.filter((l) => !l.found).length} unrecovered loss(es)`);

  // Drone-count gate: a day counts only if a drone-count report was posted in
  // #field-qa FOR that day. Reports are classified per Kyiv post day and
  // attributed to the date the text names (forDate) or, absent that, the post
  // day — so a next-morning "Готові 01.06" still credits 06-01 (gate design
  // Risk #1, which bit on 2026-06-01). Every post day is classified (the lagged
  // report lives on a non-flight day), same as the verdict extraction pass.
  const droneByDate = await extractDroneReports(messages.map((m) => ({ ts: m.ts, text: m.text })));
  const droneCountByDate: Record<string, boolean> = {};
  for (const r of reports) {
    // Use the SAME rounded video value + constants as the pure calculator so the
    // gate-eligibility test here can never drift from computeBonuses' gate.
    const videoMin = roundVideoMin(videoMinutesByDate[r.flightDate] ?? 0);
    const otherwiseCounted = r.deployMin != null && r.deployMin >= MIN_DEPLOY_MIN && videoMin >= MIN_VIDEO_MIN;
    if (!otherwiseCounted) continue;
    droneCountByDate[r.flightDate] = (droneByDate.get(r.flightDate)?.length ?? 0) > 0;
  }
  const voided = Object.entries(droneCountByDate).filter(([, present]) => !present).map(([d]) => d);
  log(`field-bonus: ${Object.keys(droneCountByDate).length - voided.length}/${Object.keys(droneCountByDate).length} counted days have a drone-count report${voided.length ? ` (voided: ${voided.join(", ")})` : ""}`);

  const corrections = await readRosterCorrections();
  const report = computeBonuses({ period, reports, videoMinutesByDate, losses, corrections, droneCountByDate });

  if (opts.write) {
    const { key } = await writeReport("field-bonus", period, { json: JSON.stringify(report), csv: toCsv(report) });
    log(`field-bonus: wrote report for ${key}`);
  }
  return report;
}
