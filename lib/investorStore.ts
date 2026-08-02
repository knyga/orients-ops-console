/**
 * Store for the weekly investor report, on the shared `reports` table
 * (feature = "investor", period = the explicit `${start}_${end}` week key —
 * NEVER the collapsed monthly periodKey, which would collide with monthly
 * features). Mirrors lib/sprintStore.ts. Deliberately NOT `server-only`:
 * no secrets, imported by both the API route and the Node CLI.
 */
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "./db";
import type { InvestorRecord } from "./investorReport";

const FEATURE = "investor";

/** Read one week's record by key, or null when absent. */
export async function readInvestor(key: string): Promise<InvestorRecord | null> {
  const rows = await db
    .select()
    .from(schema.reports)
    .where(and(eq(schema.reports.feature, FEATURE), eq(schema.reports.period, key)))
    .limit(1);
  return rows.length ? (rows[0].json as InvestorRecord) : null;
}

/** Upsert one week's record (+ flat CSV sidecar) by key. */
export async function writeInvestor(
  key: string,
  record: InvestorRecord,
  csv: string,
): Promise<void> {
  const values = {
    feature: FEATURE,
    period: key,
    json: record,
    csv,
    updatedAt: new Date().toISOString(),
  };
  await db
    .insert(schema.reports)
    .values(values)
    .onConflictDoUpdate({ target: [schema.reports.feature, schema.reports.period], set: values });
}

/** Week keys with a stored record, newest first. */
export async function listInvestorKeys(): Promise<string[]> {
  const rows = await db
    .select({ period: schema.reports.period })
    .from(schema.reports)
    .where(eq(schema.reports.feature, FEATURE))
    .orderBy(desc(schema.reports.period));
  return rows.map((r) => r.period);
}
