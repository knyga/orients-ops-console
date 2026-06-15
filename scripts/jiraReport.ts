/**
 * Pure CLI shaping for Jira Dev Reporting: arg parsing, period resolution, and
 * the human-readable table view. No server/Next imports — unit-tested, mirrors
 * scripts/githubStats.ts. The domain aggregation lives in ../lib/jiraStats.
 */
import type { PeriodTotals, SprintChurnRow, UserRow } from "../lib/jiraStats";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OutputFormat = "json" | "table";

export interface ParsedArgs {
  start?: string;
  end?: string;
  format: OutputFormat;
  /** When true, persist the report as a CSV under reports/jira/. */
  write: boolean;
  /** When true, generate per-user occupation summaries (via Claude) for the CSV. */
  summarize: boolean;
}

export interface Period {
  start: string;
  end: string;
}

/** The CLI's report payload — same shape as `GET /api/jira` returns. */
export interface JiraReport {
  rows: UserRow[];
  totals: PeriodTotals;
  sprintChurn: SprintChurnRow[];
}

/** Parse `--start`, `--end`, `--format` from raw CLI args. Unknown flags ignored. */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    start: undefined,
    end: undefined,
    format: "json",
    write: false,
    summarize: false,
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
    } else if (flag === "--summarize") {
      args.summarize = true;
    }
  }
  return args;
}

/** First day of `today`'s month through `today` (both YYYY-MM-DD). */
export function defaultMonthWindow(today: string): Period {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

/**
 * Resolve the reporting window. Uses explicit `--start`/`--end` only when BOTH
 * are present; otherwise falls back to the current month (a lone bound is
 * ignored, avoiding an inverted window). Throws on a malformed explicit bound.
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

/** Greedy word-wrap; collapses all whitespace (incl. newlines) first. */
function wrapText(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [""];
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      out.push(line);
      line = word;
    }
  }
  out.push(line);
  return out;
}

/**
 * Render a JiraReport as a compact human-readable table. When `summaries` is
 * provided (the `--summarize` path), a wrapped Summary column is added to the
 * per-user table and the Issues list is truncated to keep columns aligned.
 */
export function formatTable(
  period: Period,
  report: JiraReport,
  summaries?: Map<string | null, string>,
): string {
  const { rows, totals, sprintChurn } = report;
  const withSummary = (summaries?.size ?? 0) > 0;
  const lines: string[] = [];
  lines.push(`Jira dev reporting   ${period.start} … ${period.end}`);
  lines.push(`Resolved ${totals.totalResolved}   Story points ${totals.totalStoryPoints}`);
  lines.push(
    "(Issues resolved within the period, grouped by assignee; story points sum per user.)",
  );
  lines.push("");
  lines.push("Resolved by user");
  if (withSummary) {
    appendUserTableWithSummary(lines, rows, summaries!);
  } else {
    lines.push("User                          Resolved  Points  Issues");
    lines.push("---------------------------  ---------  ------  ------");
    if (rows.length === 0) {
      lines.push("(none)");
    } else {
      for (const row of rows) {
        const name = row.displayName.slice(0, 27).padEnd(27);
        // Issues is the last column, so its (possibly wrapping) list never
        // disturbs the Resolved/Points alignment above.
        lines.push(
          `${name}  ${String(row.resolvedCount).padStart(9)}  ${String(row.storyPoints).padStart(6)}  ${row.issueKeys.join(", ")}`,
        );
      }
    }
  }
  lines.push("");
  lines.push("Sprint changes");
  if (sprintChurn.length === 0) {
    lines.push("No issues changed sprints in this period.");
  } else {
    for (const item of sprintChurn) {
      lines.push(`${item.issueKey}  ${item.summary}`);
      for (const c of item.changes) {
        lines.push(`    ${c.from || "—"} → ${c.to || "—"}   (${c.when})`);
      }
    }
  }
  return lines.join("\n");
}

// Column widths for the summarized per-user table.
const NAME_W = 22;
const RESOLVED_W = 8;
const POINTS_W = 6;
const ISSUES_W = 22;
const SUMMARY_W = 50;

/**
 * Append the per-user table with a wrapped Summary column. Issues are truncated
 * to ISSUES_W; the summary wraps to SUMMARY_W with continuation lines indented
 * under the Summary column so the fixed columns stay aligned.
 */
function appendUserTableWithSummary(
  lines: string[],
  rows: UserRow[],
  summaries: Map<string | null, string>,
): void {
  const head =
    "User".padEnd(NAME_W) +
    "  " +
    "Resolved".padStart(RESOLVED_W) +
    "  " +
    "Points".padStart(POINTS_W) +
    "  " +
    "Issues".padEnd(ISSUES_W) +
    "  " +
    "Summary";
  lines.push(head);
  const prefixW = NAME_W + 2 + RESOLVED_W + 2 + POINTS_W + 2 + ISSUES_W + 2;
  lines.push("-".repeat(prefixW + SUMMARY_W));
  if (rows.length === 0) {
    lines.push("(none)");
    return;
  }
  for (const row of rows) {
    const name = row.displayName.slice(0, NAME_W).padEnd(NAME_W);
    const resolved = String(row.resolvedCount).padStart(RESOLVED_W);
    const points = String(row.storyPoints).padStart(POINTS_W);
    const issuesFull = row.issueKeys.join(" ");
    const issues = (
      issuesFull.length > ISSUES_W ? `${issuesFull.slice(0, ISSUES_W - 1)}…` : issuesFull
    ).padEnd(ISSUES_W);
    const summaryLines = wrapText(summaries.get(row.accountId) ?? "", SUMMARY_W);
    const prefix = `${name}  ${resolved}  ${points}  ${issues}  `;
    lines.push(prefix + summaryLines[0]);
    const pad = " ".repeat(prefixW);
    for (const line of summaryLines.slice(1)) lines.push(pad + line);
  }
}

/**
 * Stable filename for a period's CSV report. A window inside one calendar month
 * collapses to `YYYY-MM.csv` (the common monthly cadence); anything spanning
 * months keeps both explicit bounds: `YYYY-MM-DD_YYYY-MM-DD.csv`.
 */
export function reportFileName(period: Period): string {
  if (period.start.slice(0, 7) === period.end.slice(0, 7)) {
    return `${period.start.slice(0, 7)}.csv`;
  }
  return `${period.start}_${period.end}.csv`;
}

/** Quote a CSV field per RFC 4180 only when it contains `,`, `"`, or newline. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Per-user resolved stats as CSV
 * (`user,resolvedCount,storyPoints,issues,summary`), one row per user, trailing
 * newline. `issues` is a space-separated list of the keys that user resolved
 * (space keeps it a single unquoted field). `summary` is the Claude-generated
 * occupation summary looked up from `summaries` by accountId — empty when no
 * summaries are provided (the column is always present for a stable schema).
 * Sprint churn is hierarchical (many moves per issue), so it is intentionally
 * not flattened here — use the JSON/table views for it.
 */
export function toCsv(
  report: JiraReport,
  summaries?: Map<string | null, string>,
): string {
  const lines = ["user,resolvedCount,storyPoints,issues,summary"];
  for (const row of report.rows) {
    const summary = summaries?.get(row.accountId) ?? "";
    lines.push(
      `${csvField(row.displayName)},${row.resolvedCount},${row.storyPoints},${csvField(row.issueKeys.join(" "))},${csvField(summary)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
