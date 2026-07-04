/**
 * Shared field-bonus computation. SERVER-ONLY (live Vimeo via computeVerdicts +
 * Claude + DB). One gate: the resolved verdict days from computeVerdicts (video/
 * deploy/drone/dataset axes + approver overrides) — ACCEPTED ⇔ the day pays.
 * Beyond the gate, still pulls the #field-qa "Звіт" reports (arrival time for
 * the early bonus, crash text for drone losses) and runs the pure calculator.
 * With write, persists reports/field-bonus/<period>.{json,csv}.
 */
import "server-only";
import { computeVerdicts } from "./computeVerdicts";
import { readChannelMessages } from "./slackMirror";
import { writeReport } from "./reports";
import { parseMonth } from "./fieldReports";
import { computeBonuses, roundVideoMin, type BonusReport, type LossRecord, type QualifiedDay } from "./fieldBonus";
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

  // One gate: the resolved verdict (video/deploy/drone/dataset axes + approver
  // overrides). ACCEPTED ⇔ the day pays.
  const verdicts = await computeVerdicts(period, { onLog: log });

  // The Звіт parse still supplies what the money math needs beyond the gate:
  // arrival time (early bonus) and crash text (drone losses).
  const aliases = mergeAliases(SEED_ALIASES, await readAliases());
  const messages = (await readChannelMessages("field-qa", period)).filter((m) => !m.deleted);
  const reports = parseMonth(messages, aliases);
  const parsedByDate = new Map(reports.map((r) => [r.flightDate, r]));

  const losses: LossRecord[] = [];
  for (const r of reports) {
    if (!r.crashText) continue;
    const cls = await extractLoss(r.crashText);
    if (cls.lost) losses.push({ date: r.flightDate, found: cls.found, note: cls.note });
  }
  log(`field-bonus: ${losses.filter((l) => !l.found).length} unrecovered loss(es)`);

  const corrections = await readRosterCorrections();
  const days: QualifiedDay[] = verdicts.days.map((d) => ({
    date: d.date,
    status: d.status,
    roster: d.roster,
    unknownInitials: d.unknownInitials,
    deployMin: d.deployMin ?? parsedByDate.get(d.date)?.deployMin ?? null,
    videoMin: roundVideoMin(d.videoMinutes),
    start: parsedByDate.get(d.date)?.start ?? null,
    reasons: d.reasons,
    flew: d.airborneMinutes > 0 || !d.airborneReported,
  }));
  const report = computeBonuses({ period, days, losses, corrections });
  log(`field-bonus: ${report.days.filter((x) => x.counted).length} counted day(s), ${report.pendingDays.length} pending, ${report.voidedDays.length} voided`);

  if (opts.write) {
    const { key } = await writeReport("field-bonus", period, { json: JSON.stringify(report), csv: toCsv(report) });
    log(`field-bonus: wrote report for ${key}`);
  }
  return report;
}
