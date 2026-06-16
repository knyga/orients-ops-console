/**
 * Pure CLI shaping for Field Ops reconciliation: arg parsing, period resolution,
 * the reconciliation build, the human-readable table, and the flat CSV. No
 * server/Next imports — unit-tested. The gate/aggregation itself is reused
 * verbatim from ../lib/reconcile (Kyiv day boundary + 50% MIN_RATIO preserved).
 */
import {
  aggregateByDay,
  summarize,
  FIELD_TIMEZONE,
  type DailyRecon,
  type FlightDay,
  type PeriodSummary,
  type ReconVideo,
} from "../lib/reconcile";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OutputFormat = "json" | "table";

export interface ParsedArgs {
  start?: string;
  end?: string;
  format: OutputFormat;
  /** Path to the committed flight-hours CSV; defaults per-period in the CLI. */
  inputs?: string;
  /** When true, persist committed reports/field-ops/<period>.{json,csv}. */
  write: boolean;
}

export interface Period {
  start: string;
  end: string;
  timezone: string;
}

/** The reconciliation report payload — also the committed JSON artifact shape. */
export interface FieldOpsReport {
  period: Period;
  daily: DailyRecon[];
  summary: PeriodSummary;
  /** Where the flight hours came from, or null when none were available. */
  flightInputPath: string | null;
}

/** Parse `--start`, `--end`, `--format`, `--inputs`, `--write`. Unknown flags ignored. */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    start: undefined,
    end: undefined,
    format: "json",
    inputs: undefined,
    write: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") {
      args.start = value;
      i += 1;
    } else if (flag === "--end") {
      args.end = value;
      i += 1;
    } else if (flag === "--format") {
      args.format = value === "table" ? "table" : "json";
      i += 1;
    } else if (flag === "--inputs") {
      args.inputs = value;
      i += 1;
    } else if (flag === "--write") {
      args.write = true;
    }
  }
  return args;
}

/** First day of `today`'s month through `today` (both YYYY-MM-DD). */
export function defaultMonthWindow(today: string): { start: string; end: string } {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

/**
 * Resolve the reporting window. Uses explicit `--start`/`--end` only when BOTH
 * are present; otherwise falls back to the current month (a lone bound is
 * ignored). Throws on a malformed explicit bound. Carries the field timezone.
 */
export function resolvePeriod(args: ParsedArgs, today: string): Period {
  let start = args.start;
  let end = args.end;
  if (!start || !end) {
    ({ start, end } = defaultMonthWindow(today));
  }
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }
  return { start, end, timezone: FIELD_TIMEZONE };
}

/**
 * Build the reconciliation report: apply the 50% gate to videos (grouped by
 * Kyiv upload day) against the logged flight hours. Pure — delegates to the
 * tested aggregateByDay/summarize.
 */
export function buildReconciliation(
  videos: ReconVideo[],
  flightDays: FlightDay[],
  period: Period,
  flightInputPath: string | null,
): FieldOpsReport {
  const daily = aggregateByDay(videos, flightDays);
  return { period, daily, summary: summarize(daily), flightInputPath };
}

/** Round to one decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Render the reconciliation as a compact human-readable table. */
export function formatTable(report: FieldOpsReport): string {
  const { period, daily, summary } = report;
  const lines: string[] = [];
  lines.push(`Field Ops reconciliation   ${period.start} … ${period.end} (${period.timezone})`);
  lines.push(
    `Videos ${summary.totalVideos}   Recorded min ${round1(summary.totalRecordedMinutes)}   Flagged days ${summary.flaggedDays.length}`,
  );
  lines.push("(A flight day passes when recorded video ≥ 50% of flight minutes; else FLAG.)");
  lines.push("");
  lines.push("Date         Videos   RecMin   FlightMin   Ratio  Status");
  lines.push("-----------  ------   ------   ---------   -----  ------");
  if (daily.length === 0) {
    lines.push("(no videos or flight entries in this period)");
  } else {
    for (const d of daily) {
      const ratio = d.ratio === null ? "  —  " : `${Math.round(d.ratio * 100)}%`.padStart(5);
      lines.push(
        `${d.date}   ${String(d.videoCount).padStart(6)}   ${String(round1(d.recordedMinutes)).padStart(6)}   ${String(round1(d.flightMinutes)).padStart(9)}   ${ratio}  ${d.status}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Per-day reconciliation as CSV
 * (`date,videoCount,recordedMinutes,flightMinutes,ratio,status`), one row per
 * day, trailing newline — the flat human/spreadsheet record. `ratio` is blank
 * when there are no flight minutes. All fields are numbers/ISO dates/enum, so no
 * RFC-4180 escaping is needed.
 */
export function toCsv(report: FieldOpsReport): string {
  const lines = ["date,videoCount,recordedMinutes,flightMinutes,ratio,status"];
  for (const d of report.daily) {
    const ratio = d.ratio === null ? "" : String(round1(d.ratio));
    lines.push(
      `${d.date},${d.videoCount},${round1(d.recordedMinutes)},${round1(d.flightMinutes)},${ratio},${d.status}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
