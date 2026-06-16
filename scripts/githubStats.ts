import type { DevStatsSummary } from "../lib/devStats";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OutputFormat = "json" | "table";

export interface ParsedArgs {
  start?: string;
  end?: string;
  format: OutputFormat;
  /** When true, persist committed reports/github/<period>.{json,csv}. */
  write: boolean;
  /** When true, generate per-contributor occupation summaries via Claude. */
  summarize: boolean;
  /**
   * When set, read per-contributor summaries (a JSON object of contributor key
   * → text) from this file instead of calling Claude. Implies --write.
   */
  summariesFile?: string;
  /**
   * When true, print per-contributor work items (PR titles + commit headlines)
   * as JSON and exit — the input an external summarizer consumes.
   */
  dumpWork: boolean;
}

export interface Period {
  start: string;
  end: string;
}

/** Parse `--start`, `--end`, `--format` from raw CLI args. Unknown flags ignored. */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    start: undefined,
    end: undefined,
    format: "json",
    write: false,
    summarize: false,
    summariesFile: undefined,
    dumpWork: false,
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
    } else if (flag === "--summaries-file") {
      args.summariesFile = value;
      i += 1;
    } else if (flag === "--dump-work") {
      args.dumpWork = true;
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

/** Quote a CSV field per RFC 4180 only when it contains `,`, `"`, or newline. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Per-contributor stats as CSV
 * (`contributor,commits,additions,deletions,net,prsOpened,prsMerged,summary`),
 * one row per contributor, trailing newline — the flat human/spreadsheet record.
 * The repo ranking and per-PR detail stay in the JSON sidecar (this CSV is
 * intentionally lossy). `summary` is the occupation summary looked up from
 * `summaries` by the contributor's stable key (`login:…`/`name:…`); empty when
 * no summaries are provided (the column is always present for a stable schema).
 */
export function toCsv(
  summary: DevStatsSummary,
  summaries?: Map<string | null, string>,
): string {
  const lines = [
    "contributor,commits,additions,deletions,net,prsOpened,prsMerged,summary",
  ];
  for (const c of summary.contributors) {
    const text = summaries?.get(c.key) ?? "";
    lines.push(
      `${csvField(c.displayName)},${c.commits},${c.additions},${c.deletions},${c.net},${c.prsOpened},${c.prsMerged},${csvField(text)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
