/**
 * CLI: fetch Jira dev-reporting stats for a date window and print them.
 *
 * Usage: npm run jira -- --start 2026-05-01 --end 2026-05-31 [--format table]
 * Defaults to the current calendar month (UTC) when bounds are omitted.
 *
 * Output mirrors `GET /api/jira`: per-user resolved counts + story points,
 * period totals, and sprint churn — the same shaping the dashboard consumes.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so
 * the `server-only` import in ../lib/jira resolves to its empty module.
 */
import { fetchResolvedIssues } from "../lib/jira";
import { aggregateByUser, sprintChurn } from "../lib/jiraStats";
import { formatTable, parseArgs, resolvePeriod, type JiraReport } from "./jiraReport";

/** Today's date (YYYY-MM-DD) in UTC. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
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
  const { rows, totals } = aggregateByUser(issues);
  const report: JiraReport = { rows, totals, sprintChurn: sprintChurn(issues) };

  if (args.format === "table") {
    console.log(formatTable(period, report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`jira: ${message}\n`);
  process.exit(1);
});
