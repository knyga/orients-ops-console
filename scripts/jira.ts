/**
 * CLI: fetch Jira dev-reporting stats for a date window and print them.
 *
 * Usage: npm run jira -- --start 2026-05-01 --end 2026-05-31 [--format table]
 *        npm run jira -- --start 2026-05-01 --end 2026-05-31 --write [--summarize]
 * Defaults to the current calendar month (UTC) when bounds are omitted.
 *
 * Output mirrors `GET /api/jira`: per-user resolved counts + story points,
 * period totals, and sprint churn — the same shaping the dashboard consumes.
 * `--write` persists the period as committed artifacts under reports/jira/: a
 * lossless `<period>.json` (the web's render source) and a flat `<period>.csv`
 * human record, in addition to printing to stdout. `--summarize`
 * adds a per-user occupation summary column (via Claude); it implies `--write`.
 * `--summaries-file <path>` supplies those summaries from a JSON file
 * (accountId → text) instead of calling Claude — the path used when Claude Code
 * sonnet subagents generate the prose; it also implies `--write`.
 * `--dump-tickets` prints per-user tickets (key + title) as JSON and exits — the
 * input those subagents consume.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so
 * the `server-only` import in ../lib/jira resolves to its empty module.
 */
import { readFileSync } from "node:fs";
import { fetchResolvedIssues } from "../lib/jira";
import { aggregateByUser, sprintChurn, ticketsByUser } from "../lib/jiraStats";
import { summarizeOccupations } from "../lib/summarize";
import { writeReport } from "../lib/reports";
import {
  formatTable,
  parseArgs,
  resolvePeriod,
  toCsv,
  type JiraReport,
  type Period,
} from "./jiraReport";

/**
 * Persist the period's committed artifacts: a lossless `<period>.json` (the
 * web's render source — the JiraReport plus, when present, per-user summaries
 * keyed by accountId so the committed view can show them without a live Claude
 * call) and a flat `<period>.csv` human record. Returns the paths written.
 */
async function writeArtifacts(
  period: Period,
  report: JiraReport,
  summaries?: Map<string | null, string>,
): Promise<{ key: string }> {
  const body =
    summaries && summaries.size > 0
      ? {
          ...report,
          // Drop the null (Unassigned) bucket — it carries no summary.
          summaries: Object.fromEntries(
            [...summaries].filter((entry): entry is [string, string] => entry[0] !== null),
          ),
        }
      : report;
  return writeReport("jira", period, {
    json: JSON.stringify(body, null, 2),
    csv: toCsv(report, summaries),
  });
}


/** Today's date (YYYY-MM-DD) in UTC. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Load externally-supplied per-user summaries from a JSON file. The file is a
 * plain object of accountId → summary text (the Unassigned bucket, accountId
 * null, has no key). Returned as the same Map shape summarizeOccupations yields,
 * so the table/CSV consume it identically.
 */
function loadSummariesFile(path: string): Map<string | null, string> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  return new Map<string | null, string>(Object.entries(raw));
}

async function main(): Promise<void> {
  // Load .env (where the JIRA_* vars live) if present; ignore if absent.
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayUtc());

  const issues = await fetchResolvedIssues(period.start, period.end);

  // --dump-tickets: emit per-user tickets (key + title) for an external
  // summarizer (e.g. Claude Code sonnet subagents) and exit. No Claude, no CSV.
  if (args.dumpTickets) {
    console.log(JSON.stringify(ticketsByUser(issues), null, 2));
    return;
  }

  const { rows, totals } = aggregateByUser(issues);
  const report: JiraReport = { rows, totals, sprintChurn: sprintChurn(issues) };

  // Compute summaries once (used by both the table view and the CSV). They come
  // either from an external file (--summaries-file) or from Claude (--summarize).
  let summaries: Map<string | null, string> | undefined;
  if (args.summariesFile) {
    summaries = loadSummariesFile(args.summariesFile);
    process.stderr.write(
      `jira: loaded ${summaries.size} summaries from ${args.summariesFile}\n`,
    );
  } else if (args.summarize) {
    process.stderr.write(`jira: summarizing ${rows.length} users via Claude…\n`);
    summaries = await summarizeOccupations(ticketsByUser(issues));
  }

  if (args.format === "table") {
    console.log(formatTable(period, report, summaries));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  // --summarize / --summaries-file imply --write (so summaries are persisted).
  if (args.write || args.summarize || args.summariesFile) {
    const { key } = await writeArtifacts(period, report, summaries);
    process.stderr.write(
      `jira: wrote jira/${key} (${report.rows.length} users, ${totals.totalResolved} resolved, ${totals.totalStoryPoints} points${summaries ? ", with summaries" : ""})\n`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`jira: ${message}\n`);
  process.exit(1);
});
