# Slack event-id idempotency for the events webhook

**Date:** 2026-07-01
**Status:** Approved — ready for implementation plan
**Branch:** `fix/slack-event-idempotency` (stacked on `fix/approval-double-post-and-clarification`)

## Problem

Slack's Events API delivers at-least-once and **retries** any delivery it doesn't
see a 2xx for within 3 seconds. `app/api/slack/events/route.ts` reprocesses every
redelivery from scratch: it re-runs the Claude classification, `upsertResolution`,
and the Slack edit/ack for each delivery of the same underlying reply.

The route's header comment (lines 14–15) asserts the flow is idempotent via the
"override marker" guard in `applyApproverDecision` (line 47:
`if (entry.override?.decision === decision) return alreadyAcked`). That guard does
**not** hold under redelivery:

- **Concurrent deliveries race.** Two deliveries of the same reply both read
  `entry.override == null` before either calls `writePublished`, so both pass the
  guard and both apply. Observed on 2026-06-21: two identical `accepted_exception`
  acks 1.9s apart (12:57).
- **Post-flip redelivery re-applies.** A redelivery arriving *after* the decision
  has changed reads a *different* current decision and re-applies the stale one.
  Observed on 2026-06-21: a redelivery of the 12:57 approve reply arrived at 13:03
  — six minutes after the 12:59 rejection — and flipped the stored resolution
  `rejected → accepted_exception`, contradicting the approver's explicit
  "ні, не прийнято".

A related symptom: `resolutions` and `published.override` drifted out of sync
(resolution = `accepted_exception`, override = `rejected`) because reprocessing
wrote them at different times.

The decision-keyed outbound dedup shipped in `fix/approval-double-post-and-\
clarification` stops the duplicate *Slack posts*, but does **not** stop the
redelivered event from re-running classification and flipping the stored
resolution. That is this fix's job.

## Fix

Deduplicate on Slack's **`event_id`** — the stable identifier Slack reuses across
every retry of the same event. Each `event_id` is processed **at most once**.

**Failure semantics (decided):** once an event is claimed, it is never
reprocessed, even if processing then fails. This guarantees no double-apply / no
flip. Recovery for a genuine transient failure (Claude/Slack/DB error) stays the
existing path: the in-thread failure notice (`failVisibly`) + a manual
`npm run field-approvals -- --write` re-run, which re-reads the thread and applies
the current state. We do **not** release the claim on failure (that would reopen a
double-apply window when a failure lands after partial side effects).

## Components

### 1. Table `slack_events_seen`

New Drizzle `pgTable` in `lib/schema.ts` + a `drizzle-kit generate` migration:

| column       | type | notes                                            |
|--------------|------|--------------------------------------------------|
| `event_id`   | text | **primary key** — Slack's `event_id` (e.g. `Ev…`) |
| `seen_at`    | text | ISO timestamp of first claim                     |
| `event_type` | text | the inner `event.type` (audit)                   |
| `outcome`    | text | nullable; short result tag for observability (audit) |

Small, append-only, text PK. Pruning is out of scope (add later if volume warrants).

### 2. `lib/slackEventClaim.ts`

```
claimSlackEvent(eventId: string, seenAt: string, meta?: {...}): Promise<boolean>
```

Atomic `INSERT … ON CONFLICT DO NOTHING RETURNING`, mirroring `reserveSend` in
`lib/outbound.ts`. Returns `true` when our insert landed (first time → process),
`false` when the row already existed (duplicate → skip). Not `server-only` — same
precedent as `lib/outbound.ts` / `lib/published.ts`.

### 3. Route wiring (`app/api/slack/events/route.ts`)

- Add `event_id?: string` to the `SlackEventBody` envelope interface.
- Extract the route's envelope parsing into a **pure** helper
  `parseSlackEvent(body): { kind: "challenge" | "skip" | "actionable"; eventId?: string; … }`
  so the classification (challenge / ignorable / actionable tracked-channel human
  reply) is unit-testable in isolation. The route consumes its result.
- After signature verification, `event_callback` check, and the existing
  tracked-channel + human-reply filter — i.e. once we know this is an **actionable**
  reply — call `claimSlackEvent(eventId, now)`. Placing the claim *after* the
  filter means only actionable tracked-channel replies get a row (low volume,
  exactly the surface that can flip).
- If the claim returns `false`: `return ack({ skipped: "duplicate-event", event_id })`
  before any classify/apply.
- If there is no `event_id` on an `event_callback` (should not happen): log and
  process without dedup (fail open, never drop a real event).
- Keep the claim regardless of the downstream outcome (at-most-once).

## Defense in depth

Two layers, both kept:
1. **`event_id` claim** (this fix) — the redelivered event never reprocesses.
2. **Decision-keyed outbound dedup** (fix #2) — even if an event somehow
   reprocesses, the same-decision edit/ack won't repost.

## Testing (TDD)

- **`parseSlackEvent` (pure):** unit tests — url_verification → challenge; missing
  `event_id` → flagged; bot/subtype/non-reply/untracked → skip; a human reply in a
  tracked channel under a thread → actionable with the extracted `event_id`,
  channel, user, ts, thread_ts.
- **Schema shape:** a `slack_events_seen` test mirroring `lib/schema.outbound.test.ts`
  (columns + primary key).
- **Atomic claim:** a DB property, like `reserveSend` (not unit-tested in the pure
  suite). Verified with a scripted check against Neon: claim the same id twice →
  first `true`, second `false`.
- Full suite + `tsc` + `lint` green before completion.

## Out of scope

- Reconciling existing `resolutions` / `published.override` drift — becomes moot
  once redeliveries stop reprocessing.
- Pruning/TTL for `slack_events_seen`.
- Any change to the CLI paths (`field-approvals`, `field-remember`); they read the
  thread deliberately and are not event-driven.
