/**
 * Pure shaping for the `field-loss` CLI and GET /api/field-loss: the loss
 * ledger's effective view for a period, the unrecovered counter vs the team
 * cutoff, and any crew penalties from the committed field-bonus report.
 * No DB/Next imports — unit-tested.
 */
import { effectiveLosses, unrecoveredLossDates, type EffectiveLoss, type LossRow } from "../lib/lossLedger";
import { TEAM_LOSS_CUTOFF, type Penalty } from "../lib/fieldBonus";

export interface LossReport {
  period: { start: string; end: string };
  losses: EffectiveLoss[];
  unrecovered: number;
  cutoff: number;
  teamZeroed: boolean;
  /** Crew penalty exposure from the committed field-bonus report ([] when absent). */
  penalties: Penalty[];
}

export function parseArgs(argv: string[]): { start?: string; end?: string; format?: "table" } {
  const out: { start?: string; end?: string; format?: "table" } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--start") { out.start = argv[i + 1]; i += 1; }
    else if (argv[i] === "--end") { out.end = argv[i + 1]; i += 1; }
    else if (argv[i] === "--format") { if (argv[i + 1] === "table") out.format = "table"; i += 1; }
    else throw new Error(`Unknown flag ${argv[i]}`);
  }
  return out;
}

export function buildLossReport(rows: LossRow[], period: { start: string; end: string }, penalties: Penalty[]): LossReport {
  const losses = effectiveLosses(rows, period);
  const unrecovered = unrecoveredLossDates(rows, period).length;
  return { period, losses, unrecovered, cutoff: TEAM_LOSS_CUTOFF, teamZeroed: unrecovered > TEAM_LOSS_CUTOFF, penalties };
}

export function renderTable(report: LossReport): string {
  const lines = [
    `Drone losses ${report.period.start}..${report.period.end}`,
    ...report.losses.map((l) => `  ${l.date}  ${l.found ? "FOUND   " : "LOST    "}  ${l.note}`),
    ...(report.losses.length ? [] : ["  (none)"]),
    `unrecovered: ${report.unrecovered} / ${report.cutoff}${report.teamZeroed ? "  TEAM ZEROED (>3)" : ""}`,
    ...report.penalties.map((p) => `  penalty ${p.group.join("+")}: -${p.pct * 100}% (${p.reason})`),
  ];
  return lines.join("\n");
}
