# Slack Event-ID Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Slack events webhook process each Slack event at most once, so at-least-once redelivery can no longer re-classify and flip an already-decided flight day.

**Architecture:** Deduplicate on Slack's stable `event_id`. A new `slack_events_seen` table + an atomic claim (`INSERT … ON CONFLICT DO NOTHING RETURNING`) mirror the existing `reserveSend` reserve-then-send pattern in `lib/outbound.ts`. The webhook route's envelope parsing is extracted into a pure, unit-tested `parseSlackEvent` helper; the route claims the `event_id` after confirming a tracked-channel human reply and returns early on a duplicate. The decision-keyed outbound dedup (already shipped on the parent branch) stays as a second layer.

**Tech Stack:** Next.js 16 route handler (`app/api/slack/events/route.ts`), Drizzle ORM over Vercel/Neon Postgres (`lib/db.ts`, `lib/schema.ts`), Vitest.

## Global Constraints

- TypeScript `strict`; import alias `@/*` → repo root.
- Pure logic lives in `lib/` modules and is unit-tested; DB wrappers mirror `lib/outbound.ts` and are **not** in the pure suite (verified by a scripted check), same precedent as `reserveSend`.
- DB tables are Drizzle `pgTable`s in `lib/schema.ts`; migrations are generated with `npm run db:generate` and applied with `npm run db:migrate` (needs `POSTGRES_URL`).
- The route must **always return 2xx to Slack** (a 5xx makes Slack retry and eventually disable the subscription). Never drop a real event: missing `event_id` → process without dedup (fail open).
- Failure semantics: **at-most-once** — once claimed, an event is never reprocessed even if processing fails. Do not release the claim on failure.
- Branch: `fix/slack-event-idempotency` (already checked out, stacked on `fix/approval-double-post-and-clarification`).
- `server-only` is aliased to empty under Vitest (commit `2250f71`), so server-only libs import cleanly in tests.

---

### Task 1: Pure envelope parser `parseSlackEvent`

**Files:**
- Create: `lib/slackEventParse.ts`
- Test: `lib/slackEventParse.test.ts`

**Interfaces:**
- Consumes: nothing (pure; operates on the already-JSON-parsed Slack body).
- Produces:
  - `interface SlackEventBody { type?: string; challenge?: string; event_id?: string; event?: { type?: string; subtype?: string; bot_id?: string; user?: string; text?: string; ts?: string; thread_ts?: string; channel?: string } }`
  - `type ParsedSlackEvent = { kind: "challenge"; challenge: string } | { kind: "skip"; reason: string } | { kind: "actionable"; eventId: string | null; channelId: string; userId: string; replyText: string; replyTs: string; threadTs: string }`
  - `function parseSlackEvent(body: SlackEventBody): ParsedSlackEvent`

- [ ] **Step 1: Write the failing tests**

Create `lib/slackEventParse.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseSlackEvent } from "./slackEventParse";

const reply = {
  type: "message" as const,
  user: "U08G4EC244X",
  text: "ні, не прийнято",
  ts: "1782899951.295969",
  thread_ts: "1782897379.356719",
  channel: "C08GY2NKF9D",
};

describe("parseSlackEvent", () => {
  it("returns the challenge for url_verification", () => {
    expect(parseSlackEvent({ type: "url_verification", challenge: "abc123" })).toEqual({
      kind: "challenge",
      challenge: "abc123",
    });
  });

  it("skips a non event_callback envelope", () => {
    expect(parseSlackEvent({ type: "app_rate_limited" })).toEqual({
      kind: "skip",
      reason: "not-event-callback",
    });
  });

  it("skips a bot message", () => {
    expect(
      parseSlackEvent({ type: "event_callback", event: { ...reply, bot_id: "B1" } }).kind,
    ).toBe("skip");
  });

  it("skips a message with a subtype (edit/join/etc)", () => {
    expect(
      parseSlackEvent({ type: "event_callback", event: { ...reply, subtype: "message_changed" } })
        .kind,
    ).toBe("skip");
  });

  it("skips a top-level message (not a thread reply)", () => {
    expect(
      parseSlackEvent({
        type: "event_callback",
        event: { ...reply, thread_ts: reply.ts },
      }).kind,
    ).toBe("skip");
  });

  it("returns actionable with the event_id and reply fields for a human thread reply", () => {
    expect(
      parseSlackEvent({ type: "event_callback", event_id: "Ev123", event: reply }),
    ).toEqual({
      kind: "actionable",
      eventId: "Ev123",
      channelId: "C08GY2NKF9D",
      userId: "U08G4EC244X",
      replyText: "ні, не прийнято",
      replyTs: "1782899951.295969",
      threadTs: "1782897379.356719",
    });
  });

  it("is actionable with eventId null when event_id is absent (fail open)", () => {
    const r = parseSlackEvent({ type: "event_callback", event: reply });
    expect(r.kind).toBe("actionable");
    if (r.kind === "actionable") expect(r.eventId).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/slackEventParse.test.ts`
