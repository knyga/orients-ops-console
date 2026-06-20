/**
 * Committed record of questions the bot has asked (S5) and their lifecycle, so it
 * asks each gap at most ONCE and S6 can attach the answer. One file per period,
 * reports/asks/<periodKey>.json, keyed by `${gapType}:${date}`.
 *
 * State machine per (gapType, date):
 *   (absent = OPEN) → ASKED → ANSWERED → RESOLVED | ESCALATED
 *
 * NOT server-only: fs-only, no secret (same precedent as lib/reports.ts). The
 * merge/transition logic is pure; writes are atomic (temp + rename).
 */
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { parsePeriodKey, periodKey, type Period } from "./period";
import type { GapType } from "./askGaps";

export type AskState = "ASKED" | "ANSWERED" | "RESOLVED" | "ESCALATED";

export interface AskRecord {
  gapType: GapType;
  date: string;          // YYYY-MM-DD flight day
  channel: string;       // tracked channel NAME the question was posted to
  question: string;      // exact text posted
  state: AskState;
  askedTs: string;       // Slack ts of the bot's question (thread root for replies)
  askedAt: string;       // ISO
  /** Optional outcome note from S6 (the classified answer). */
  note?: string;
}

/** key (`${gapType}:${date}`) → record. */
export type AskLog = Record<string, AskRecord>;

function toRecord(r: typeof schema.asks.$inferSelect): AskRecord {
  return {
    gapType: r.gapType as GapType,
    date: r.date,
    channel: r.channel,
    question: r.question,
    state: r.state as AskState,
    askedTs: r.askedTs,
    askedAt: r.askedAt,
    ...(r.note != null ? { note: r.note } : {}),
  };
}

export async function readAsks(period: Period): Promise<AskLog> {
  const key = periodKey(period);
  const rows = await db.select().from(schema.asks).where(eq(schema.asks.period, key));
  const log: AskLog = {};
  for (const r of rows) log[r.gapKey] = toRecord(r);
  return log;
}

/**
 * Find an asked question by the bot's question ts (the thread root replies arrive
 * under), across all periods. Used by the events webhook, which only has the
 * reply's `thread_ts`. Returns the record + its period + gapKey, or null.
 */
export async function findAskByTs(
  askedTs: string,
): Promise<{ period: Period; gapKey: string; record: AskRecord } | null> {
  const rows = await db.select().from(schema.asks).where(eq(schema.asks.askedTs, askedTs)).limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  const period = parsePeriodKey(row.period);
  if (!period) return null;
  return { period, gapKey: row.gapKey, record: toRecord(row) };
}

export async function writeAsks(period: Period, log: AskLog): Promise<void> {
  const key = periodKey(period);
  for (const [gapKey, rec] of Object.entries(log)) {
    const values = {
      period: key,
      gapKey,
      gapType: rec.gapType,
      date: rec.date,
      channel: rec.channel,
      question: rec.question,
      state: rec.state,
      askedTs: rec.askedTs,
      askedAt: rec.askedAt,
      note: rec.note ?? null,
    };
    await db
      .insert(schema.asks)
      .values(values)
      .onConflictDoUpdate({ target: [schema.asks.period, schema.asks.gapKey], set: values });
  }
}

/** Pure: has this gap already been asked (any state present)? */
export function isAsked(log: AskLog, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(log, key);
}

/** Pure: add/replace a record by key, returning a new log (no mutation). */
export function recordAsk(log: AskLog, key: string, record: AskRecord): AskLog {
  return { ...log, [key]: record };
}

/** Pure: transition an existing record's state (+ optional note); no-op if absent. */
export function setAskState(log: AskLog, key: string, state: AskState, note?: string): AskLog {
  const existing = log[key];
  if (!existing) return log;
  return { ...log, [key]: { ...existing, state, ...(note !== undefined && { note }) } };
}
