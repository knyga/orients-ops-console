/**
 * One-off backfill: load the committed report artifacts (reports/<feature>/<period>.json
 * + .csv) from disk into the Postgres `reports` table, so the web (which now reads
 * Postgres) keeps showing the history that used to live in git. Idempotent
 * (writeReport upserts). Agent state (mirror/resolutions/published/asks) is NOT
 * imported — it re-accrues live in Postgres.
 *
 * Usage: npm run db:import
 * Runs under `--conditions=react-server` so the server-only chain resolves.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeReport } from "../lib/reports";
import { parsePeriodKey } from "../lib/period";

const ROOT = join(process.cwd(), "reports");
// Subdirs that are NOT (feature/<period>.json) report artifacts.
const SKIP_DIRS = new Set(["inputs", "resolutions", "published", "asks"]);

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }
  if (!existsSync(ROOT)) {
    process.stderr.write("db-import: no reports/ directory — nothing to import.\n");
    return;
  }

  let imported = 0;
  for (const feature of readdirSync(ROOT)) {
    const dir = join(ROOT, feature);
    if (SKIP_DIRS.has(feature) || !statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const key = file.slice(0, -".json".length);
      const period = parsePeriodKey(key);
      if (!period) {
        process.stderr.write(`db-import: skipping ${feature}/${file} (not a period key).\n`);
        continue;
      }
      const json = readFileSync(join(dir, file), "utf8");
      const csvPath = join(dir, `${key}.csv`);
      const csv = existsSync(csvPath) ? readFileSync(csvPath, "utf8") : "";
      await writeReport(feature, period, { json, csv });
      imported += 1;
      console.log(`imported ${feature}/${key}`);
    }
  }
  process.stderr.write(`db-import: ${imported} report(s) loaded into Postgres.\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`db-import: ${message}\n`);
  process.exit(1);
});