Expected: FAIL — "Failed to resolve import ./slackEventParse" / `parseSlackEvent is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/slackEventParse.ts`:

```typescript
/**
 * Pure parser for the Slack Events API envelope: classify an incoming POST body
 * as a url_verification challenge, an ignorable event, or an actionable human
 * thread reply — extracting the fields the events route needs (incl. the stable
 * `event_id` used for at-most-once dedup). No IO — unit-tested in isolation.
 */
export interface SlackEventBody {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    channel?: string;
  };
}

export type ParsedSlackEvent =
  | { kind: "challenge"; challenge: string }
  | { kind: "skip"; reason: string }
  | {
      kind: "actionable";
      eventId: string | null;
      channelId: string;
      userId: string;
      replyText: string;
      replyTs: string;
      threadTs: string;
    };

export function parseSlackEvent(body: SlackEventBody): ParsedSlackEvent {
  if (body.type === "url_verification") {
    return { kind: "challenge", challenge: body.challenge ?? "" };
  }
  if (body.type !== "event_callback") {
    return { kind: "skip", reason: "not-event-callback" };
  }
  const e = body.event;
  // Only human thread REPLIES (not bot posts, edits/joins, or top-level messages).
  if (
    !(
      e?.type === "message" &&
      !e.subtype &&
      !e.bot_id &&
      e.user &&
      e.ts &&
      e.thread_ts &&
      e.thread_ts !== e.ts &&
      e.channel
    )
  ) {
    return { kind: "skip", reason: "filter" };
  }
  return {
    kind: "actionable",
    eventId: body.event_id ?? null,
    channelId: e.channel,
    userId: e.user,
    replyText: e.text ?? "",
    replyTs: e.ts,
    threadTs: e.thread_ts,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/slackEventParse.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/slackEventParse.ts lib/slackEventParse.test.ts
git commit -m "feat(slack): pure parseSlackEvent envelope parser (challenge/skip/actionable + event_id)"
```

---

### Task 2: `slack_events_seen` table + migration

**Files:**
- Modify: `lib/schema.ts` (add a `pgTable` after `outboundMessages`, ~line 126)
- Create: `drizzle/000X_*.sql` (generated — do not hand-write)
- Test: `lib/schema.slackEvents.test.ts`

**Interfaces:**
- Produces: `schema.slackEventsSeen` — a Drizzle table with columns `eventId` (PK, `event_id`), `seenAt` (`seen_at`), `eventType` (`event_type`, nullable), `outcome` (nullable).

- [ ] **Step 1: Write the failing schema test**

Create `lib/schema.slackEvents.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { slackEventsSeen } from "./schema";

describe("slack_events_seen schema", () => {
  it("exposes event_id as the primary key plus audit columns", () => {
    expect(slackEventsSeen.eventId.name).toBe("event_id");
    expect(slackEventsSeen.eventId.primary).toBe(true);
    expect(slackEventsSeen.seenAt.name).toBe("seen_at");
    expect(slackEventsSeen.eventType.name).toBe("event_type");
    expect(slackEventsSeen.outcome.name).toBe("outcome");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/schema.slackEvents.test.ts`
Expected: FAIL — `slackEventsSeen` is not exported from `./schema`.

- [ ] **Step 3: Add the table to `lib/schema.ts`**

Insert after the `outboundMessages` table (after line 126), before `rosterAliases`. `pgTable` and `text` are already imported at the top of the file.

```typescript
/** Slack event-id dedup: process each Events API delivery at most once. */
export const slackEventsSeen = pgTable("slack_events_seen", {
  eventId: text("event_id").primaryKey(), // Slack's stable event_id (reused across retries)
  seenAt: text("seen_at").notNull(), // ISO of first claim
  eventType: text("event_type"), // inner event.type (audit)
  outcome: text("outcome"), // short result tag (audit)
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/schema.slackEvents.test.ts`
Expected: PASS.

