/**
 * CLI: fetch Vimeo video stats for a date window and print them.
 *
 * Usage: npm run vimeo -- --start 2026-05-01 --end 2026-05-31 [--format table]
 * Defaults to the current Europe/Kyiv calendar month when bounds are omitted.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so
 * the `server-only` import in ../lib/vimeo resolves to its empty module.
 */
import { fetchVideosInPeriod } from "../lib/vimeo";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { buildStats, formatTable, parseArgs, resolvePeriod } from "./vimeoStats";

/** Today's date (YYYY-MM-DD) in the field timezone. */
function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function main(): Promise<void> {
  // Load .env (where VIMEO_TOKEN lives) if present; ignore if absent.
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayInFieldTz());

  const videos = await fetchVideosInPeriod(period.start, period.end);
  const stats = buildStats(videos, period);

  if (args.format === "table") {
    console.log(formatTable(stats));
  } else {
    console.log(JSON.stringify(stats, null, 2));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`vimeo: ${message}\n`);
  process.exit(1);
});
