/**
 * Shared field-bonus computation. SERVER-ONLY (live Vimeo via computeVerdicts +
 * Claude + DB). One gate: the resolved verdict days from computeVerdicts (video/
 * deploy/drone/dataset axes + approver overrides) — ACCEPTED ⇔ the day pays.
 * Beyond the gate, still pulls the #field-qa "Звіт" reports for arrival time
 * (the early bonus); drone-loss crash text is no longer classified here — it
 * is read from the durable loss ledger (`syncLossLedger` + `effectiveLosses`),
 * which owns hash-gated classification and instruction-outranks-extracted
 * precedence. With write, persists reports/field-bonus/<period>.{json,csv}.
 */
import "server-only";
import { computeVerdicts } from "./computeVerdicts";
import { readChannelMessages } from "./slackMirror";
import { writeReport } from "./reports";
import { parseMonth } from "./fieldReports";
import { computeBonuses, roundVideoMin, type BonusReport, type LossRecord, type QualifiedDay } from "./fieldBonus";
import { syncLossLedger } from "./lossSync";
import { effectiveLosses } from "./lossLedger";
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
  // arrival time for the early bonus (crash text/loss classification moved to
  // the ledger below).
  const aliases = mergeAliases(SEED_ALIASES, await readAliases());
  const messages = (await readChannelMessages("field-qa", period)).filter((m) => !m.deleted);
  const reports = parseMonth(messages, aliases);
  // Keyed by report ts — the money math (arrival time, deploy window) belongs
  // to the specific Звіт a verdict day was resolved from, not just its date
  // (a multi-report day has one Звіт per trip, each with its own start time).
  const parsedByReportTs = new Map(reports.map((r) => [r.reportTs, r]));

  // Losses now come from the durable ledger (hash-gated classification inside
  // syncLossLedger — a cold CLI run classifies any un-hashed Звіт itself, so no
  // prior nightly is required). Approver instruction rows override extraction.
  const { rows: lossRows } = await syncLossLedger(period, { onLog: log });
  const losses: LossRecord[] = effectiveLosses(lossRows, { start: period.start, end: period.end });
  log(`field-bonus: ${losses.filter((l) => !l.found).length} unrecovered loss(es)`);

  const corrections = await readRosterCorrections();
  const days: QualifiedDay[] = verdicts.days.map((d) => {
    const parsed = d.reportTs ? parsedByReportTs.get(d.reportTs) : undefined;
    return {
      date: d.date,
      reportTs: d.reportTs,
      reportCount: d.reportCount,
      status: d.status,
      roster: d.roster,
      unknownInitials: d.unknownInitials,
      deployMin: d.deployMin ?? parsed?.deployMin ?? null,
      videoMin: roundVideoMin(d.videoMinutes),
      start: parsed?.start ?? null,
      reasons: d.reasons,
      // Flight evidence = airborne minutes, an unquantified Звіт, or a known
      // deploy window (0-airborne + deploy window = contradictory data, still
      // money at stake for review).
      flew:
        d.airborneMinutes > 0 ||
        !d.airborneReported ||
        (d.deployMin ?? parsed?.deployMin ?? null) != null,
    };
  });
  const report = computeBonuses({ period, days, losses, corrections });
  log(`field-bonus: ${report.days.filter((x) => x.counted).length} counted day(s), ${report.pendingDays.length} pending, ${report.voidedDays.length} voided`);

  if (opts.write) {
    const { key } = await writeReport("field-bonus", period, { json: JSON.stringify(report), csv: toCsv(report) });
    log(`field-bonus: wrote report for ${key}`);
  }
  return report;
}