- [ ] **Step 5: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/000X_*.sql` containing `CREATE TABLE "slack_events_seen" ( "event_id" text PRIMARY KEY NOT NULL, "seen_at" text NOT NULL, "event_type" text, "outcome" text );`. Confirm no other table is altered in the generated file.

- [ ] **Step 6: Apply the migration to Neon**

Run: `npm run db:migrate`
Expected: applies cleanly. Verify: `psql "$POSTGRES_URL" -c "\d slack_events_seen"` (or a `SELECT * FROM slack_events_seen LIMIT 1;` returning zero rows, no error).

- [ ] **Step 7: Commit**

```bash
git add lib/schema.ts lib/schema.slackEvents.test.ts drizzle/
git commit -m "feat(db): slack_events_seen table + migration for event-id dedup"
```

---

### Task 3: `claimSlackEvent` DB wrapper

**Files:**
- Create: `lib/slackEventClaim.ts`
- (Verification only — no committed unit test, mirroring `reserveSend`.)

**Interfaces:**
- Consumes: `db`, `schema` from `lib/db.ts`; `schema.slackEventsSeen` from Task 2.
- Produces: `function claimSlackEvent(eventId: string, seenAt: string, meta?: { eventType?: string; outcome?: string }): Promise<boolean>` — `true` when this call claimed the id (first time → caller should process), `false` when it already existed (duplicate → caller should skip).

- [ ] **Step 1: Write the implementation**

Create `lib/slackEventClaim.ts`:

```typescript
/**
 * Slack event-id idempotency claim. Atomic reserve mirroring lib/outbound.ts's
 * reserveSend: INSERT ... ON CONFLICT DO NOTHING RETURNING makes "have we seen
 * this event_id?" a single atomic step safe across concurrent deliveries. Returns
 * true when our insert landed (first time — process the event), false when the
 * row already existed (a redelivery — skip). NOT server-only (the events route is
 * server-side, but this follows the lib/outbound.ts precedent).
 */
import { db, schema } from "./db";

