/**
 * Drizzle schema for the durable agent state (Vercel + Neon Postgres). Replaces
 * the filesystem stores from S1/S3–S7. ISO/date fields are stored as `text` —
 * the exact strings the pure logic already compares lexically — so the merge /
 * verdict / resolution logic is unchanged by the move off the filesystem.
 *
 * Not server-only: the CLIs and API routes both import this. See lib/db.ts.
 */
import { boolean, index, integer, jsonb, pgTable, primaryKey, real, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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

/** Durable human resolutions (exceptions / vetoes), keyed by (flight date, axis). */
export const resolutions = pgTable(
  "resolutions",
  {
    date: text("date").notNull(),
    axis: text("axis").notNull().default("day"), // "dataset" | "video" | "day"
    decision: text("decision").notNull(),        // "accepted_exception" | "rejected"
    note: text("note").notNull(),
    source: text("source").notNull(),
    by: text("by"),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.axis] })],
);

/** Approver roster corrections, keyed by flight date (crew + per-person eligibility). */
export const rosterCorrections = pgTable("roster_corrections", {
  date: text("date").primaryKey(),
  roster: jsonb("roster"),            // string[] | null
  eligibility: jsonb("eligibility"),  // Record<name,"counted"|"not_counted"> | null
  note: text("note").notNull(),
  by: text("by").notNull(),
  source: text("source").notNull(),
  recordedAt: text("recorded_at").notNull(),
});

/** Approver airborne-minutes overrides, keyed by flight date (corrects the figure
 *  the day is judged against when the #field-qa report is wrong/absent). */
export const airborneOverrides = pgTable("airborne_overrides", {
  date: text("date").primaryKey(),
  minutes: real("minutes").notNull(),
  note: text("note").notNull(),
  by: text("by").notNull(),
  source: text("source").notNull(),
  recordedAt: text("recorded_at").notNull(),
});

/** Confirm-first data-overwrite proposals from approver verdict-thread instructions.
 *  The bot stores a PROPOSED proposal, echoes it, and applies only on confirmation.
 *  Unique (source_reply_ts) → idempotent under Slack event redelivery. */
export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadTs: text("thread_ts").notNull(), // verdict thread root
    channel: text("channel").notNull(), // tracked channel NAME
    date: text("date").notNull(), // flight day the proposal targets
    axis: text("axis").notNull(), // crew|eligibility|day|dataset|video|airborne
    payload: jsonb("payload").notNull(), // the classified change
    summaryUk: text("summary_uk").notNull(), // Ukrainian echo of the change
    proposedBy: text("proposed_by").notNull(), // approver name
    sourceReplyTs: text("source_reply_ts").notNull(), // the approver reply that triggered it
    state: text("state").notNull(), // PROPOSED|CONFIRMED|CANCELLED|SUPERSEDED
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (t) => [
    uniqueIndex("proposals_source_reply_ts").on(t.sourceReplyTs),
    index("proposals_thread_ts_state").on(t.threadTs, t.state),
    index("proposals_date").on(t.date),
  ],
);

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

/** Every message the bot posts/edits to Slack — audit log + reserve-then-send dedup. */
export const outboundMessages = pgTable(
  "outbound_messages",
  {
    key: text("key").primaryKey(), // logical-action idempotency key
    feature: text("feature").notNull(), // "verdict" | "ask" | "approval" | "webhook-failure"
    kind: text("kind").notNull(), // "post" | "reply" | "edit"
    channel: text("channel").notNull(), // tracked channel NAME
    channelId: text("channel_id").notNull(),
    text: text("text").notNull(), // exact text sent
    threadTs: text("thread_ts"), // thread root (null for top-level posts)
    ts: text("ts"), // Slack ts (null until sent for posts)
    status: text("status").notNull(), // "pending" | "sent" | "failed" | "skipped"
    origin: text("origin").notNull(), // "vercel" | "local" | "unknown"
    trigger: text("trigger").notNull(), // "cli" | "cron" | "webhook" | "unknown"
    error: text("error"),
    attempts: integer("attempts").notNull(),
    reservedAt: text("reserved_at").notNull(), // ISO
    sentAt: text("sent_at"), // ISO, set on success
  },
  (t) => [
    index("outbound_messages_sent_at").on(t.sentAt),
    index("outbound_messages_feature").on(t.feature),
  ],
);

/** Slack event-id dedup: process each Events API delivery at most once. */
export const slackEventsSeen = pgTable("slack_events_seen", {
  eventId: text("event_id").primaryKey(), // Slack's stable event_id (reused across retries)
  seenAt: text("seen_at").notNull(), // ISO of first claim
  eventType: text("event_type"), // inner event.type (audit)
  outcome: text("outcome"), // short result tag (audit)
});

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
