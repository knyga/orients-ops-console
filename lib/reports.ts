/**
 * Shared artifact store for committed reports — the backbone of the
 * "skill → CLI `--write` → committed reports/<feature>/<period>.{json,csv} →
 * web renders the committed artifact" pattern.
 *
 * Each feature persists TWO sidecars per period: a lossless `.json` (the web's
 * render source, mirroring what `GET /api/<feature>` returns) and a flat `.csv`
 * (a human/spreadsheet record). The web reads JSON; it never writes — committing
 * artifacts is exclusively the CLI's job (`--write`).
 *
 * This module is deliberately NOT `server-only`: it holds no secrets and is
 * imported by both the API routes AND the Node CLIs (where `server-only`'s
 * default export would throw). It still can't reach the browser bundle because
 * `node:fs` isn't available there — reads are forced through API routes / server
 * components. Same precedent as ../lib/githubClient.
 */
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { periodKey, type Period } from "./period";

/**
 * Repo-root `reports/` directory — retained only for the committed FS INPUTS
 * (e.g. reports/field-ops/inputs/<period>.csv, a human-provided file), not for
 * report artifacts (those live in Postgres now).
 */
export function defaultBaseDir(): string {
  return join(process.cwd(), "reports");
}

// Re-export the pure period helpers so existing importers of "../lib/reports"
// (scripts/jiraReport, the period tests) keep working; the logic itself lives
// in ./period, which is client-bundle-safe (no node:fs).
export { periodKey, parsePeriodKey, type Period } from "./period";

/**
 * Persist a period's report (the web's render source) into the `reports` table,
 * keyed by (feature, period). Stores the JSON as jsonb + the flat CSV. Called by
 * the CLIs (`--write`) and cron; the web never writes. Returns the period key.
 */
export async function writeReport(
  feature: string,
  period: Period,
  artifacts: { json: string; csv: string },
): Promise<{ key: string }> {
  const key = periodKey(period);
  const values = {
    feature,
    period: key,
    json: JSON.parse(artifacts.json),
    csv: artifacts.csv,
    updatedAt: new Date().toISOString(),
  };
  await db
    .insert(schema.reports)
    .values(values)
    .onConflictDoUpdate({ target: [schema.reports.feature, schema.reports.period], set: values });
  return { key };
}

/**
 * Read a committed report's JSON. Returns null when absent (the caller decides
 * 404 vs a live fallback).
 */
export async function readReportJson<T>(feature: string, key: string): Promise<T | null> {
  const rows = await db
    .select()
    .from(schema.reports)
    .where(and(eq(schema.reports.feature, feature), eq(schema.reports.period, key)))
    .limit(1);
  return rows.length ? (rows[0].json as T) : null;
}

/** Period keys with a stored report for `feature`, newest first. */
export async function listPeriods(feature: string): Promise<string[]> {
  const rows = await db
    .select({ period: schema.reports.period })
    .from(schema.reports)
    .where(eq(schema.reports.feature, feature))
    .orderBy(desc(schema.reports.period));
  return rows.map((r) => r.period);
}