export async function claimSlackEvent(
  eventId: string,
  seenAt: string,
  meta?: { eventType?: string; outcome?: string },
): Promise<boolean> {
  const inserted = await db
    .insert(schema.slackEventsSeen)
    .values({
      eventId,
      seenAt,
      eventType: meta?.eventType ?? null,
      outcome: meta?.outcome ?? null,
    })
    .onConflictDoNothing()
    .returning();
  return inserted.length > 0;
}
```

- [ ] **Step 2: Verify tsc is clean**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify the atomic claim against Neon (scripted, not committed)**

Create a throwaway script at your scratchpad path (NOT under the repo), e.g. `/tmp/claim-check.ts`:

```typescript
process.loadEnvFile();
import { claimSlackEvent } from "/workspaces/orients-ops-console/lib/slackEventClaim";
const id = "Ev_TEST_" + "claimcheck";
const a = await claimSlackEvent(id, new Date().toISOString(), { eventType: "test" });
const b = await claimSlackEvent(id, new Date().toISOString(), { eventType: "test" });
console.log("first:", a, "second:", b); // expect: first true, second false
```

Run: `node --conditions=react-server --import tsx /tmp/claim-check.ts`
Expected output: `first: true second: false`.
Cleanup: `psql "$POSTGRES_URL" -c "DELETE FROM slack_events_seen WHERE event_id LIKE 'Ev_TEST_%';"` and `rm /tmp/claim-check.ts`.

- [ ] **Step 4: Commit**

```bash
git add lib/slackEventClaim.ts
git commit -m "feat(slack): claimSlackEvent atomic event-id claim (reserveSend-style)"
```

---

### Task 4: Wire the events route to parse + claim

**Files:**
- Modify: `app/api/slack/events/route.ts`

**Interfaces:**
- Consumes: `parseSlackEvent`, `SlackEventBody` (Task 1); `claimSlackEvent` (Task 3).
- Produces: no new exports — behavior change only.

- [ ] **Step 1: Replace the envelope-handling block**

In `app/api/slack/events/route.ts`:

Add imports near the existing `@/lib` imports (top of file):

```typescript
import { parseSlackEvent, type SlackEventBody } from "@/lib/slackEventParse";
import { claimSlackEvent } from "@/lib/slackEventClaim";
```

Delete the local `interface SlackEventBody { … }` block (lines ~35-49) — it now comes from `lib/slackEventParse`.

Replace the region from the `body.type === "url_verification"` check through the `replyTs` extraction (currently lines ~120-153, ending just before `try {`) with:

```typescript
  const parsed = parseSlackEvent(body);
  if (parsed.kind === "challenge") return Response.json({ challenge: parsed.challenge });
  if (parsed.kind === "skip") return ack({ skipped: parsed.reason });

  const channel = TRACKED_CHANNELS.find((c) => c.id === parsed.channelId);
  if (!channel) return ack({ skipped: "untracked-channel", channel: parsed.channelId });

  // Event-id idempotency: Slack delivers at-least-once and retries any delivery
  // it doesn't see 2xx'd within 3s, reusing the same event_id. Claim it once
  // (atomic) so a redelivery never re-classifies and flips an already-decided
  // day. At-most-once: we keep the claim even if the effect below fails — a
  // transient failure recovers via the in-thread notice + a manual
  // `field-approvals` re-run, not via Slack's retry.
  if (parsed.eventId) {
    const fresh = await claimSlackEvent(parsed.eventId, new Date().toISOString(), {
      eventType: "message",
    });
    if (!fresh) {
      console.log(`slack events: duplicate event_id=${parsed.eventId} — skipping`);
      return ack({ skipped: "duplicate-event", event_id: parsed.eventId });
    }
  } else {
    console.warn("slack events: event_callback without event_id — processing without dedup");
  }

  const replyPermalink = permalinkFor(channel.id, parsed.replyTs);
  const replyText = parsed.replyText;
  const userId = parsed.userId;
  const threadTs = parsed.threadTs;
  const replyTs = parsed.replyTs;
```

The `try { … }` dispatch block that follows (S7 approver / S6 answer, the `findPublishedByTs`/`findAskByTs` calls and their `failVisibly` handlers) is unchanged — it already consumes `channel`, `replyPermalink`, `replyText`, `userId`, `threadTs`, `replyTs`.

- [ ] **Step 2: Update the route header comment**

Replace the idempotency claim in the top-of-file doc comment (currently ~lines 11-16, "The whole flow is idempotent (override marker / ask-state guards) …") with:

```typescript
 * The effect runs INLINE (awaited before the response). It's a Neon lookup +
 * one Claude classify + Slack edit/ack (~2-3s); Next's `after()` proved
 * unreliable on Vercel, so we do the work synchronously. Each Slack event is
 * claimed by its `event_id` (lib/slackEventClaim) BEFORE any effect and
 * processed at most once, so Slack's at-least-once redelivery can never
 * re-classify or flip an already-decided day. The decision-keyed outbound dedup
 * (lib/outboundKeys) is a second layer on the resulting edit/ack.
```

- [ ] **Step 3: Verify tsc + lint + full suite**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: tsc clean; lint no new errors; all tests pass (existing count + the 8 new tests from Tasks 1-2).

- [ ] **Step 4: Commit**

```bash
git add app/api/slack/events/route.ts
git commit -m "fix(slack): claim event_id before processing so redeliveries never reprocess"
```

---

## Self-Review

**Spec coverage:**
- Table `slack_events_seen` → Task 2. ✓
- `claimSlackEvent` atomic claim → Task 3. ✓
- `event_id` on envelope + `parseSlackEvent` extraction → Task 1. ✓
- Route claims after the tracked-channel filter, duplicate → early ack → Task 4. ✓
- Missing event_id → fail open (process) → Task 1 (eventId null) + Task 4 (else branch). ✓
- At-most-once (keep claim on failure) → Task 4 (claim before the try; no release) + header comment. ✓
- Defense-in-depth with decision-keyed outbound dedup → present on parent branch; header comment references it (Task 4 Step 2). ✓
- Testing: pure `parseSlackEvent` unit tests (Task 1), schema shape test (Task 2), scripted DB claim check (Task 3), full green gate (Task 4). ✓

**Placeholder scan:** none — every code step has complete code; `000X` in Task 2 is the drizzle-kit-assigned number (explicitly generated, not hand-written).

**Type consistency:** `parseSlackEvent`/`ParsedSlackEvent`/`SlackEventBody` (Task 1) consumed verbatim in Task 4; `claimSlackEvent(eventId, seenAt, meta)` (Task 3) called with those exact args in Task 4; `schema.slackEventsSeen` columns (`eventId`/`seenAt`/`eventType`/`outcome`) defined in Task 2 and used in Task 3. Consistent.
