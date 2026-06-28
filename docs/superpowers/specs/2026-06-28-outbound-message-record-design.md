# Outbound message record + cross-point idempotency

**Date:** 2026-06-28
**Status:** Design — pending implementation plan

## Problem

The bot posts to Slack from several points of execution: local CLIs
(`field-publish`, `field-ask`, `field-approvals`, `field-remember`), the Vercel
events webhook (`app/api/slack/events/route.ts`), and the Vercel cron route
(`app/api/cron/verdict/route.ts`). Today we only durably remember *some* of what
we send:

- Published verdicts → `published` table (keyed by period+date).
- Asked questions → `asks` table (keyed by period+gapKey).
- **Not remembered at all:** webhook failure notices, `updateMessage` edits, ack
  replies, and anything new.

We want two things from a single mechanism:

1. **A complete audit record** of every message the bot posts/edits, regardless
   of which execution point sent it.
2. **Cross-point idempotency** so two execution points cannot double-post the
   same logical message, even under concurrency.

The execution points should give a *similar experience* — the same dedup
behavior and the same record — because they all funnel through one chokepoint.

## The chokepoint

Every outbound send already goes through two `server-only` functions in
`lib/slack.ts`:

- `postMessage(channelId, text, threadTs?)` — `chat.postMessage` (line 323)
- `updateMessage(channelId, ts, text)` — `chat.update` (line 351)

Callers (all of which inherit the new behavior automatically):

| Caller | File | Kind |
|---|---|---|
| Verdict publish | `scripts/field-publish.ts:94` | post |
| Gap question | `scripts/field-ask.ts:85` | post |
| Approval edit + ack | `lib/applyApproval.ts:65-66` | edit + reply |
| Webhook failure notice | `app/api/slack/events/route.ts:74` | reply |

Instrumenting these two functions covers every path.

## Data model

New Drizzle table in `lib/schema.ts`, **not** `server-only` (CLIs and API routes
both import the schema; precedent: every existing table). Postgres on Neon.

```ts
export const outboundMessages = pgTable(
  "outbound_messages",
  {
    key: text("key").primaryKey(),       // logical-action idempotency key
    feature: text("feature").notNull(),  // "verdict" | "ask" | "approval" | "webhook-failure"
    kind: text("kind").notNull(),        // "post" | "edit" | "reply"
    channel: text("channel").notNull(),  // tracked channel NAME
    channelId: text("channel_id").notNull(),
    text: text("text").notNull(),        // exact text sent
    threadTs: text("thread_ts"),         // thread root (null for top-level posts)
    ts: text("ts"),                      // Slack ts returned (null until sent)
    status: text("status").notNull(),    // "pending" | "sent" | "failed" | "skipped"
    origin: text("origin").notNull(),    // "vercel" | "local"  (auto from process.env.VERCEL)
    trigger: text("trigger").notNull(),  // "cli" | "cron" | "webhook" | "unknown"
    error: text("error"),                // failure detail
    attempts: integer("attempts").notNull(),
    reservedAt: text("reserved_at").notNull(), // ISO
    sentAt: text("sent_at"),                    // ISO, set on success
  },
  (t) => [
    index("outbound_messages_sent_at").on(t.sentAt),
    index("outbound_messages_feature").on(t.feature),
  ],
);
```

### The idempotency key

The `key` is a caller-supplied string identifying one **logical action**. Each
distinct action (an original post, a specific edit, an ack reply) gets its own
key → its own row. This makes the table simultaneously:

- a **complete audit log** (every action is a row), and
- a **per-action idempotency guard** (the PK is unique).

Key conventions (stable, derived from data the caller already has):

| Action | Key |
|---|---|
| Verdict post | `verdict:<period>:<date>` |
| Gap question | `ask:<gapType>:<date>` |
| Approval edit | `approval-edit:<date>:<rev>` |
| Ack reply | `approval-ack:<date>:<rev>` |
| Webhook failure notice | `webhook-failure:<date>:<kind>` |

`<rev>` is a short content hash so a genuinely new edit (different text) is a new
action with a new key, while a re-run with identical text is a no-op.

## Reserve-then-send

A new internal helper in `lib/slack.ts` wraps the Slack call so dedup and logging
happen at the chokepoint:

```
sendTracked({ key, feature, kind, channelId, channel, text, threadTs?, editTs? }):
  1. reservedAt = now; row = INSERT { key, ..., status: "pending", attempts: 1, reservedAt }
        ON CONFLICT (key) DO NOTHING RETURNING *
  2. if no row returned:                       // someone already reserved this key
        existing = SELECT by key
        return { skipped: true, ts: existing.ts }   // never double-posts
  3. else (we own the reservation):
        try:
          ts = <Slack chat.postMessage / chat.update>
          UPDATE row SET status="sent", ts, sentAt=now
          return { skipped: false, ts }
        catch err:
          UPDATE row SET status="failed", error=String(err)
          throw
```

