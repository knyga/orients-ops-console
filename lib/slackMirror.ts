/**
 * Slack mirror store — the re-syncable copy of the tracked channels, backed by
 * the `slack_messages` + `slack_sync` Postgres tables (Vercel/Neon). NOT
 * server-only (the CLIs import it; browser never does). The pure merge/tombstone
 * core (upsertMessages, mergeMessages) is unit-tested and unchanged; the DB
 * adapter does read-month → merge → bulk-upsert, so the merge logic stays one
 * place. A "month" (YYYY-MM) is the read/write unit, matching mergeMessages'
 * whole-window semantics.
 */
import { and, eq, gte, like, lte } from "drizzle-orm";
import { db, schema } from "./db";
import type { Period } from "./period";
import type { SlackFile } from "./policySchedule";

export interface StoredMessage {
  ts: string;
  channel: string;
  authorId: string;
  author: string;
  isoTime: string;
  text: string;
  permalink: string;
  files?: SlackFile[];
  thread_ts?: string;
  reply_count?: number;
  edited?: string;
  deleted?: boolean;
  firstSeen: string;
  lastSeen: string;
}

export interface MonthFile {
  version: 1;
  channel: string;
  month: string;
  messages: Record<string, StoredMessage>;
}

export interface SyncCursor {
  version: 1;
  lastSync: string;
}

/** Distinct YYYY-MM month prefixes a period spans, in ascending order. */
export function monthsInPeriod(period: Period): string[] {
  const seen = new Set<string>();
  const date = new Date(`${period.start}T00:00:00.000Z`);
  const last = new Date(`${period.end}T00:00:00.000Z`);
  while (date <= last) {
    seen.add(date.toISOString().slice(0, 7));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return [...seen];
}

/**
 * Upsert fetched messages into the existing map by ts. New records keep their
 * firstSeen; re-fetched records preserve the prior firstSeen, refresh the mutable
 * fields, advance lastSeen, and DROP any deleted flag (a reappearance clears a
 * stale tombstone). Pure — `now` is passed in, no clock read.
 */
export function upsertMessages(
  existing: Record<string, StoredMessage>,
  fetched: StoredMessage[],
  now: string,
): Record<string, StoredMessage> {
  const result: Record<string, StoredMessage> = { ...existing };
  for (const f of fetched) {
    const prior = existing[f.ts];
    // Rebuild explicitly (no `deleted`) so a reappearing message clears its tombstone.
    result[f.ts] = {
      ts: f.ts,
      channel: f.channel,
      authorId: f.authorId,
      author: f.author,
      isoTime: f.isoTime,
      text: f.text,
      permalink: f.permalink,
      ...(f.files !== undefined && { files: f.files }),
      ...(f.thread_ts !== undefined && { thread_ts: f.thread_ts }),
      ...(f.reply_count !== undefined && { reply_count: f.reply_count }),
      ...(f.edited !== undefined && { edited: f.edited }),
      firstSeen: prior?.firstSeen ?? f.firstSeen,
      lastSeen: now,
    };
  }
  return result;
}

/**
 * Upsert + tombstone. After upserting, any stored ts whose isoTime falls inside
 * [windowStart, now] and is absent from `fetched` is marked deleted:true (we
 * re-fetched that window, so its absence is real). Messages outside the window are
 * never tombstoned — we didn't ask Slack about them. Pure and deterministic.
 */
export function mergeMessages(
  existing: Record<string, StoredMessage>,
  fetched: StoredMessage[],
  windowStart: string,
  now: string,
): Record<string, StoredMessage> {
  const result = upsertMessages(existing, fetched, now);
  const fetchedTs = new Set(fetched.map((m) => m.ts));
  for (const [ts, msg] of Object.entries(existing)) {
    if (fetchedTs.has(ts)) continue;
    if (msg.isoTime >= windowStart && msg.isoTime <= now) {
      result[ts] = { ...msg, deleted: true };
    }
  }
  return result;
}

function toStored(r: typeof schema.slackMessages.$inferSelect): StoredMessage {
  return {
    ts: r.ts,
    channel: r.channel,
    authorId: r.authorId,
    author: r.author,
    isoTime: r.isoTime,
    text: r.text,
    permalink: r.permalink,
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    ...(r.files != null ? { files: r.files as SlackFile[] } : {}),
    ...(r.threadTs != null ? { thread_ts: r.threadTs } : {}),
    ...(r.replyCount != null ? { reply_count: r.replyCount } : {}),
    ...(r.edited != null ? { edited: r.edited } : {}),
    ...(r.deleted != null ? { deleted: r.deleted } : {}),
  };
}

/** A channel+month (YYYY-MM) of stored messages as a MonthFile, or null if none. */
export async function readMonthFile(channel: string, month: string): Promise<MonthFile | null> {
  const rows = await db
    .select()
    .from(schema.slackMessages)
    .where(and(eq(schema.slackMessages.channel, channel), like(schema.slackMessages.isoTime, `${month}%`)));
  if (rows.length === 0) return null;
  const messages: Record<string, StoredMessage> = {};
  for (const r of rows) messages[r.ts] = toStored(r);
  return { version: 1, channel, month, messages };
}

/** Bulk-upsert a month's merged messages by (channel, ts). */
export async function writeMonthFile(channel: string, month: string, file: MonthFile): Promise<void> {
  for (const m of Object.values(file.messages)) {
    const values = {
      channel,
      ts: m.ts,
      authorId: m.authorId,
      author: m.author,
      isoTime: m.isoTime,
      text: m.text,
      permalink: m.permalink,
      files: m.files ?? null,
      threadTs: m.thread_ts ?? null,
      replyCount: m.reply_count ?? null,
      edited: m.edited ?? null,
      deleted: m.deleted ?? false,
      firstSeen: m.firstSeen,
      lastSeen: m.lastSeen,
    };
    await db
      .insert(schema.slackMessages)
      .values(values)
      .onConflictDoUpdate({ target: [schema.slackMessages.channel, schema.slackMessages.ts], set: values });
  }
}

export async function readSyncCursor(channel: string): Promise<SyncCursor | null> {
  const rows = await db
    .select()
    .from(schema.slackSync)
    .where(eq(schema.slackSync.channel, channel))
    .limit(1);
  return rows.length ? { version: 1, lastSync: rows[0].lastSync } : null;
}

export async function writeSyncCursor(channel: string, lastSync: string): Promise<void> {
  await db
    .insert(schema.slackSync)
    .values({ channel, lastSync })
    .onConflictDoUpdate({ target: schema.slackSync.channel, set: { lastSync } });
}

/**
 * All mirrored messages for a channel within [period.start, period.end]
 * inclusive (by day), sorted by ts ascending. Tombstoned (deleted) records are
 * INCLUDED — consumers filter them where appropriate. The day-range filter is
 * done in SQL on the full ISO bounds.
 */
export async function readChannelMessages(channel: string, period: Period): Promise<StoredMessage[]> {
  const rows = await db
    .select()
    .from(schema.slackMessages)
    .where(
      and(
        eq(schema.slackMessages.channel, channel),
        gte(schema.slackMessages.isoTime, `${period.start}T00:00:00.000Z`),
        lte(schema.slackMessages.isoTime, `${period.end}T23:59:59.999Z`),
      ),
    );
  return rows.map(toStored).sort((a, b) => a.ts.localeCompare(b.ts));
}
