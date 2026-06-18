import { FIELD_TIMEZONE } from "../lib/reconcile";
import type { ExtractedDay, FlightWindow } from "../lib/flightExtractPrompt";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OutputFormat = "json" | "table";

export interface ParsedArgs {
  start?: string;
  end?: string;
  format: OutputFormat;
  write: boolean;
}

export interface Period {
  start: string;
  end: string;
  timezone: string;
}

export interface ReportDay {
  date: string;
  flightHours: number;
  windows: FlightWindow[];
  crew: string | null;
  permalink: string;
}

export interface FieldQaReport {
  period: Period;
  sourceChannel: string;
  days: ReportDay[];
  totals: { days: number; flightHours: number };
}

/** Round to two decimals (hours are derived from minute math). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Parse `--start`, `--end`, `--format`, `--write`. Unknown flags ignored. */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { start: undefined, end: undefined, format: "json", write: false };
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

/** First of `today`'s month through `today` (both YYYY-MM-DD). */
function defaultMonthWindow(today: string): { start: string; end: string } {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

/**
 * Resolve the window: explicit `--start`/`--end` only when BOTH present;
 * otherwise the full current month. Throws on a malformed explicit bound.
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
 * Validate LLM-extracted days: drop rows with a non-YYYY-MM-DD date or a
 * non-finite/non-positive flightHours, sum duplicate dates (merging windows,
 * keeping the first non-null crew and the lexicographically smallest sourceTs
 * for determinism), and sort ascending by date.
 */
export function validateDays(days: ExtractedDay[]): ExtractedDay[] {
  const byDate = new Map<string, ExtractedDay>();
  for (const d of days) {
    if (!DATE_RE.test(d.date) || !Number.isFinite(d.flightHours) || d.flightHours <= 0) continue;
    const existing = byDate.get(d.date);
    if (!existing) {
      byDate.set(d.date, {
        date: d.date,
        flightHours: d.flightHours,
        windows: [...(d.windows ?? [])],
        crew: d.crew ?? null,
        sourceTs: d.sourceTs,
      });
    } else {
      existing.flightHours += d.flightHours;
      existing.windows.push(...(d.windows ?? []));
      existing.crew = existing.crew ?? d.crew ?? null;
      if (d.sourceTs < existing.sourceTs) existing.sourceTs = d.sourceTs;
    }
  }
  return [...byDate.values()]
    .map((d) => ({ ...d, flightHours: round2(d.flightHours) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The fieldops input contract: `date,flight_hours` header + one row per day. */
export function toInputsCsv(days: ExtractedDay[]): string {
  const lines = ["date,flight_hours"];
  for (const d of days) lines.push(`${d.date},${d.flightHours}`);
  return `${lines.join("\n")}\n`;
}

/** Build the lossless report artifact, attaching a Slack permalink per day. */
export function buildReport(
  days: ExtractedDay[],
  period: Period,
  permalinkByTs: Map<string, string>,
): FieldQaReport {
  const reportDays: ReportDay[] = days.map((d) => ({
    date: d.date,
    flightHours: d.flightHours,
    windows: d.windows,
    crew: d.crew,
    permalink: permalinkByTs.get(d.sourceTs) ?? "",
  }));
  const flightHours = round2(reportDays.reduce((sum, d) => sum + d.flightHours, 0));
  return {
    period,
    sourceChannel: "field-qa",
    days: reportDays,
    totals: { days: reportDays.length, flightHours },
  };
}

/** Render the report as a compact human-readable table. */
export function formatTable(report: FieldQaReport): string {
  const { period, totals, days } = report;
  const lines: string[] = [];
  lines.push(`Field-QA flight hours: ${period.start} … ${period.end} (${period.timezone})`);
  lines.push("");
  lines.push("Date         Hours   Crew");
  lines.push("-----------  -----   ----");
  for (const d of days) {
    lines.push(`${d.date}   ${String(d.flightHours).padStart(5)}   ${d.crew ?? ""}`);
  }
  lines.push("-----------  -----   ----");
  lines.push(`TOTAL        ${String(totals.flightHours).padStart(5)}   (${totals.days} days)`);
  return lines.join("\n");
}