`postMessage` / `updateMessage` gain a **required** `meta` argument carrying
`{ key, feature, kind, trigger? }`. Requiring it is *how* we guarantee every
message is remembered — there is no untracked send path. `origin` is auto-detected
(`process.env.VERCEL === "1" ? "vercel" : "local"`); `trigger` defaults to
`"unknown"` and is set explicitly by entry points that know (`"cli"` in scripts,
`"cron"` / `"webhook"` in the respective routes).

### Relationship to existing idempotency

Additive. `published` (period+date) and `asks` (period+gapKey) keep their tables
and their domain semantics (override state, ask lifecycle) unchanged. They dedup
*before* calling `postMessage`, as today; the new layer dedups again at the
chokepoint and records the send. The redundancy is harmless and intentional — the
new table is the universal safety net + audit record; the domain tables remain the
source of truth for their own workflows.

### Concurrency note

Under a true race, the loser of `ON CONFLICT DO NOTHING` may read a row still in
`status="pending"` (the winner has reserved but not yet received a `ts`). The
loser skips the send (correct — no double-post) and returns the possibly-null
`ts`. For our callers this is acceptable: the winner completes the send and the
row reaches `sent`; the verdict's thread root is recoverable from the row on the
next read. Sequential re-runs (the common case) always see the final `sent` row.

## Two interfaces (CLI + web)

### Shared shaping — `lib/sentLog.ts` (pure, unit-tested)

- `selectSent(period)` filters `outbound_messages` by `sentAt` within the period
  window (Kyiv month boundaries via `lib/period.ts`).
- Pure shaping helpers (group/sort/format) take rows → view model, no `node:fs`,
  no DB — DB access lives in a thin caller so the shaping is testable in isolation.

### CLI — `npm run sent`

`scripts/sent.ts` (+ pure `scripts/sentReport.ts` for shaping, matching the
existing `*Report.ts` convention):

```
npm run sent -- --start YYYY-MM-DD --end YYYY-MM-DD [--format table]
```

Prints the period's outbound log as JSON (default) or a human table: time,
channel, feature, kind, status, origin/trigger, text, permalink. Defaults to the
current Kyiv month. Read-only (no `--write`: the table is already the durable,
canonical store — see divergence note below).

### Web — Outbound tab

- `GET /api/sent?period=<key>` → the period's log; `?periods=1` → list of periods
  that have rows. Read-only.
- A dashboard tab ("Outbound") in `app/(dashboard)/` with an `enabled` flag in the
  nav, rendering the log table with Slack permalinks (via `permalinkFor`).
- Reuses the period-picker UX; both web and CLI consume `lib/sentLog.ts`.

### Deliberate divergence from the snapshot pattern

The house pattern is: CLI `--write` persists a committed JSON+CSV snapshot that the
web renders. That exists because Vimeo/Jira/GitHub are *external* live sources that
need a frozen record. `outbound_messages` is *already* the canonical durable store
in our own DB, so a snapshot would be a redundant copy that can drift. Therefore
the web reads `outbound_messages` directly by period, and the CLI is read-only.
Both still consume the one shared `lib/sentLog.ts` shaping module, satisfying the
two-interface requirement.

## Backfill

A one-time seed so the log reflects history already sent. Extend
`scripts/db-import.ts` (or a dedicated `scripts/backfill-outbound.ts`):

- For each `published` row → `outbound_messages` row: `key=verdict:<period>:<date>`,
  `feature="verdict"`, `kind="post"`, `status="sent"`, `ts`, `sentAt=postedAt`,
  `origin` best-effort `"unknown"`/`"vercel"`, `trigger="unknown"`.
- For each `asks` row with a posted `askedTs` → `key=ask:<gapType>:<date>`,
  `feature="ask"`, `kind="post"`, `status="sent"`, `ts=askedTs`, `sentAt=askedAt`.
- Idempotent (uses the same `ON CONFLICT DO NOTHING`), so it is safe to re-run.

Approval edits/acks and webhook failure notices are not reconstructable from
existing tables and are simply not backfilled; the log is complete from the first
new send onward.

## Testing

- `lib/sentLog.test.ts` — period filtering + shaping (pure).
- `scripts/sentReport.test.ts` — table/JSON formatting (pure), matching existing
  `*Report.test.ts` files.
- Reserve-then-send: extract the pure state-transition decision (reserve outcome →
  send-or-skip, success/failure → status) into a tested helper; the DB
  `ON CONFLICT` behavior is exercised the way other DB-touching modules are in this
  repo (or via a focused integration test if the suite supports it).
- `lib/reconcile.ts` / `lib/flightHours.ts` purity discipline is unaffected.

## Out of scope

- No retry/queue for failed sends (a `failed` row is recorded; re-running the
  caller re-attempts under the same key, which is the existing retry story).
- No web mutation of the log (read-only).
- No change to the verdict/ask/approval business logic or their tables.
