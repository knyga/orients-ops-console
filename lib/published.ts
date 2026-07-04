/**
 * Published-verdict idempotency log, keyed by verdictKey (reportKey(date, reportTs)).
 * Mirrors the Postgres published table: one row per (period, verdictKey).
 *
 * NOT server-only: no secret. The merge logic is pure.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { parsePeriodKey, periodKey, type Period } from "./period";
import { reportKey } from "./fieldDayVerdict";

export interface PublishedEntry {
  date: string;       // YYYY-MM-DD flight day
  reportTs: string | null;  // Звіт message ts; null = legacy / no-Звіт
  channel: string;    // tracked channel NAME the verdict was posted to
  text: string;       // the exact message posted
  postedAt: string;   // ISO
  /** Slack ts of the posted verdict — the thread root approvers reply under. */
  ts: string;
  /** Set once an approver override has been acknowledged (edit + thread reply). */
  override?: {
    decision: "accepted_exception" | "rejected";
    by: string;
    ackedAt: string;
  };
}

/** verdictKey → entry. */
export type PublishedLog = Record<string, PublishedEntry>;

export interface PublishTarget {
  date: string;
  reportTs: string | null;
  reportCount: number;
}

function toEntry(r: typeof schema.published.$inferSelect): PublishedEntry {
  return {
    date: r.date,
    reportTs: r.reportTs ?? null,
    channel: r.channel,
    text: r.text,
    ts: r.ts,
    postedAt: r.postedAt,
    ...(r.override != null ? { override: r.override as PublishedEntry["override"] } : {}),
  };
}

/** The published log for a period (empty object when absent). */
export async function readPublished(period: Period): Promise<PublishedLog> {
  const key = periodKey(period);
  const rows = await db.select().from(schema.published).where(eq(schema.published.period, key));
  const log: PublishedLog = {};
  for (const r of rows) log[r.verdictKey] = toEntry(r);
  return log;
}

/**
 * Find a published verdict by its Slack ts (the thread root approvers reply
 * under), across all periods. Used by the events webhook, which only has the
 * reply's `thread_ts` — not the period. Returns the entry + its period, or null.
 */
export async function findPublishedByTs(
  ts: string,
): Promise<{ period: Period; entry: PublishedEntry } | null> {
  const rows = await db.select().from(schema.published).where(eq(schema.published.ts, ts)).limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  const period = parsePeriodKey(row.period);
  if (!period) return null;
  return { period, entry: toEntry(row) };
}

/** Upsert every entry of the period's published log by (period, verdictKey). */
export async function writePublished(period: Period, log: PublishedLog): Promise<void> {
  const key = periodKey(period);
  for (const entry of Object.values(log)) {
    const values = {
      period: key,
      date: entry.date,
      reportTs: entry.reportTs ?? null,
      verdictKey: reportKey(entry.date, entry.reportTs),
      channel: entry.channel,
      text: entry.text,
      ts: entry.ts,
      postedAt: entry.postedAt,
      override: entry.override ?? null,
    };
    await db
      .insert(schema.published)
      .values(values)
      .onConflictDoUpdate({ target: [schema.published.period, schema.published.verdictKey], set: values });
  }
}

/** Pure: has this report been published? Checks exact verdictKey; legacy bare-date entry covers a report only when reportCount === 1. */
export function isPublished(log: PublishedLog, target: PublishTarget): boolean {
  if (Object.prototype.hasOwnProperty.call(log, reportKey(target.date, target.reportTs))) return true;
  // A legacy bare-date entry is "the day's single report".
  return target.reportTs !== null && target.reportCount === 1 &&
    Object.prototype.hasOwnProperty.call(log, target.date);
}

/** Pure: add an entry, returning a new log (does not mutate the input). */
export function recordPublished(log: PublishedLog, entry: PublishedEntry): PublishedLog {
  return { ...log, [reportKey(entry.date, entry.reportTs)]: entry };
}
