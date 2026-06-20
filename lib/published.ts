/**
 * Committed record of which day-verdicts the bot has already posted to Slack, so
 * re-running the publisher never double-posts (idempotency). One file per period,
 * reports/published/<periodKey>.json, keyed by flight date.
 *
 * NOT server-only: fs-only, no secret (same precedent as lib/reports.ts). The
 * merge logic is pure. Mirrors the atomic temp+rename write used elsewhere.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { periodKey, type Period } from "./period";

export interface PublishedEntry {
  date: string;       // YYYY-MM-DD flight day
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

/** date → entry. */
export type PublishedLog = Record<string, PublishedEntry>;

function toEntry(r: typeof schema.published.$inferSelect): PublishedEntry {
  return {
    date: r.date,
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
  for (const r of rows) log[r.date] = toEntry(r);
  return log;
}

/** Upsert every entry of the period's published log by (period, date). */
export async function writePublished(period: Period, log: PublishedLog): Promise<void> {
  const key = periodKey(period);
  for (const entry of Object.values(log)) {
    const values = {
      period: key,
      date: entry.date,
      channel: entry.channel,
      text: entry.text,
      ts: entry.ts,
      postedAt: entry.postedAt,
      override: entry.override ?? null,
    };
    await db
      .insert(schema.published)
      .values(values)
      .onConflictDoUpdate({ target: [schema.published.period, schema.published.date], set: values });
  }
}

/** Pure: has this date already been published? */
export function isPublished(log: PublishedLog, date: string): boolean {
  return Object.prototype.hasOwnProperty.call(log, date);
}

/** Pure: add an entry, returning a new log (does not mutate the input). */
export function recordPublished(log: PublishedLog, entry: PublishedEntry): PublishedLog {
  return { ...log, [entry.date]: entry };
}
