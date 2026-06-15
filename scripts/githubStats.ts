import type { DevStatsSummary } from "../lib/devStats";

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
    throw new Error(
      `Period bounds must be YYYY-MM-DD: start=${start} end=${end}`,
    );
  }
  return { start, end };
}

/** Signed integer for the net column (e.g. +120, -8, 0). */
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** Render a DevStatsSummary as a compact human-readable table (UTC days). */
export function formatTable(summary: DevStatsSummary): string {
  const { org, period, totals, contributors, repos } = summary;
  const lines: string[] = [];
  lines.push(`GitHub activity: ${org}   ${period.start} … ${period.end} (UTC)`);
  lines.push(
    `Repos ${totals.repos}   Contributors ${totals.contributors}   ` +
      `Default-branch commits ${totals.commits}   Net ${signed(totals.net)}   ` +
      `PRs opened ${totals.prsOpened}   PRs merged ${totals.prsMerged}`,
  );
  lines.push(
    "(Commits = commits landed on each repo's default branch; PRs counted by created/merged date.)",
  );
  lines.push("");
  lines.push("Contributors");
  lines.push(
    "Name                        Commits     +Add     -Del      Net  PRopen  PRmrg",
  );
  lines.push(
    "-------------------------  --------  -------  -------  -------  ------  -----",
  );
  for (const c of contributors) {
    const tag = c.isBot ? " [bot]" : c.unlinked ? " (unlinked)" : "";
    const name = (c.displayName + tag).slice(0, 25).padEnd(25);
    lines.push(
      `${name}  ${String(c.commits).padStart(8)}  ${String(c.additions).padStart(7)}  ` +
        `${String(c.deletions).padStart(7)}  ${signed(c.net).padStart(7)}  ` +
        `${String(c.prsOpened).padStart(6)}  ${String(c.prsMerged).padStart(5)}`,
    );
  }
  lines.push("");
  lines.push("Most active repositories");
  lines.push(
    "Repository                    Commits     +Add     -Del  PRopen  PRmrg",
  );
  lines.push(
    "---------------------------  --------  -------  -------  ------  -----",
  );
  for (const r of repos) {
    const name = r.repo.slice(0, 27).padEnd(27);
    lines.push(
      `${name}  ${String(r.commits).padStart(8)}  ${String(r.additions).padStart(7)}  ` +
        `${String(r.deletions).padStart(7)}  ${String(r.prsOpened).padStart(6)}  ` +
        `${String(r.prsMerged).padStart(5)}`,
    );
  }
  return lines.join("\n");
}
