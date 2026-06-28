/**
 * Shared field-bonus computation. SERVER-ONLY (live Vimeo + Claude + DB). Pulls
 * the #field-qa roster reports from the Slack mirror, video minutes from live
 * Vimeo (attributed by name date), and drone losses via Claude, then runs the
 * pure calculator. With write, persists reports/field-bonus/<period>.{json,csv}.
 */
import "server-only";
import { fetchVideosInPeriod } from "./vimeo";
import { videoFlightDate } from "./reconcile";
import { readChannelMessages } from "./slackMirror";
import { writeReport } from "./reports";
import { parseMonth } from "./fieldReports";
import { computeBonuses, type BonusReport, type LossRecord } from "./fieldBonus";
import { extractLoss } from "./lossExtract";
import { readAliases, mergeAliases } from "./rosterAliases";
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

  const report = computeBonuses({ period, reports, videoMinutesByDate, losses });

  if (opts.write) {
    const { key } = await writeReport("field-bonus", period, { json: JSON.stringify(report), csv: toCsv(report) });
    log(`field-bonus: wrote report for ${key}`);
  }
  return report;
}
