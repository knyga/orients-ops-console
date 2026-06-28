/** Pure CLI helpers for field-bonus: arg parsing, period defaulting, CSV + table. */
import { parsePeriodKey, type Period } from "../lib/period";
import type { BonusReport } from "../lib/fieldBonus";

export interface BonusArgs { start?: string; end?: string; format?: string; write: boolean; ask: boolean; publish: boolean; sheet?: string }

export function parseArgs(argv: string[]): BonusArgs {
  const args: BonusArgs = { write: false, ask: false, publish: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--start") args.start = argv[++i];
    else if (a === "--end") args.end = argv[++i];
    else if (a === "--format") args.format = argv[++i];
    else if (a === "--sheet") args.sheet = argv[++i];
    else if (a === "--write") args.write = true;
    else if (a === "--ask") args.ask = true;
    else if (a === "--publish") args.publish = true;
  }
  return args;
}

export function resolvePeriod(args: BonusArgs, today: string): Period {
  if (args.start && args.end) return { start: args.start, end: args.end };
  const month = today.slice(0, 7);
  return parsePeriodKey(month)!;
}

export function toCsv(report: BonusReport): string {
  const head = "person,trips,early,weekend,gross,penaltyPct,net";
  const rows = report.people.map((p) => [p.name, p.trips, p.early, p.weekend, p.gross, p.penaltyPct, p.net].join(","));
  return [head, ...rows].join("\n");
}

export function formatTable(report: BonusReport): string {
  const lines = [`Field bonuses ${report.period.start}..${report.period.end}${report.teamZeroed ? " — TEAM ZEROED (>3 losses)" : ""}`];
  for (const p of report.people) lines.push(`  ${p.name.padEnd(14)} trips=${p.trips} early=${p.early} wknd=${p.weekend} gross=${p.gross} pen=${p.penaltyPct * 100}% net=${p.net}`);
  lines.push(`  TOTAL net=${report.total}`);
  if (report.flags.length) { lines.push("Flags:"); for (const f of report.flags) lines.push(`  [${f.kind}] ${f.date} ${f.detail}`); }
  return lines.join("\n");
}
