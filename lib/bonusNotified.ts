/**
 * Committed-in-DB record of which rolling field-bonus notifications have been
 * sent, so a re-run (incl. an unattended cron) never double-notifies a report
 * or a person. One row per (period, verdictKey = reportKey(date, reportTs)).
 * Pure merge helpers + thin drizzle read/write. NOT server-only (db, no secret
 * literal). Mirrors lib/published.ts.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { periodKey, type Period } from "./period";
import { reportKey } from "./fieldDayVerdict";

export interface DmRecord { slackId: string; ts: string; amount: number }
export interface NotifiedEntry { date: string; reportTs: string | null; threadTs?: string; dms: DmRecord[] }
/** verdictKey → entry. */
export type NotifiedLog = Record<string, NotifiedEntry>;

/** The report identity needed to resolve a notified key + its legacy fallback. */
export interface NotifiedTarget { date: string; reportTs: string | null; reportCount: number }

/** Inverse of reportKey: "date" or "date#reportTs" → { date, reportTs }. */
function splitKey(key: string): { date: string; reportTs: string | null } {
  const i = key.indexOf("#");
  return i === -1 ? { date: key, reportTs: null } : { date: key.slice(0, i), reportTs: key.slice(i + 1) };
}

function toEntry(r: typeof schema.bonusNotified.$inferSelect): NotifiedEntry {
  return { date: r.date, reportTs: r.reportTs ?? null, threadTs: r.threadTs ?? undefined, dms: (r.dms as DmRecord[]) ?? [] };
}

/** Exact-key lookup: has this key's thread already been notified? */
export function isThreadNotified(log: NotifiedLog, key: string): boolean {
  return log[key]?.threadTs != null;
}
/** Exact-key lookup: has this key's DM to `slackId` already been sent? */
export function isDmSent(log: NotifiedLog, key: string, slackId: string): boolean {
  return (log[key]?.dms ?? []).some((d) => d.slackId === slackId);
}
export function recordThread(log: NotifiedLog, key: string, threadTs: string): NotifiedLog {
  const { date, reportTs } = splitKey(key);
  const prev = log[key] ?? { date, reportTs, dms: [] };
  return { ...log, [key]: { ...prev, date, reportTs, threadTs } };
}
/** Forget a retracted (deleted) thread post: the key's DMs stay recorded. Pure. */
export function clearThread(log: NotifiedLog, key: string): NotifiedLog {
  const prev = log[key];
  if (!prev || prev.threadTs == null) return log;
  const { threadTs: _gone, ...rest } = prev;
  void _gone;
  return { ...log, [key]: rest };
}
export function recordDm(log: NotifiedLog, key: string, slackId: string, ts: string, amount: number): NotifiedLog {
  const { date, reportTs } = splitKey(key);
  const prev = log[key] ?? { date, reportTs, dms: [] };
  if (prev.dms.some((d) => d.slackId === slackId)) return log;
  return { ...log, [key]: { ...prev, date, reportTs, dms: [...prev.dms, { slackId, ts, amount }] } };
}

/** Pure: has this report's thread already been notified? Checks the exact
 *  verdictKey; a legacy bare-date entry covers a report only when it's the
 *  day's sole report — mirrors lib/published.ts's isPublished fallback. */
export function isThreadNotifiedFor(log: NotifiedLog, target: NotifiedTarget): boolean {
  if (isThreadNotified(log, reportKey(target.date, target.reportTs))) return true;
  return target.reportTs !== null && target.reportCount === 1 && isThreadNotified(log, target.date);
}
/** Same fallback rule as isThreadNotifiedFor, for a per-person DM. */
export function isDmSentFor(log: NotifiedLog, target: NotifiedTarget, slackId: string): boolean {
  if (isDmSent(log, reportKey(target.date, target.reportTs), slackId)) return true;
  return target.reportTs !== null && target.reportCount === 1 && isDmSent(log, target.date, slackId);
}

export async function readNotified(period: Period): Promise<NotifiedLog> {
  const key = periodKey(period);
  const rows = await db.select().from(schema.bonusNotified).where(eq(schema.bonusNotified.period, key));
  const log: NotifiedLog = {};
  for (const r of rows) log[r.verdictKey] = toEntry(r);
  return log;
}
export async function writeNotified(period: Period, log: NotifiedLog): Promise<void> {
  const key = periodKey(period);
  for (const entry of Object.values(log)) {
    const values = {
      period: key,
      date: entry.date,
      reportTs: entry.reportTs ?? null,
      verdictKey: reportKey(entry.date, entry.reportTs),
      threadTs: entry.threadTs ?? null,
      dms: entry.dms,
    };
    await db.insert(schema.bonusNotified).values(values)
      .onConflictDoUpdate({ target: [schema.bonusNotified.period, schema.bonusNotified.verdictKey], set: values });
  }
}
