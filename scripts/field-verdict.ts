/**
 * CLI: compute the per-flight-day bonus-acceptance verdict for a window.
 *
 * Usage: npm run field-verdict -- --start 2026-06-01 --end 2026-06-19 [--format table]
 *        npm run field-verdict -- --start … --end … --write
 * Defaults to the current Europe/Kyiv month.
 *
 * Inputs:
 *  - airborne minutes per flight day ← committed reports/field-qa/<period>.json (S2)
 *  - video minutes per flight day    ← live Vimeo, attributed by videoFlightDate
 *  - #datasets notice per day         ← the local Slack mirror (run `npm run slack-sync` first)
 *  - exceptions                       ← the resolutions store
 * `--write` persists reports/field-verdict/<period>.{json,csv}.
 *
 * The computation is shared with the nightly cron (/api/cron/field-nightly) via lib/computeVerdicts.
 * Runs under `--conditions=react-server` so the server-only Vimeo import resolves.
 */
import { computeVerdicts, todayInFieldTz } from "../lib/computeVerdicts";
import { formatTable, parseArgs, resolvePeriod, type Period } from "./fieldVerdictReport";

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }

  const args = parseArgs(process.argv.slice(2));
  const today = todayInFieldTz();
  const period: Period = resolvePeriod(args, today);

  const report = await computeVerdicts(period, {
    today,
    write: args.write,
    onLog: (message) => process.stderr.write(`${message}\n`),
  });

  if (args.format === "table") console.log(formatTable(report));
  else console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-verdict: ${message}\n`);
  process.exit(1);
});
