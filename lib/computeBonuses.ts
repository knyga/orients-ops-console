/**
 * Shared field-bonus computation. SERVER-ONLY (live Vimeo + Claude + DB). Pulls
 * the #field-qa roster reports from the Slack mirror, video minutes from live
 * Vimeo (attributed by name date), and drone losses via Claude, then runs the
 * pure calculator. With write, persists reports/field-bonus/<period>.{json,csv}.
 */
import "server-only";
import { fetchVideosInPeriod } from "./vimeo";
import { videoFlightDate, videoUploadDate } from "./reconcile";
import { classifyDroneCount } from "./droneCountReport";
import { readChannelMessages } from "./slackMirror";
import { writeReport } from "./reports";
import { parseMonth } from "./fieldReports";
import { computeBonuses, type BonusReport, type LossRecord } from "./fieldBonus";
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
  // #field-qa that day. Classify only otherwise-counted days (bounds Claude calls).
  const msgKyivDate = (ts: string) => videoUploadDate(new Date(Number(ts) * 1000).toISOString());
  const textByDate = new Map<string, string[]>();
  for (const m of messages) {
    const d = msgKyivDate(m.ts);
    const arr = textByDate.get(d) ?? [];
    if (m.text) arr.push(m.text);
    textByDate.set(d, arr);
  }
  const droneCountByDate: Record<string, boolean> = {};
  for (const r of reports) {
    const videoMin = videoMinutesByDate[r.flightDate] ?? 0;
    const otherwiseCounted = r.deployMin != null && r.deployMin >= 180 && videoMin >= 2;
    if (!otherwiseCounted) continue;
    const dayText = (textByDate.get(r.flightDate) ?? []).join("\n\n");
    const cls = await classifyDroneCount(dayText);
    droneCountByDate[r.flightDate] = cls.present;
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
