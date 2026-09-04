/**
 * Drizzle schema for the durable agent state (Vercel + Neon Postgres). Replaces
 * the filesystem stores from S1/S3–S7. ISO/date fields are stored as `text` —
 * the exact strings the pure logic already compares lexically — so the merge /
 * verdict / resolution logic is unchanged by the move off the filesystem.
 *
 * Not server-only: the CLIs and API routes both import this. See lib/db.ts.
 */
import { boolean, index, integer, jsonb, pgTable, primaryKey, real, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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

/** Durable human resolutions (exceptions / vetoes), keyed by (flight date, axis,
 *  report ts). report_ts ""=day-wide (applies to every report of the day). */
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
    reportTs: text("report_ts").notNull().default(""), // ""=day-wide; a Звіт ts scopes it
  },
  (t) => [primaryKey({ columns: [t.date, t.axis, t.reportTs] })],
);

/** Approver roster corrections, keyed by (flight date, report ts). report_ts
 *  ""=day-wide (approver legacy + sheet import); a Звіт ts scopes it to one report. */
export const rosterCorrections = pgTable(
  "roster_corrections",
  {
    date: text("date").notNull(),
    roster: jsonb("roster"),            // string[] | null
    eligibility: jsonb("eligibility"),  // Record<name,"counted"|"not_counted"> | null
    note: text("note").notNull(),
    by: text("by").notNull(),
    source: text("source").notNull(),
    recordedAt: text("recorded_at").notNull(),
    reportTs: text("report_ts").notNull().default(""), // ""=day-wide; a Звіт ts scopes it
    early: boolean("early"),            // approver early-departure assertion | null = derive from Звіт
  },
  (t) => [primaryKey({ columns: [t.date, t.reportTs] })],
);

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

/** Drone-loss ledger — one row per classified Звіт crash text (including
 *  lost=false rows: the hash gate needs them to skip unchanged text). An
 *  `instruction` row (approver override) permanently outranks `extracted`
 *  for its key; reportTs "" = a day-wide instruction (legacy threads). */
export const lossRecords = pgTable(
  "loss_records",
  {
    date: text("date").notNull(), // flight date YYYY-MM-DD (the Звіт's own date)
    reportTs: text("report_ts").notNull(), // Звіт message ts; "" = day-wide instruction
    lost: boolean("lost").notNull(),
    found: boolean("found").notNull(),
    note: text("note").notNull(),
    source: text("source").notNull(), // extracted|instruction
    crashTextHash: text("crash_text_hash"), // sha256 of the Звіт crash text (extracted rows)
    updatedAt: text("updated_at").notNull(),
    updatedBy: text("updated_by"), // approver name on instruction rows
  },
  (t) => [primaryKey({ columns: [t.date, t.reportTs] })],
);

/**
 * Content-addressed cache of the expensive per-message Claude extractions in the
 * #field-qa pass (vision airborne reads + drone-count classification). Lets the
 * nightly re-extract only new/edited messages instead of the whole active month,
 * keeping it under Vercel Hobby's 60s cap. See lib/extractCache.ts.
 */
export const extractCache = pgTable(
  "extract_cache",
  {
    kind: text("kind").notNull(), // "airborne" | "drone"
    hash: text("hash").notNull(), // sha256 of the content key
    result: text("result").notNull(), // JSON payload of the extraction result
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.hash] })],
);

/** Loss-alert state per period — what the bot already told people. */
export const lossAlerts = pgTable("loss_alerts", {
  period: text("period").primaryKey(), // periodKey, e.g. "2026-07"
  lastAlertedCount: integer("last_alerted_count").notNull(),
  fieldqaWarnedAt3: boolean("fieldqa_warned_at_3").notNull(),
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
    axis: text("axis").notNull(), // crew|eligibility|day|dataset|video|airborne|loss
    payload: jsonb("payload").notNull(), // the classified change
    summaryUk: text("summary_uk").notNull(), // Ukrainian echo of the change
    proposedBy: text("proposed_by").notNull(), // approver name
    origin: text("origin").notNull().default("approver"), // approver|pilot — who raised it
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

/** Audit of every human reply the thread-reply handler acted on (pilot evidence
 *  autonomy, 2026-09-04): what it was classified as and what happened. Unique on
 *  source_reply_ts → a redelivered Slack event never records twice. */
export const evidenceEvents = pgTable(
  "evidence_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadTs: text("thread_ts").notNull(),
    channel: text("channel").notNull(), // tracked channel NAME
    date: text("date").notNull(),
    reportTs: text("report_ts"), // null = day-level (ask thread / legacy)
    byUserId: text("by_user_id").notNull(),
    byName: text("by_name").notNull(),
    role: text("role").notNull(), // approver|pilot
    kind: text("kind").notNull(), // evidence|claim|chat|unclear
    evidence: jsonb("evidence"), // ReplyHints + classified evidence items
    outcome: text("outcome").notNull(), // closed|still_open|hard_fail|escalated|answered|silent
    statusBefore: text("status_before"),
    statusAfter: text("status_after"),
    sourceReplyTs: text("source_reply_ts").notNull(),
    proposalId: text("proposal_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("evidence_events_source_reply_ts").on(t.sourceReplyTs),
    index("evidence_events_date").on(t.date),
  ],
);

/** Published verdicts (idempotency + thread root for approver overrides). */
export const published = pgTable(
  "published",
  {
    period: text("period").notNull(),
    date: text("date").notNull(),
    /** Звіт ts for a per-report verdict; null = legacy day entry / no-Звіт row. */
    reportTs: text("report_ts"),
    /** reportKey(date, reportTs) — the store key. Legacy rows: the bare date. */
    verdictKey: text("verdict_key").notNull(),
    channel: text("channel").notNull(),
    text: text("text").notNull(),
    ts: text("ts").notNull(),
    postedAt: text("posted_at").notNull(),
    override: jsonb("override"), // { decision, by, ackedAt } | null
  },
  (t) => [primaryKey({ columns: [t.period, t.verdictKey] })],
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
    reportTs: text("report_ts"),
    verdictKey: text("verdict_key").notNull(),
    threadTs: text("thread_ts"),
    dms: jsonb("dms").notNull(), // { slackId, ts, amount }[]
  },
  (t) => [primaryKey({ columns: [t.period, t.verdictKey] })],
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

/** Confirm-first Jira-write proposals from a DM agent turn (Phase C.2). At most
 *  one PENDING per DM channel; applied deterministically via lib/proposalExecutor. */
export const agentProposals = pgTable(
  "agent_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: text("channel_id").notNull(),
    kind: text("kind").notNull(),
    params: jsonb("params").notNull(),
    summaryUk: text("summary_uk").notNull(),
    proposedBy: text("proposed_by").notNull(),
    state: text("state").notNull(), // PENDING|APPLIED|CANCELLED|SUPERSEDED
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (t) => [
    uniqueIndex("agent_proposals_one_pending").on(t.channelId).where(sql`state = 'PENDING'`),
    index("agent_proposals_channel").on(t.channelId),
  ],
);

/** Per-DM agent conversation memory (Phase C.2). transcript = lightweight text
 *  turns only (no tool/thinking blocks). Capped on read+write to last 10 turns. */
export const agentThreads = pgTable("agent_threads", {
  channelId: text("channel_id").primaryKey(),
  updatedAt: text("updated_at").notNull(),
  transcript: jsonb("transcript").notNull(),
});
