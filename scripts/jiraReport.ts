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
  const args: ParsedArgs = { start: undefined, end: undefined, format: "json" };
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

/** Render a JiraReport as a compact human-readable table. */
export function formatTable(period: Period, report: JiraReport): string {
  const { rows, totals, sprintChurn } = report;
  const lines: string[] = [];
  lines.push(`Jira dev reporting   ${period.start} … ${period.end}`);
  lines.push(`Resolved ${totals.totalResolved}   Story points ${totals.totalStoryPoints}`);
  lines.push(
    "(Issues resolved within the period, grouped by assignee; story points sum per user.)",
  );
  lines.push("");
  lines.push("Resolved by user");
  lines.push("User                          Resolved  Points");
  lines.push("---------------------------  ---------  ------");
  if (rows.length === 0) {
    lines.push("(none)");
  } else {
    for (const row of rows) {
      const name = row.displayName.slice(0, 27).padEnd(27);
      lines.push(
        `${name}  ${String(row.resolvedCount).padStart(9)}  ${String(row.storyPoints).padStart(6)}`,
      );
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
