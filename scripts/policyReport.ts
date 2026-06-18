/**
 * Pure CLI shaping for Policy Execution Tracking: arg parsing, period
 * resolution, verdict merging, and the table/CSV views. No server/Next imports —
 * unit-tested, mirrors scripts/jiraReport.ts. The domain logic lives in
 * ../lib/policySchedule.
 */
import type {
  Occurrence,
  PolicySchedule,
  SkippedObligation,
} from "../lib/policySchedule";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OutputFormat = "json" | "table";
export type Verdict = "DONE" | "LATE" | "PARTIAL" | "MISSING";

export interface Period {
  start: string;
  end: string;
}

export interface ParsedArgs {
  start?: string;
  end?: string;
  format: OutputFormat;
  /** Persist the report under reports/policy/. */
  write: boolean;
  /** Print the NEEDS_REVIEW occurrences (with candidates) as JSON and exit. */
  dumpOccurrences: boolean;
  /** Read verdicts (occurrenceId → {verdict,rationale}) from this JSON file; implies --write. */
  verdictsFile?: string;
}

export interface VerdictEntry {
  verdict: Verdict;
  rationale: string;
}

/** Map of occurrenceId → verdict, as produced by the classification subagents. */
export type VerdictMap = Record<string, VerdictEntry>;

/** An occurrence with the (optional) Claude-assigned verdict merged in. */
export interface OccurrenceReport extends Occurrence {
  verdict?: Verdict;
  rationale?: string;
}

/** The committed report — same shape `GET /api/policy?period=…` returns. */
export interface PolicyReport {
  period: Period;
  runDate: string;
  occurrences: OccurrenceReport[];
  skipped: SkippedObligation[];
}

/** Parse the supported flags from raw CLI args. Unknown flags ignored. */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    start: undefined,
    end: undefined,
    format: "json",
    write: false,
    dumpOccurrences: false,
    verdictsFile: undefined,
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
    } else if (flag === "--write") {
      args.write = true;
    } else if (flag === "--dump-occurrences") {
      args.dumpOccurrences = true;
    } else if (flag === "--verdicts-file") {
      args.verdictsFile = value;
      i += 1;
    }
  }
  return args;
}

/** First day of `today`'s month through `today` (both YYYY-MM-DD). */
export function defaultMonthWindow(today: string): Period {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

/**
 * Resolve the reporting window: explicit `--start`/`--end` only when BOTH are
 * present; otherwise the current month. Throws on a malformed explicit bound.
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
  return { start, end };
}

/** Merge verdicts onto the schedule's occurrences (by id) → the committed report. */
export function applyVerdicts(
  schedule: PolicySchedule,
  runDate: string,
  verdicts?: VerdictMap,
): PolicyReport {
  const occurrences: OccurrenceReport[] = schedule.occurrences.map((o) => {
    const v = verdicts?.[o.id];
    return v ? { ...o, verdict: v.verdict, rationale: v.rationale } : { ...o };
  });
  return { period: schedule.period, runDate, occurrences, skipped: schedule.skipped };
}

/** Render a PolicyReport as a compact human-readable table. */
export function formatTable(report: PolicyReport): string {
  const lines: string[] = [];
  lines.push(`Policy execution   ${report.period.start} … ${report.period.end}   (as of ${report.runDate})`);
  lines.push("");
  lines.push("Due date     Status        Verdict   Ev  Obligation");
  lines.push("----------   -----------   -------   --  ----------");
  if (report.occurrences.length === 0) {
    lines.push("(no scheduled occurrences in this period)");
  } else {
    for (const o of report.occurrences) {
      lines.push(
        `${o.dueDate}   ${o.status.padEnd(11)}   ${(o.verdict ?? "—").padEnd(7)}   ${String(o.candidates.length).padStart(2)}  ${o.title}`,
      );
    }
  }
  if (report.skipped.length > 0) {
    lines.push("");
    lines.push("Skipped (not scheduled in v1):");
    for (const s of report.skipped) lines.push(`  ${s.obligationId} — ${s.reason}`);
  }
  return lines.join("\n");
}

/** Quote a CSV field per RFC 4180 only when it contains `,`, `"`, or newline. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Flat per-occurrence CSV (`obligation,channel,dueDate,status,verdict,rationale,
 * evidenceCount`), one row per occurrence, trailing newline. Lossy: the evidence
 * detail (authors, excerpts, permalinks) and the skipped list live only in the
 * JSON/table views.
 */
export function toCsv(report: PolicyReport): string {
  const lines = ["obligation,channel,dueDate,status,verdict,rationale,evidenceCount"];
  for (const o of report.occurrences) {
    lines.push(
      [
        csvField(o.title),
        csvField(o.channel),
        o.dueDate,
        o.status,
        o.verdict ?? "",
        csvField(o.rationale ?? ""),
        String(o.candidates.length),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
