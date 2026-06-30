/**
 * Pure CLI shaping for the field-day verdict report: arg parsing, period
 * resolution, summary, table + CSV. No server/Next imports — unit-tested,
 * mirrors scripts/fieldopsReport.ts. Domain logic lives in ../lib/fieldDayVerdict.
 */
import type { DayVerdict } from "../lib/fieldDayVerdict";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OutputFormat = "json" | "table";

export interface Period {
  start: string;
  end: string;
}

export interface ParsedArgs {
  start?: string;
  end?: string;
  format: OutputFormat;
  write: boolean;
}

export interface VerdictSummary {
  accepted: number;
  pending: number;
  needsReview: number;
  acceptedException: number;
  rejected: number;
}

export interface VerdictReport {
  period: Period;
  runDate: string;
  graceWorkingDays: number;
  days: DayVerdict[];
  summary: VerdictSummary;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { format: "json", write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") { args.start = value; i += 1; }
    else if (flag === "--end") { args.end = value; i += 1; }
    else if (flag === "--format") { args.format = value === "table" ? "table" : "json"; i += 1; }
    else if (flag === "--write") { args.write = true; }
  }
  return args;
}

export function defaultMonthWindow(today: string): Period {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

export function resolvePeriod(args: ParsedArgs, today: string): Period {
  let start = args.start;
  let end = args.end;
  if (!start || !end) ({ start, end } = defaultMonthWindow(today));
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }
  return { start, end };
}

export function summarize(days: DayVerdict[]): VerdictSummary {
  const s: VerdictSummary = { accepted: 0, pending: 0, needsReview: 0, acceptedException: 0, rejected: 0 };
  for (const d of days) {
    if (d.status === "ACCEPTED") s.accepted += 1;
    else if (d.status === "PENDING") s.pending += 1;
    else if (d.status === "NEEDS_REVIEW") s.needsReview += 1;
    else if (d.status === "REJECTED") s.rejected += 1;
    else s.acceptedException += 1;
  }
  return s;
}

export function buildReport(days: DayVerdict[], period: Period, runDate: string, graceWorkingDays: number): VerdictReport {
  return { period, runDate, graceWorkingDays, days, summary: summarize(days) };
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(report: VerdictReport): string {
  const lines = ["date,status,airborneMinutes,videoMinutes,ratio,datasetStatus,reasons,roster"];
  for (const d of report.days) {
    lines.push([
      d.date,
      d.status,
      String(d.airborneMinutes),
      String(d.videoMinutes),
      d.ratio === null ? "" : d.ratio.toFixed(3),
      d.datasetStatus,
      csvField(d.reasons.join("; ")),
      csvField(d.roster.join("; ")),
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

const STATUS_ICON: Record<string, string> = {
  ACCEPTED: "✅",
  PENDING: "⏳",
  NEEDS_REVIEW: "⚠️",
  ACCEPTED_EXCEPTION: "🟡",
  REJECTED: "⛔",
};

const DATASET_ICON: Record<string, string> = {
  POSTED: "✓",
  WAIVED: "📝",
  MISSING: "✗",
  DECLINED: "⛔",
};

export function formatTable(report: VerdictReport): string {
  const lines: string[] = [];
  lines.push(`Field-day verdict   ${report.period.start} … ${report.period.end}   (as of ${report.runDate}, grace ${report.graceWorkingDays}wd)`);
  lines.push("");
  lines.push("Date         Status               Air(m)  Vid(m)  Ratio  DS  Crew                  Reasons");
  lines.push("----------   ------------------   ------  ------  -----  --  ----                  -------");
  if (report.days.length === 0) {
    lines.push("(no flight days in this period)");
  } else {
    for (const d of report.days) {
      const crew = [...d.roster, ...d.unknownInitials.map((u) => `?${u}`)].join(", ");
      lines.push(
        `${d.date}   ${((STATUS_ICON[d.status] ?? "") + " " + d.status).padEnd(18)}   ${String(d.airborneMinutes).padStart(6)}  ${String(d.videoMinutes).padStart(6)}  ${(d.ratio === null ? "—" : d.ratio.toFixed(2)).padStart(5)}  ${((DATASET_ICON[d.datasetStatus] ?? "?") + " ").padEnd(2)}  ${crew.padEnd(20)}  ${d.reasons.join("; ")}`,
      );
    }
  }
  const s = report.summary;
  lines.push("");
  lines.push(`Totals: ✅ ${s.accepted}  ⏳ ${s.pending}  ⚠️ ${s.needsReview}  🟡 ${s.acceptedException}  ⛔ ${s.rejected}`);
  return lines.join("\n");
}
