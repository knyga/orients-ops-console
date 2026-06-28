/**
 * Committed-in-DB record of which rolling field-bonus notifications have been
 * sent, so a re-run (incl. an unattended cron) never double-notifies a day or a
 * person. One row per (period, date). Pure merge helpers + thin drizzle
 * read/write. NOT server-only (db, no secret literal). Mirrors lib/published.ts.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { periodKey, type Period } from "./period";

export interface DmRecord { slackId: string; ts: string; amount: number }
export interface NotifiedEntry { date: string; threadTs?: string; dms: DmRecord[] }
export type NotifiedLog = Record<string, NotifiedEntry>;

export function isThreadNotified(log: NotifiedLog, date: string): boolean {
  return log[date]?.threadTs != null;
}
export function isDmSent(log: NotifiedLog, date: string, slackId: string): boolean {
  return (log[date]?.dms ?? []).some((d) => d.slackId === slackId);
}
export function recordThread(log: NotifiedLog, date: string, threadTs: string): NotifiedLog {
  const prev = log[date] ?? { date, dms: [] };
  return { ...log, [date]: { ...prev, date, threadTs } };
}
export function recordDm(log: NotifiedLog, date: string, slackId: string, ts: string, amount: number): NotifiedLog {
  const prev = log[date] ?? { date, dms: [] };
  if (prev.dms.some((d) => d.slackId === slackId)) return log;
  return { ...log, [date]: { ...prev, date, dms: [...prev.dms, { slackId, ts, amount }] } };
}

export async function readNotified(period: Period): Promise<NotifiedLog> {
  const key = periodKey(period);
  const rows = await db.select().from(schema.bonusNotified).where(eq(schema.bonusNotified.period, key));
  const log: NotifiedLog = {};
  for (const r of rows) log[r.date] = { date: r.date, threadTs: r.threadTs ?? undefined, dms: (r.dms as DmRecord[]) ?? [] };
  return log;
}
export async function writeNotified(period: Period, log: NotifiedLog): Promise<void> {
  const key = periodKey(period);
  for (const entry of Object.values(log)) {
    const values = { period: key, date: entry.date, threadTs: entry.threadTs ?? null, dms: entry.dms };
    await db.insert(schema.bonusNotified).values(values)
      .onConflictDoUpdate({ target: [schema.bonusNotified.period, schema.bonusNotified.date], set: values });
  }
}
