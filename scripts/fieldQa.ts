/**
 * CLI: read each #field-qa daily flight-summary (stats bot) and extract the
 * airborne time (Час в повітрі), then (optionally) persist it as the field-ops
 * reconciliation input.
 *
 * Thin wrapper over lib/fieldQaExtract (shared with the /api/cron/field-nightly
 * route) — the extraction/report logic lives there. The CLI adds the one thing
 * the cron must not do: mirror the report's CSV to the fieldops inputs path
 * (reports/field-ops/inputs/<period>.csv), a real filesystem artifact.
 *
 * Usage: npm run field-qa -- --start 2026-06-01 --end 2026-06-18 [--format table]
 *        npm run field-qa -- --start … --end … --write
 * Defaults to the current Europe/Kyiv month when bounds are omitted.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so the
 * `server-only` imports in ../lib resolve.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { defaultBaseDir, periodKey } from "../lib/reports";
import { extractFieldQa } from "../lib/fieldQaExtract";
import {
  formatTable,
  parseArgs,
  resolvePeriod,
  type Period,
} from "./fieldQaReport";

/** Today's date (YYYY-MM-DD) in the field timezone. */
function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Reconciliation input path for a period (matches scripts/fieldops.ts). */
function inputsPath(period: Period): string {
  return join(defaultBaseDir(), "field-ops", "inputs", `${periodKey(period)}.csv`);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayInFieldTz());

  const { report, inputsCsv } = await extractFieldQa(period, {
    write: args.write,
    onLog: (m) => process.stderr.write(`${m}\n`),
  });

  if (args.format === "table") {
    console.log(formatTable(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  if (args.write) {
    // CLI-only: mirror the DB report's CSV to the fieldops inputs path (fs artifact).
    const inputs = inputsPath(period);
    mkdirSync(dirname(inputs), { recursive: true });
    writeFileSync(inputs, inputsCsv);
    process.stderr.write(`field-qa: wrote ${inputs}\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-qa: ${message}\n`);
  process.exit(1);
});
