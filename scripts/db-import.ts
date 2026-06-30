/**
 * One-off backfill: load committed report artifacts AND durable agent state from
 * disk into Postgres, so the deployed app (which now reads Postgres) keeps the
 * history + in-flight verdicts that used to live on the filesystem. Idempotent
 * (every write upserts). Two parts:
 *   1. reports/<feature>/<period>.json (+ .csv) → the `reports` table.
 *   2. agent state → published / resolutions / asks tables:
 *        reports/published/<period>.json  (PublishedLog keyed by date)
 *        reports/resolutions/store.json   (Resolution[])
 *        reports/asks/<period>.json       (AskLog keyed by gapKey)
 *      Importing (2) matters: without it, a verdict published before the Postgres
 *      migration has no `published` row, so the events webhook can't find its
 *      thread and silently no-ops on approver replies.
 *
 * The Slack mirror is NOT imported — it re-syncs live via `slack-sync`.
 *
 * Usage: npm run db:import
 * Runs under `--conditions=react-server` so the server-only chain resolves.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeReport } from "../lib/reports";
import { writePublished, type PublishedLog } from "../lib/published";
import { upsertResolution, type Resolution } from "../lib/resolutions";
import { writeAsks, type AskLog } from "../lib/asks";
import { parsePeriodKey } from "../lib/period";

const ROOT = join(process.cwd(), "reports");
// Subdirs that are NOT (feature/<period>.json) report artifacts — handled separately.
const SKIP_DIRS = new Set(["inputs", "resolutions", "published", "asks"]);

/** Backfill the durable agent state (published / resolutions / asks) into Postgres. */
async function importAgentState(): Promise<void> {
  // published: one file per period, a PublishedLog keyed by date.
  const pubDir = join(ROOT, "published");
  if (existsSync(pubDir)) {
    for (const file of readdirSync(pubDir)) {
      if (!file.endsWith(".json")) continue;
      const period = parsePeriodKey(file.slice(0, -".json".length));
      if (!period) continue;
      const log = JSON.parse(readFileSync(join(pubDir, file), "utf8")) as PublishedLog;
      await writePublished(period, log);
      console.log(`imported published/${file.slice(0, -5)} (${Object.keys(log).length} day(s))`);
    }
  }

  // resolutions: a single store.json holding a Resolution[].
  const resFile = join(ROOT, "resolutions", "store.json");
  if (existsSync(resFile)) {
    const resolutions = JSON.parse(readFileSync(resFile, "utf8")) as Resolution[];
    // Legacy store.json rows predate the axis field; default them to the
    // whole-day axis explicitly (rather than relying on the DB column default).
    for (const r of resolutions) await upsertResolution({ ...r, axis: r.axis ?? "day" });
    console.log(`imported resolutions/store.json (${resolutions.length} resolution(s))`);
  }

  // asks: one file per period, an AskLog keyed by gapKey.
  const asksDir = join(ROOT, "asks");
  if (existsSync(asksDir)) {
    for (const file of readdirSync(asksDir)) {
      if (!file.endsWith(".json")) continue;
      const period = parsePeriodKey(file.slice(0, -".json".length));
      if (!period) continue;
      const log = JSON.parse(readFileSync(join(asksDir, file), "utf8")) as AskLog;
      await writeAsks(period, log);
      console.log(`imported asks/${file.slice(0, -5)} (${Object.keys(log).length} ask(s))`);
    }
  }
}

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

  await importAgentState();

  process.stderr.write(`db-import: ${imported} report(s) + agent state loaded into Postgres.\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`db-import: ${message}\n`);
  process.exit(1);
});
