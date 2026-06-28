/**
 * Drizzle schema for the durable agent state (Vercel + Neon Postgres). Replaces
 * the filesystem stores from S1/S3–S7. ISO/date fields are stored as `text` —
 * the exact strings the pure logic already compares lexically — so the merge /
 * verdict / resolution logic is unchanged by the move off the filesystem.
 *
 * Not server-only: the CLIs and API routes both import this. See lib/db.ts.
 */
import { boolean, index, integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

/** The Slack mirror — one row per (channel, ts), including thread replies. */
export const slackMessages = pgTable(
  "slack_messages",
  {
    channel: text("channel").notNull(),
    ts: text("ts").notNull(),
    authorId: text("author_id").notNull(),
    author: text("author").notNull(),
    isoTime: text("iso_time").notNull(),
    text: text("text").notNull(),
    permalink: text("permalink").notNull(),
    files: jsonb("files"),
    threadTs: text("thread_ts"),
    replyCount: integer("reply_count"),
    edited: text("edited"),
    deleted: boolean("deleted"),
    firstSeen: text("first_seen").notNull(),
    lastSeen: text("last_seen").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channel, t.ts] }),
    index("slack_messages_channel_iso_time").on(t.channel, t.isoTime),
    index("slack_messages_channel_thread_ts").on(t.channel, t.threadTs),
  ],
);

/** Per-channel sync cursor. */
export const slackSync = pgTable("slack_sync", {
  channel: text("channel").primaryKey(),
  lastSync: text("last_sync").notNull(),
});

/** Durable human resolutions (exceptions / vetoes), keyed by flight date. */
export const resolutions = pgTable("resolutions", {
  date: text("date").primaryKey(),
  decision: text("decision").notNull(), // "accepted_exception" | "rejected"
  note: text("note").notNull(),
  source: text("source").notNull(),
  by: text("by"),
  recordedAt: text("recorded_at").notNull(),
});

/** Published verdicts (idempotency + thread root for approver overrides). */
export const published = pgTable(
  "published",
  {
    period: text("period").notNull(),
    date: text("date").notNull(),
    channel: text("channel").notNull(),
    text: text("text").notNull(),
    ts: text("ts").notNull(),
    postedAt: text("posted_at").notNull(),
    override: jsonb("override"), // { decision, by, ackedAt } | null
  },
  (t) => [primaryKey({ columns: [t.period, t.date] })],
);

/** Asked questions (S5) + their lifecycle state. */
export const asks = pgTable(
  "asks",
  {
    period: text("period").notNull(),
    gapKey: text("gap_key").notNull(),
    gapType: text("gap_type").notNull(),
    date: text("date").notNull(),
    channel: text("channel").notNull(),
    question: text("question").notNull(),
    state: text("state").notNull(),
    askedTs: text("asked_ts").notNull(),
    askedAt: text("asked_at").notNull(),
    note: text("note"),
  },
  (t) => [primaryKey({ columns: [t.period, t.gapKey] })],
);

/** Durable roster initial→name aliases (e.g. resolved "М"→"Максим"). */
export const rosterAliases = pgTable("roster_aliases", {
  initial: text("initial").primaryKey(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  recordedAt: text("recorded_at").notNull(),
});

/** Rolling field-bonus notifications (idempotency): thread note + per-person DMs. */
export const bonusNotified = pgTable(
  "bonus_notified",
  {
    period: text("period").notNull(),
    date: text("date").notNull(),
    threadTs: text("thread_ts"),
    dms: jsonb("dms").notNull(), // { slackId, ts, amount }[]
  },
  (t) => [primaryKey({ columns: [t.period, t.date] })],
);

/** The web's render source — one row per (feature, period). */
export const reports = pgTable(
  "reports",
  {
    feature: text("feature").notNull(),
    period: text("period").notNull(),
    json: jsonb("json").notNull(),
    csv: text("csv"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.feature, t.period] })],
);
