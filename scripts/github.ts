/**
 * CLI: fetch GitHub dev-reporting stats for a date window and print them.
 *
 * Usage: npm run github -- --start 2026-05-01 --end 2026-05-31 [--format table]
 * Defaults to the current calendar month (UTC) when bounds are omitted.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so
 * the `server-only` import in ../lib/github resolves to its empty module.
 */
import { fetchOrgActivityForPeriod } from "../lib/github";
import { summarize } from "../lib/devStats";
import { formatTable, parseArgs, resolvePeriod } from "./githubStats";

/** Today's date (YYYY-MM-DD) in UTC. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  // Load .env (where GH_ACCESS_TOKEN lives) if present; ignore if absent.
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayUtc());

  const activity = await fetchOrgActivityForPeriod(period.start, period.end);
  const summary = summarize(activity);

  if (args.format === "table") {
    console.log(formatTable(summary));
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`github: ${message}\n`);
  process.exit(1);
});
