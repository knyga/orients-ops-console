import { FIELD_TIMEZONE } from "../lib/reconcile";

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

export interface ExtractedDay {
  date: string;
  airborneSeconds: number;
  flights: number;
  sourceTs: string;
}

export interface ReportDay {
  date: string;
  flightHours: number;
  airborneMinutes: number;
  flights: number;
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
 * non-finite/non-positive airborneSeconds, dedupe by date keeping the first
 * occurrence (and, on a tie, the lexicographically smallest sourceTs), and sort
 * ascending by date. Does NOT sum airborne across duplicates — keeps one reading
 * per day.
 */
export function validateDays(days: ExtractedDay[]): ExtractedDay[] {
  const byDate = new Map<string, ExtractedDay>();
  for (const d of days) {
    if (!DATE_RE.test(d.date) || !Number.isFinite(d.airborneSeconds) || d.airborneSeconds <= 0) continue;
    const existing = byDate.get(d.date);
    if (!existing) {
      byDate.set(d.date, { ...d });
    } else {
      // On duplicate date keep existing entry but take the smaller sourceTs
      if (d.sourceTs < existing.sourceTs) existing.sourceTs = d.sourceTs;
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The fieldops input contract: `date,flight_hours` header + one row per day. */
export function toInputsCsv(days: ExtractedDay[]): string {
  const lines = ["date,flight_hours"];
  for (const d of days) lines.push(`${d.date},${round2(d.airborneSeconds / 3600)}`);
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
    flightHours: round2(d.airborneSeconds / 3600),
    airborneMinutes: round2(d.airborneSeconds / 60),
    flights: d.flights,
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
  lines.push("Date         Airborne(min)   Flights");
  lines.push("-----------  -------------   -------");
  for (const d of days) {
    lines.push(`${d.date}   ${String(d.airborneMinutes).padStart(13)}   ${d.flights}`);
  }
  lines.push("-----------  -------------   -------");
  lines.push(`TOTAL        ${String(totals.flightHours).padStart(13)} h   (${totals.days} days)`);
  return lines.join("\n");
}
