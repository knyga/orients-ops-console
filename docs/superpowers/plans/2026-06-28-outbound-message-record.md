# Outbound Message Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durably remember every Slack message the bot posts/edits — from any execution point (Vercel webhook, cron, local CLI) — and dedup sends across those points via reserve-then-send.

**Architecture:** A new `outbound_messages` Postgres table keyed by a per-action idempotency key. All sends funnel through `lib/slack.ts` (`postMessage`/`updateMessage`); we wrap them with a `sendTracked` helper that reserves a row (`INSERT … ON CONFLICT DO NOTHING`) before calling Slack, then marks it `sent`/`failed`. A read-only CLI (`npm run sent`) and web tab ("Outbound") render the log via shared pure shaping in `lib/sentLog.ts`.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Drizzle ORM over Vercel/Neon Postgres, Vitest, tsx CLIs.

## Global Constraints

- Every feature ships **two** interfaces: a web view AND a CLI. Shared logic lives in pure `lib/` modules.
- `lib/slack.ts` imports `server-only`; never remove it, never import it from a `"use client"` file. CLIs run via `node --conditions=react-server --import tsx` so the `server-only` import resolves to an empty module.
- `lib/db.ts` / `lib/schema.ts` are **not** `server-only` (CLIs import them). The browser bundle never imports them (only API routes do).
- Pure `lib/` modules stay free of React/Next/`node:fs` imports so they're unit-testable and client-bundle-safe where needed.
- Import alias `@/*` maps to the repo root. TypeScript `strict` is on.
- DB migrations are generated with `npm run db:generate` (drizzle-kit) from `lib/schema.ts` and applied with `npm run db:migrate` (needs `POSTGRES_URL`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Idempotency key conventions (verbatim):
  - verdict post: `verdict:<periodKey>:<date>`
  - gap question: `ask:<gapType>:<date>`
  - approval edit: `approval-edit:<date>:<rev>`
  - approval ack reply: `approval-ack:<date>:<rev>`
  - webhook failure notice: `webhook-failure:<date>:<kind>:<rev>`
  - bonus thread breakdown: `bonus-thread:<date>`
  - bonus per-person DM: `bonus-dm:<date>:<slackId>`
  - `<rev>` = `contentRev(text)` (a stable djb2 base-36 hash of the message text).
- `origin` values: `"vercel"` | `"local"` (auto-detected) | `"unknown"` (backfill only). `trigger` values: `"cli"` | `"cron"` | `"webhook"` | `"unknown"`.

---

## File Structure

- `lib/schema.ts` — **modify**: add `outboundMessages` table.
- `lib/outboundKeys.ts` — **create**: pure key builders, `contentRev`, `detectOrigin`, `decideReserve`, shared types.
- `lib/outbound.ts` — **create**: DB layer (`reserveSend`, `markSent`, `markFailed`, `readOutbound`, `readOutboundPeriods`). Not server-only.
- `lib/sendTracked.ts` — **create**: reserve-then-send wrapper (no `server-only`, takes the raw sender as a callback so it is unit-testable).
- `lib/slack.ts` — **modify**: `postMessage`/`updateMessage` gain a required `meta` arg and delegate to `sendTracked`; extract raw fetches to private `rawPost`/`rawUpdate`.
- `scripts/field-publish.ts`, `scripts/field-ask.ts`, `lib/applyApproval.ts`, `app/api/slack/events/route.ts`, `scripts/field-approvals.ts`, `scripts/field-bonus.ts` — **modify**: pass `meta`/`trigger` at every send site.
- `lib/sentLog.ts` — **create**: pure shaping (`toSentView`, `summarizeSent`) + view types.
- `scripts/sentReport.ts` — **create**: pure CLI arg parsing + table formatting.
- `scripts/sent.ts` — **create**: CLI entry. `package.json` — **modify**: add `sent` + `backfill-outbound` scripts.
- `app/api/sent/route.ts` — **create**: read-only API.
- `app/(dashboard)/sent/page.tsx` — **create**: Outbound tab. `app/(dashboard)/layout.tsx` — **modify**: add nav entry.
- `scripts/backfill-outbound.ts` — **create**: one-time seed from `published`/`asks`.

---

## Task 1: Add the `outbound_messages` table + migration

**Files:**
- Modify: `lib/schema.ts`
- Test: `lib/schema.outbound.test.ts`
- Generated: `drizzle/<NNNN>_*.sql` (name assigned by drizzle-kit)

**Interfaces:**
- Produces: `outboundMessages` Drizzle table with columns `key` (PK), `feature`, `kind`, `channel`, `channelId`, `text`, `threadTs`, `ts`, `status`, `origin`, `trigger`, `error`, `attempts`, `reservedAt`, `sentAt`. Row type alias `typeof schema.outboundMessages.$inferSelect`.

- [ ] **Step 1: Write the failing test**

Create `lib/schema.outbound.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { outboundMessages } from "./schema";

describe("outbound_messages schema", () => {
  it("exposes the expected primary key and columns", () => {
    expect(outboundMessages.key.name).toBe("key");
    expect(outboundMessages.key.primary).toBe(true);
    expect(outboundMessages.status.name).toBe("status");
    expect(outboundMessages.origin.name).toBe("origin");
    expect(outboundMessages.trigger.name).toBe("trigger");
    expect(outboundMessages.attempts.name).toBe("attempts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/schema.outbound.test.ts`
Expected: FAIL — `outboundMessages` is not exported from `./schema`.

- [ ] **Step 3: Add the table to `lib/schema.ts`**

`integer` and `index` are already imported at the top of the file. Append after the `asks` table:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/schema.outbound.test.ts`
Expected: PASS.

- [ ] **Step 5: Generate the SQL migration**

Run: `npm run db:generate`
Expected: a new file `drizzle/<NNNN>_*.sql` containing `CREATE TABLE "outbound_messages"`. (Do **not** hand-edit it.)

> Note: `npm run db:migrate` (which applies the SQL to the live DB) requires `POSTGRES_URL` and is a deploy/ops step — run it where the DB env is available, not necessarily in this dev step.

- [ ] **Step 6: Commit**

```bash
git add lib/schema.ts lib/schema.outbound.test.ts drizzle/
git commit -m "feat(outbound): add outbound_messages table + migration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure helpers — `lib/outboundKeys.ts`

**Files:**
- Create: `lib/outboundKeys.ts`
- Test: `lib/outboundKeys.test.ts`

**Interfaces:**
- Produces:
  - `type SendTrigger = "cli" | "cron" | "webhook" | "unknown"`
  - `type OutboundStatus = "pending" | "sent" | "failed" | "skipped"`
  - `contentRev(text: string): string`
  - `detectOrigin(env?: NodeJS.ProcessEnv): "vercel" | "local"`
  - `verdictKey(periodKey: string, date: string): string`
  - `askKey(gapType: string, date: string): string`
  - `approvalEditKey(date: string, rev: string): string`
  - `approvalAckKey(date: string, rev: string): string`
  - `webhookFailureKey(date: string, kind: string, rev: string): string`
  - `bonusThreadKey(date: string): string`
  - `bonusDmKey(date: string, slackId: string): string`
  - `decideReserve(inserted: { ts: string | null } | null, existing: { status: OutboundStatus; ts: string | null } | null): { won: boolean; existingTs: string | null }`

- [ ] **Step 1: Write the failing test**

Create `lib/outboundKeys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  approvalAckKey,
  approvalEditKey,
  askKey,
  bonusDmKey,
  bonusThreadKey,
  contentRev,
  decideReserve,
  detectOrigin,
  verdictKey,
  webhookFailureKey,
} from "./outboundKeys";

describe("key builders", () => {
  it("build stable, namespaced keys", () => {
    expect(verdictKey("2026-06", "2026-06-01")).toBe("verdict:2026-06:2026-06-01");
    expect(askKey("no_dataset", "2026-06-08")).toBe("ask:no_dataset:2026-06-08");
    expect(approvalEditKey("2026-06-04", "abc")).toBe("approval-edit:2026-06-04:abc");
    expect(approvalAckKey("2026-06-04", "abc")).toBe("approval-ack:2026-06-04:abc");
    expect(webhookFailureKey("2026-06-04", "approver", "abc")).toBe(
      "webhook-failure:2026-06-04:approver:abc",
    );
    expect(bonusThreadKey("2026-06-04")).toBe("bonus-thread:2026-06-04");
    expect(bonusDmKey("2026-06-04", "U123")).toBe("bonus-dm:2026-06-04:U123");
  });
});

describe("contentRev", () => {
  it("is deterministic and differs by content", () => {
    expect(contentRev("hello")).toBe(contentRev("hello"));
    expect(contentRev("hello")).not.toBe(contentRev("world"));
    expect(contentRev("hello")).toMatch(/^[0-9a-z]+$/);
  });
});

describe("detectOrigin", () => {
  it("maps VERCEL=1 to vercel, else local", () => {
    expect(detectOrigin({ VERCEL: "1" } as NodeJS.ProcessEnv)).toBe("vercel");
    expect(detectOrigin({} as NodeJS.ProcessEnv)).toBe("local");
  });
});

describe("decideReserve", () => {
  it("wins when our insert succeeded", () => {
    expect(decideReserve({ ts: "1.2" }, null)).toEqual({ won: true, existingTs: "1.2" });
  });
  it("retries a previously failed row", () => {
    expect(decideReserve(null, { status: "failed", ts: null })).toEqual({
      won: true,
      existingTs: null,
    });
  });
  it("loses to an existing sent/pending row and returns its ts", () => {
    expect(decideReserve(null, { status: "sent", ts: "9.9" })).toEqual({
      won: false,
      existingTs: "9.9",
    });
    expect(decideReserve(null, { status: "pending", ts: null })).toEqual({
      won: false,
      existingTs: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/outboundKeys.test.ts`
Expected: FAIL — module `./outboundKeys` not found.

- [ ] **Step 3: Implement `lib/outboundKeys.ts`**

```ts
/**
 * Pure helpers for the outbound-message record: idempotency-key builders, a
 * content hash for keying distinct edits, origin detection, and the
 * reserve-then-send decision. No DB, no Slack, no node:fs — unit-testable.
 */
export type SendTrigger = "cli" | "cron" | "webhook" | "unknown";
export type OutboundStatus = "pending" | "sent" | "failed" | "skipped";

/** Stable, dependency-free djb2 hash → base36. Used to key distinct edits. */
export function contentRev(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** Which point of execution this is. Vercel sets VERCEL=1 in its runtime. */
export function detectOrigin(env: NodeJS.ProcessEnv = process.env): "vercel" | "local" {
  return env.VERCEL === "1" ? "vercel" : "local";
}

export const verdictKey = (periodKey: string, date: string): string =>
  `verdict:${periodKey}:${date}`;
export const askKey = (gapType: string, date: string): string => `ask:${gapType}:${date}`;
export const approvalEditKey = (date: string, rev: string): string =>
  `approval-edit:${date}:${rev}`;
export const approvalAckKey = (date: string, rev: string): string =>
  `approval-ack:${date}:${rev}`;
export const webhookFailureKey = (date: string, kind: string, rev: string): string =>
  `webhook-failure:${date}:${kind}:${rev}`;
export const bonusThreadKey = (date: string): string => `bonus-thread:${date}`;
export const bonusDmKey = (date: string, slackId: string): string =>
  `bonus-dm:${date}:${slackId}`;

/**
 * Decide the reserve outcome. We win (and should send) when our INSERT landed,
 * OR when the only existing row is a prior FAILED attempt (retry). We lose (skip
 * the send) when a sent/pending/skipped row already holds the key.
 */
export function decideReserve(
  inserted: { ts: string | null } | null,
  existing: { status: OutboundStatus; ts: string | null } | null,
): { won: boolean; existingTs: string | null } {
  if (inserted) return { won: true, existingTs: inserted.ts };
  if (existing && existing.status === "failed") return { won: true, existingTs: existing.ts };
  return { won: false, existingTs: existing?.ts ?? null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/outboundKeys.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/outboundKeys.ts lib/outboundKeys.test.ts
git commit -m "feat(outbound): pure key builders + reserve decision

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: DB layer — `lib/outbound.ts`

**Files:**
- Create: `lib/outbound.ts`

**Interfaces:**
- Consumes: `decideReserve`, `OutboundStatus` from `./outboundKeys`; `db`, `schema` from `./db`; `Period` from `./period`.
- Produces:
  - `type OutboundRow = typeof schema.outboundMessages.$inferSelect`
  - `interface ReserveArgs { key; feature; kind; channel; channelId; text; threadTs: string | null; ts: string | null; origin: string; trigger: string; reservedAt: string }`
  - `reserveSend(args: ReserveArgs): Promise<{ won: boolean; existingTs: string | null }>`
  - `markSent(key: string, ts: string, sentAt: string): Promise<void>`
  - `markFailed(key: string, error: string): Promise<void>`
  - `readOutbound(period: Period): Promise<OutboundRow[]>`
  - `readOutboundPeriods(): Promise<string[]>`

> This is a thin DB wrapper (same "no direct DB unit test" precedent as `lib/published.ts`). Its decision logic is `decideReserve` (tested in Task 2); its send wiring is exercised by `lib/sendTracked.test.ts` (Task 4) with `reserveSend` mocked. The gate here is type-check + the existing suite staying green.

- [ ] **Step 1: Implement `lib/outbound.ts`**

```ts
/**
 * DB layer for the outbound-message record. NOT server-only (the CLIs import it,
 * same precedent as lib/published.ts). Holds the reserve-then-send writes and the
 * read paths the CLI + web render. Pure decision logic lives in ./outboundKeys.
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "./db";
import { decideReserve, type OutboundStatus } from "./outboundKeys";
import type { Period } from "./period";

export type OutboundRow = typeof schema.outboundMessages.$inferSelect;

export interface ReserveArgs {
  key: string;
  feature: string;
  kind: string;
  channel: string;
  channelId: string;
  text: string;
  threadTs: string | null;
  ts: string | null;
  origin: string;
  trigger: string;
  reservedAt: string;
}

/**
 * Reserve the key by inserting a `pending` row. ON CONFLICT DO NOTHING makes the
 * insert atomic across execution points. If we lose, a prior FAILED row is
 * reclaimed for retry (set back to pending); a sent/pending row means skip.
 */
export async function reserveSend(
  args: ReserveArgs,
): Promise<{ won: boolean; existingTs: string | null }> {
  const inserted = await db
    .insert(schema.outboundMessages)
    .values({
      key: args.key,
      feature: args.feature,
      kind: args.kind,
      channel: args.channel,
      channelId: args.channelId,
      text: args.text,
      threadTs: args.threadTs,
      ts: args.ts,
      status: "pending",
      origin: args.origin,
      trigger: args.trigger,
      error: null,
      attempts: 1,
      reservedAt: args.reservedAt,
      sentAt: null,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) {
    return decideReserve({ ts: inserted[0].ts ?? null }, null);
  }

  const [existing] = await db
    .select()
    .from(schema.outboundMessages)
    .where(eq(schema.outboundMessages.key, args.key))
    .limit(1);

  const decision = decideReserve(
    null,
    existing ? { status: existing.status as OutboundStatus, ts: existing.ts ?? null } : null,
  );

  if (decision.won && existing) {
    await db
      .update(schema.outboundMessages)
      .set({
        status: "pending",
        attempts: (existing.attempts ?? 1) + 1,
        error: null,
        reservedAt: args.reservedAt,
      })
      .where(eq(schema.outboundMessages.key, args.key));
  }

  return decision;
}

export async function markSent(key: string, ts: string, sentAt: string): Promise<void> {
  await db
    .update(schema.outboundMessages)
    .set({ status: "sent", ts, sentAt })
    .where(eq(schema.outboundMessages.key, key));
}

export async function markFailed(key: string, error: string): Promise<void> {
  await db
    .update(schema.outboundMessages)
    .set({ status: "failed", error })
    .where(eq(schema.outboundMessages.key, key));
}

/** Rows sent within [period.start, period.end] (UTC), newest first. */
export async function readOutbound(period: Period): Promise<OutboundRow[]> {
  const startIso = `${period.start}T00:00:00.000Z`;
  const endIso = `${period.end}T23:59:59.999Z`;
  return db
    .select()
    .from(schema.outboundMessages)
    .where(
      and(
        gte(schema.outboundMessages.sentAt, startIso),
        lte(schema.outboundMessages.sentAt, endIso),
      ),
    )
    .orderBy(desc(schema.outboundMessages.sentAt));
}

/** Distinct YYYY-MM (UTC) months that have sent rows, newest first. */
export async function readOutboundPeriods(): Promise<string[]> {
  const rows = await db
    .select({ sentAt: schema.outboundMessages.sentAt })
    .from(schema.outboundMessages);
  const months = new Set<string>();
  for (const r of rows) if (r.sentAt) months.add(r.sentAt.slice(0, 7));
  return [...months].sort().reverse();
}
```

- [ ] **Step 2: Type-check + run the full suite (nothing should break)**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (no type errors; existing tests unaffected).

- [ ] **Step 3: Commit**

```bash
git add lib/outbound.ts
git commit -m "feat(outbound): DB layer for reserve-then-send + reads

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Reserve-then-send wrapper + wire it into every send

**Files:**
- Create: `lib/sendTracked.ts`
- Test: `lib/sendTracked.test.ts`
- Modify: `lib/slack.ts` (postMessage line 323, updateMessage line 351)
- Modify: `scripts/field-publish.ts:94`, `scripts/field-ask.ts:85`, `lib/applyApproval.ts:64-66`, `scripts/field-approvals.ts:97`, `app/api/slack/events/route.ts` (failVisibly + its callers + applyApproverReply call), `scripts/field-bonus.ts` (the two `postMessage` calls in the `--notify` block)

> Note: `lib/slack.ts` also exports `openDm` (opens a DM conversation, no text). It is intentionally **not** tracked — the audit log records messages posted, not channel-open calls. Only the `postMessage` that follows `openDm` is tracked.

**Interfaces:**
- Consumes: `reserveSend`, `markSent`, `markFailed` from `./outbound`; `detectOrigin` + `SendTrigger` from `./outboundKeys`.
- Produces:
  - `interface SendMeta { key: string; feature: string; channel: string; trigger?: SendTrigger }`
  - `sendTracked(args: { channelId: string; text: string; kind: "post" | "reply" | "edit"; threadTs: string | null; ts: string | null; meta: SendMeta }, rawSend: () => Promise<string>): Promise<string>`
  - `lib/slack.ts`: `postMessage(channelId: string, text: string, meta: SendMeta, threadTs?: string): Promise<string>`; `updateMessage(channelId: string, ts: string, text: string, meta: SendMeta): Promise<void>`; re-exports `SendMeta`.
  - `lib/applyApproval.ts`: `ApproverDecisionArgs` and `ApproverReplyArgs` gain `trigger?: SendTrigger`.

- [ ] **Step 1: Write the failing test for `sendTracked`**

Create `lib/sendTracked.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const reserveSend = vi.fn();
const markSent = vi.fn();
const markFailed = vi.fn();
vi.mock("./outbound", () => ({ reserveSend, markSent, markFailed }));

import { sendTracked } from "./sendTracked";

const baseArgs = {
  channelId: "C1",
  text: "hi",
  kind: "post" as const,
  threadTs: null,
  ts: null,
  meta: { key: "verdict:2026-06:2026-06-01", feature: "verdict", channel: "field-qa" },
};

beforeEach(() => {
  reserveSend.mockReset();
  markSent.mockReset();
  markFailed.mockReset();
});

describe("sendTracked", () => {
  it("skips the send and returns the existing ts when reserve is lost", async () => {
    reserveSend.mockResolvedValue({ won: false, existingTs: "111.22" });
    const rawSend = vi.fn();
    const ts = await sendTracked(baseArgs, rawSend);
    expect(ts).toBe("111.22");
    expect(rawSend).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });

  it("sends, marks sent, and returns the new ts when reserve is won", async () => {
    reserveSend.mockResolvedValue({ won: true, existingTs: null });
    const rawSend = vi.fn().mockResolvedValue("999.88");
    const ts = await sendTracked(baseArgs, rawSend);
    expect(ts).toBe("999.88");
    expect(rawSend).toHaveBeenCalledOnce();
    expect(markSent).toHaveBeenCalledWith("verdict:2026-06:2026-06-01", "999.88", expect.any(String));
  });

  it("marks failed and rethrows when the send throws", async () => {
    reserveSend.mockResolvedValue({ won: true, existingTs: null });
    const rawSend = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(sendTracked(baseArgs, rawSend)).rejects.toThrow("boom");
    expect(markFailed).toHaveBeenCalledWith("verdict:2026-06:2026-06-01", "boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/sendTracked.test.ts`
Expected: FAIL — module `./sendTracked` not found.

- [ ] **Step 3: Implement `lib/sendTracked.ts`**

```ts
/**
 * Reserve-then-send wrapper: the one place every outbound Slack message is
 * recorded + deduped. Deliberately NOT server-only and Slack-agnostic — it takes
 * the raw sender as a callback — so it is unit-testable and the server-only Slack
 * code stays in lib/slack.ts.
 */
import { detectOrigin, type SendTrigger } from "./outboundKeys";
import { markFailed, markSent, reserveSend } from "./outbound";

export interface SendMeta {
  /** Logical-action idempotency key (see lib/outboundKeys.ts builders). */
  key: string;
  feature: string; // "verdict" | "ask" | "approval" | "webhook-failure"
  channel: string; // tracked channel NAME (for the audit row)
  trigger?: SendTrigger;
}

export interface TrackedSendArgs {
  channelId: string;
  text: string;
  kind: "post" | "reply" | "edit";
  threadTs: string | null;
  ts: string | null; // known up-front for edits; null for new posts
  meta: SendMeta;
}

/**
 * Reserve the key, then call `rawSend` only if we own the reservation. `rawSend`
 * returns the posted ts (for edits it returns the edited message's ts). On
 * success the row is marked sent; on failure marked failed and the error rethrows.
 */
export async function sendTracked(
  args: TrackedSendArgs,
  rawSend: () => Promise<string>,
): Promise<string> {
  const reservedAt = new Date().toISOString();
  const { won, existingTs } = await reserveSend({
    key: args.meta.key,
    feature: args.meta.feature,
    kind: args.kind,
    channel: args.meta.channel,
    channelId: args.channelId,
    text: args.text,
    threadTs: args.threadTs,
    ts: args.ts,
    origin: detectOrigin(),
    trigger: args.meta.trigger ?? "unknown",
    reservedAt,
  });

  if (!won) return existingTs ?? args.ts ?? "";

  try {
    const ts = await rawSend();
    const finalTs = ts || args.ts || "";
    await markSent(args.meta.key, finalTs, new Date().toISOString());
    return finalTs;
  } catch (err) {
    await markFailed(args.meta.key, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/sendTracked.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor `lib/slack.ts` to delegate to `sendTracked`**

Add imports near the top of `lib/slack.ts` (after the existing imports):

```ts
import { sendTracked, type SendMeta } from "./sendTracked";

export type { SendMeta };
```

Replace the body of `postMessage` (lines 323-344) so the raw fetch becomes a private helper and the public function delegates:

```ts
async function rawPost(channelId: string, text: string, threadTs?: string): Promise<string> {
  const res = await fetch(`${API}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    cache: "no-store",
    body: JSON.stringify({ channel: channelId, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  });
  if (!res.ok) {
    throw new SlackError(`Slack chat.postMessage returned ${res.status} ${res.statusText}`, res.status);
  }
  const body = (await res.json()) as SlackOk & { ts?: string };
  if (!body.ok) {
    throw new SlackError(
      `Slack chat.postMessage error: ${body.error ?? "unknown"} (is the chat:write scope granted and the bot in the channel?)`,
      502,
    );
  }
  return body.ts ?? "";
}

/**
 * Post a message to a channel. SERVER-ONLY; needs the `chat:write` scope. Every
 * send is recorded + deduped via sendTracked (reserve-then-send). `meta.key`
 * identifies the logical action; a repeat call with the same key is skipped and
 * returns the original ts. Returns the posted ts.
 */
export async function postMessage(
  channelId: string,
  text: string,
  meta: SendMeta,
  threadTs?: string,
): Promise<string> {
  return sendTracked(
    {
      channelId,
      text,
      kind: threadTs ? "reply" : "post",
      threadTs: threadTs ?? null,
      ts: null,
      meta,
    },
    () => rawPost(channelId, text, threadTs),
  );
}
```

Replace the body of `updateMessage` (lines 351-368) likewise:

```ts
async function rawUpdate(channelId: string, ts: string, text: string): Promise<void> {
  const res = await fetch(`${API}/chat.update`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    cache: "no-store",
    body: JSON.stringify({ channel: channelId, ts, text }),
  });
  if (!res.ok) {
    throw new SlackError(`Slack chat.update returned ${res.status} ${res.statusText}`, res.status);
  }
  const body = (await res.json()) as SlackOk;
  if (!body.ok) {
    throw new SlackError(`Slack chat.update error: ${body.error ?? "unknown"}`, 502);
  }
}

/**
 * Edit one of the bot's own messages. SERVER-ONLY; needs `chat:write`. Recorded +
 * deduped via sendTracked (kind "edit"); the row's ts is the edited message's ts.
 */
export async function updateMessage(
  channelId: string,
  ts: string,
  text: string,
  meta: SendMeta,
): Promise<void> {
  await sendTracked(
    { channelId, text, kind: "edit", threadTs: null, ts, meta },
    async () => {
      await rawUpdate(channelId, ts, text);
      return ts;
    },
  );
}
```

- [ ] **Step 6: Update `scripts/field-publish.ts`**

Add to imports: `import { verdictKey } from "../lib/outboundKeys";`
Replace line 94 (`const ts = await postMessage(channel.id, item.text);`) with:

```ts
    const ts = await postMessage(channel.id, item.text, {
      key: verdictKey(periodKey(period), item.date),
      feature: "verdict",
      channel: channel.name,
      trigger: "cli",
    });
```

(`periodKey` is already imported from `../lib/reports` at line 23.)

- [ ] **Step 7: Update `scripts/field-ask.ts`**

Add to imports: `import { askKey } from "../lib/outboundKeys";`
Replace line 85 (`const ts = await postMessage(channel.id, item.gap.question);`) with:

```ts
    const ts = await postMessage(channel.id, item.gap.question, {
      key: askKey(item.gap.gapType, item.gap.date),
      feature: "ask",
      channel: channel.name,
      trigger: "cli",
    });
```

- [ ] **Step 8: Update `lib/applyApproval.ts`**

Add to imports:

```ts
import { approvalAckKey, approvalEditKey, contentRev, type SendTrigger } from "./outboundKeys";
```

Add `trigger?: SendTrigger;` to both `ApproverDecisionArgs` and `ApproverReplyArgs` interfaces.

In `applyApproverDecision`, destructure `trigger` (default `"unknown"`):

```ts
  const { entry, period, decision, by, reason, evidence, trigger = "unknown" } = args;
```

Replace the two send calls (lines 65-66):

```ts
  const editRev = contentRev(updatedText);
  await updateMessage(channel.id, entry.ts, updatedText, {
    key: approvalEditKey(entry.date, editRev),
    feature: "approval",
    channel: channel.name,
    trigger,
  });
  await postMessage(
    channel.id,
    replyText,
    {
      key: approvalAckKey(entry.date, contentRev(replyText)),
      feature: "approval",
      channel: channel.name,
      trigger,
    },
    entry.ts,
  );
```

In `applyApproverReply`, forward the trigger into the `applyApproverDecision` call (add `trigger: args.trigger,` to the object passed at line 99-106).

- [ ] **Step 9: Update `scripts/field-approvals.ts`**

In the `applyApproverDecision({ … })` call at line 97, add `trigger: "cli",` to the args object.

- [ ] **Step 10: Update `app/api/slack/events/route.ts`**

Add to imports:

```ts
import { contentRev, webhookFailureKey } from "@/lib/outboundKeys";
```

Change `failVisibly` to take the channel object and pass `meta`:

```ts
async function failVisibly(
  channel: { id: string; name: string },
  threadTs: string,
  kind: string,
  date: string,
  err: unknown,
): Promise<Response> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`slack events: ${kind} apply failed for ${date}:`, err);
  try {
    await postMessage(
      channel.id,
      formatWebhookFailureNotice(message),
      {
        key: webhookFailureKey(date, kind, contentRev(message)),
        feature: "webhook-failure",
        channel: channel.name,
        trigger: "webhook",
      },
      threadTs,
    );
  } catch (postErr) {
    console.error("slack events: failed to post failure notice:", postErr);
  }
  return ack({ handled: kind, date, error: message });
}
```

Update its two call sites (lines 163 and 175) from `failVisibly(channel.id, …)` to `failVisibly(channel, …)`.

Add `trigger: "webhook",` to the `applyApproverReply({ … })` call (line 151-158).

- [ ] **Step 10b: Update `scripts/field-bonus.ts` (the `--notify` block)**

The notifier dynamically imports `postMessage` (line 18). Add `bonusThreadKey`, `bonusDmKey` to the dynamic imports inside the `if (args.notify)` block, alongside the existing ones:

```ts
    const { bonusThreadKey, bonusDmKey } = await import("../lib/outboundKeys");
```

Replace the thread-breakdown send (line 51):

```ts
        const ts = await postMessage(channel.id, text, {
          key: bonusThreadKey(item.date),
          feature: "bonus",
          channel: channel.name,
          trigger: "cli",
        }, rootTs);
```

Replace the per-person DM send (line 59):

```ts
        const ts = await postMessage(dm, formatDm(item.date, t.amount), {
          key: bonusDmKey(item.date, t.slackId),
          feature: "bonus",
          channel: `dm:${t.slackId}`,
          trigger: "cli",
        });
```

(`t.slackId` is non-null here — line 57 `continue`s when it is null. The DM has no tracked channel name, so the audit row labels it `dm:<slackId>`.)

- [ ] **Step 11: Run the full suite + type-check + lint**

Run: `npx tsc --noEmit && npx vitest run && npm run lint`
Expected: PASS. (All `postMessage`/`updateMessage` call sites now supply `meta`; no type errors.)

- [ ] **Step 12: Commit**

```bash
git add lib/sendTracked.ts lib/sendTracked.test.ts lib/slack.ts scripts/field-publish.ts scripts/field-ask.ts lib/applyApproval.ts scripts/field-approvals.ts app/api/slack/events/route.ts scripts/field-bonus.ts
git commit -m "feat(outbound): record + dedup every Slack send via sendTracked

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: CLI — `npm run sent`

**Files:**
- Create: `lib/sentLog.ts`
- Test: `lib/sentLog.test.ts`
- Create: `scripts/sentReport.ts`
- Test: `scripts/sentReport.test.ts`
- Create: `scripts/sent.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `OutboundRow` (type-only) from `../lib/outbound`; `readOutbound` from `../lib/outbound`; `FIELD_TIMEZONE` from `../lib/reconcile`.
- Produces:
  - `lib/sentLog.ts`: `interface SentRow { key; sentAt: string | null; reservedAt; feature; kind; channel; status; origin; trigger; text; ts: string | null; threadTs: string | null }`; `interface SentSummary { total: number; byStatus: Record<string, number>; byFeature: Record<string, number> }`; `toSentView(rows): SentRow[]`; `summarizeSent(rows: SentRow[]): SentSummary`.
  - `scripts/sentReport.ts`: `interface Period { start; end }`; `interface Args { start?; end?; format: "json" | "table" }`; `parseArgs(argv): Args`; `resolvePeriod(args, today): Period`; `formatTable(rows: SentRow[], summary: SentSummary, period: Period): string`.

- [ ] **Step 1: Write the failing test for `lib/sentLog.ts`**

Create `lib/sentLog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { summarizeSent, toSentView, type SentRow } from "./sentLog";

const row = (over: Partial<SentRow> & { key: string }): SentRow => ({
  key: over.key,
  sentAt: "2026-06-10T10:00:00.000Z",
  reservedAt: "2026-06-10T10:00:00.000Z",
  feature: "verdict",
  kind: "post",
  channel: "field-qa",
  status: "sent",
  origin: "local",
  trigger: "cli",
  text: "hello",
  ts: "1.1",
  threadTs: null,
  ...over,
});

describe("toSentView", () => {
  it("sorts newest first by sentAt, falling back to reservedAt", () => {
    const rows = [
      row({ key: "a", sentAt: "2026-06-01T00:00:00.000Z" }),
      row({ key: "b", sentAt: "2026-06-20T00:00:00.000Z" }),
      row({ key: "c", sentAt: null, reservedAt: "2026-06-25T00:00:00.000Z" }),
    ];
    expect(toSentView(rows).map((r) => r.key)).toEqual(["c", "b", "a"]);
  });
});

describe("summarizeSent", () => {
  it("counts totals by status and feature", () => {
    const rows = [
      row({ key: "a", status: "sent", feature: "verdict" }),
      row({ key: "b", status: "failed", feature: "ask" }),
      row({ key: "c", status: "sent", feature: "ask" }),
    ];
    expect(summarizeSent(rows)).toEqual({
      total: 3,
      byStatus: { sent: 2, failed: 1 },
      byFeature: { verdict: 1, ask: 2 },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/sentLog.test.ts`
Expected: FAIL — module `./sentLog` not found.

- [ ] **Step 3: Implement `lib/sentLog.ts`**

```ts
/**
 * Pure shaping for the outbound-message record — the shared render source for the
 * `npm run sent` CLI and the /api/sent web tab. No DB/Next imports (OutboundRow is
 * a type-only import, erased at runtime).
 */
import type { OutboundRow } from "./outbound";

export interface SentRow {
  key: string;
  sentAt: string | null;
  reservedAt: string;
  feature: string;
  kind: string;
  channel: string;
  status: string;
  origin: string;
  trigger: string;
  text: string;
  ts: string | null;
  threadTs: string | null;
}

export interface SentSummary {
  total: number;
  byStatus: Record<string, number>;
  byFeature: Record<string, number>;
}

/** Project DB rows to the view type, newest first (sentAt, then reservedAt). */
export function toSentView(rows: OutboundRow[]): SentRow[] {
  return [...rows]
    .map((r) => ({
      key: r.key,
      sentAt: r.sentAt,
      reservedAt: r.reservedAt,
      feature: r.feature,
      kind: r.kind,
      channel: r.channel,
      status: r.status,
      origin: r.origin,
      trigger: r.trigger,
      text: r.text,
      ts: r.ts,
      threadTs: r.threadTs,
    }))
    .sort((a, b) => (b.sentAt ?? b.reservedAt).localeCompare(a.sentAt ?? a.reservedAt));
}

export function summarizeSent(rows: SentRow[]): SentSummary {
  const byStatus: Record<string, number> = {};
  const byFeature: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    byFeature[r.feature] = (byFeature[r.feature] ?? 0) + 1;
  }
  return { total: rows.length, byStatus, byFeature };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/sentLog.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `scripts/sentReport.ts`**

Create `scripts/sentReport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseArgs, resolvePeriod } from "./sentReport";

describe("parseArgs", () => {
  it("defaults to json format and reads flags", () => {
    expect(parseArgs([]).format).toBe("json");
    expect(parseArgs(["--format", "table"]).format).toBe("table");
    const a = parseArgs(["--start", "2026-06-01", "--end", "2026-06-20"]);
    expect(a.start).toBe("2026-06-01");
    expect(a.end).toBe("2026-06-20");
  });
});

describe("resolvePeriod", () => {
  it("defaults to the current month start through today", () => {
    expect(resolvePeriod(parseArgs([]), "2026-06-20")).toEqual({
      start: "2026-06-01",
      end: "2026-06-20",
    });
  });
  it("honors explicit bounds", () => {
    expect(resolvePeriod(parseArgs(["--start", "2026-05-01", "--end", "2026-05-31"]), "2026-06-20")).toEqual(
      { start: "2026-05-01", end: "2026-05-31" },
    );
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run scripts/sentReport.test.ts`
Expected: FAIL — module `./sentReport` not found.

- [ ] **Step 7: Implement `scripts/sentReport.ts`**

```ts
/**
 * Pure CLI helpers for `npm run sent`: arg parsing, period defaulting, and the
 * human table view. Keeps scripts/sent.ts a thin IO shell (same pattern as the
 * other *Report.ts files).
 */
import type { SentRow, SentSummary } from "../lib/sentLog";

export interface Period {
  start: string;
  end: string;
}

export interface Args {
  start?: string;
  end?: string;
  format: "json" | "table";
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { format: "json" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--start") args.start = argv[++i];
    else if (a === "--end") args.end = argv[++i];
    else if (a === "--format") args.format = argv[++i] === "table" ? "table" : "json";
  }
  return args;
}

export function resolvePeriod(args: Args, today: string): Period {
  return {
    start: args.start ?? `${today.slice(0, 7)}-01`,
    end: args.end ?? today,
  };
}

export function formatTable(rows: SentRow[], summary: SentSummary, period: Period): string {
  const lines: string[] = [];
  lines.push(`Outbound messages  ${period.start} → ${period.end}  (${summary.total})`);
  const byStatus = Object.entries(summary.byStatus)
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");
  if (byStatus) lines.push(`  ${byStatus}`);
  lines.push("");
  for (const r of rows) {
    const when = (r.sentAt ?? r.reservedAt).replace("T", " ").slice(0, 19);
    const text = r.text.replace(/\s+/g, " ").slice(0, 60);
    lines.push(
      `${when}  ${r.status.padEnd(7)} ${r.feature.padEnd(15)} ${r.origin.padEnd(7)} #${r.channel.padEnd(22)} ${text}`,
    );
  }
  return lines.join("\n");
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run scripts/sentReport.test.ts`
Expected: PASS.

- [ ] **Step 9: Implement `scripts/sent.ts`**

```ts
/**
 * CLI: print the durable record of every Slack message the bot posted/edited in
 * a period (audit log). Read-only — the outbound_messages table is the canonical
 * store. Defaults to the current Europe/Kyiv month.
 *
 * Usage:
 *   npm run sent -- --start 2026-06-01 --end 2026-06-28
 *   npm run sent -- --format table
 *
 * Runs under `--conditions=react-server` so the server-only import chain resolves.
 */
import { readOutbound } from "../lib/outbound";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { summarizeSent, toSentView } from "../lib/sentLog";
import { formatTable, parseArgs, resolvePeriod, type Period } from "./sentReport";

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    /* rely on ambient env */
  }

  const args = parseArgs(process.argv.slice(2));
  const period: Period = resolvePeriod(args, todayInFieldTz());

  const rows = toSentView(await readOutbound(period));
  const summary = summarizeSent(rows);

  if (args.format === "table") {
    console.log(formatTable(rows, summary, period));
  } else {
    console.log(JSON.stringify({ period, count: rows.length, summary, messages: rows }, null, 2));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sent: ${message}\n`);
  process.exit(1);
});
```

- [ ] **Step 10: Add the npm scripts**

In `package.json` `scripts`, after the `field-approvals` line, add:

```json
    "sent": "node --conditions=react-server --import tsx scripts/sent.ts",
    "backfill-outbound": "node --conditions=react-server --import tsx scripts/backfill-outbound.ts",
```

(The `backfill-outbound` script file is created in Task 7; adding both keys here keeps `package.json` edited once.)

- [ ] **Step 11: Verify the suite + type-check**

Run: `npx tsc --noEmit && npx vitest run lib/sentLog.test.ts scripts/sentReport.test.ts`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add lib/sentLog.ts lib/sentLog.test.ts scripts/sentReport.ts scripts/sentReport.test.ts scripts/sent.ts package.json
git commit -m "feat(outbound): npm run sent CLI + shared shaping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Web — Outbound tab

**Files:**
- Create: `app/api/sent/route.ts`
- Create: `app/(dashboard)/sent/page.tsx`
- Modify: `app/(dashboard)/layout.tsx` (nav)

**Interfaces:**
- Consumes: `parsePeriodKey` from `@/lib/period`; `readOutbound`, `readOutboundPeriods` from `@/lib/outbound`; `toSentView`, `summarizeSent` from `@/lib/sentLog`.
- Produces: `GET /api/sent?periods=1` → `{ periods: string[] }`; `GET /api/sent?period=<key>` → `{ period, count, summary, messages: SentRow[] }` (400 on bad/missing key).

- [ ] **Step 1: Implement `app/api/sent/route.ts`**

```ts
import { NextResponse } from "next/server";
import { readOutbound, readOutboundPeriods } from "@/lib/outbound";
import { parsePeriodKey } from "@/lib/period";
import { summarizeSent, toSentView } from "@/lib/sentLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sent — read-only audit log of the bot's outbound Slack messages.
 *   ?periods=1    → { periods } the months (UTC, newest first) that have rows
 *   ?period=<key> → { period, count, summary, messages } for that period
 *
 * Backed directly by the canonical outbound_messages table (no committed
 * snapshot — unlike the external-source features, this data already lives in our
 * own DB).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("periods")) {
    return NextResponse.json({ periods: await readOutboundPeriods() });
  }

  const period = searchParams.get("period");
  if (!period) {
    return NextResponse.json({ error: "Provide `period` or `periods`." }, { status: 400 });
  }
  const parsed = parsePeriodKey(period);
  if (!parsed) {
    return NextResponse.json(
      { error: "`period` must be YYYY-MM or YYYY-MM-DD_YYYY-MM-DD." },
      { status: 400 },
    );
  }

  const rows = toSentView(await readOutbound(parsed));
  return NextResponse.json({
    period: parsed,
    count: rows.length,
    summary: summarizeSent(rows),
    messages: rows,
  });
}
```

- [ ] **Step 2: Implement `app/(dashboard)/sent/page.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";

interface SentRow {
  key: string;
  sentAt: string | null;
  reservedAt: string;
  feature: string;
  kind: string;
  channel: string;
  status: string;
  origin: string;
  trigger: string;
  text: string;
  ts: string | null;
  threadTs: string | null;
}

interface SentReport {
  period: { start: string; end: string };
  count: number;
  summary: { total: number; byStatus: Record<string, number>; byFeature: Record<string, number> };
  messages: SentRow[];
}

const STATUS_CLS: Record<string, string> = {
  sent: "bg-emerald-100 text-emerald-800",
  pending: "bg-slate-100 text-slate-700",
  failed: "bg-red-100 text-red-800",
  skipped: "bg-amber-100 text-amber-800",
};

export default function SentPage() {
  const [periods, setPeriods] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [report, setReport] = useState<SentReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (key: string) => {
    setError(null);
    setReport(null);
    try {
      const res = await fetch(`/api/sent?period=${encodeURIComponent(key)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setReport(body as SentReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the outbound log.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/sent?periods=1");
        const body = await res.json();
        if (cancelled) return;
        const list: string[] = Array.isArray(body.periods) ? body.periods : [];
        setPeriods(list);
        if (list.length > 0) {
          setSelected(list[0]);
          void load(list[0]);
        }
      } catch {
        if (!cancelled) setError("Failed to list periods.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Outbound messages</h1>
        {periods.length > 0 && (
          <select
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              void load(e.target.value);
            }}
          >
            {periods.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      {!error && periods.length === 0 && (
        <p className="text-sm text-slate-500">No outbound messages recorded yet.</p>
      )}

      {report && (
        <>
          <p className="text-sm text-slate-600">
            {report.count} message(s) ·{" "}
            {Object.entries(report.summary.byStatus)
              .map(([k, v]) => `${k}: ${v}`)
              .join(" · ")}
          </p>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Feature</th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Origin</th>
                  <th className="px-3 py-2">Channel</th>
                  <th className="px-3 py-2">Text</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.messages.map((m) => (
                  <tr key={m.key}>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                      {(m.sentAt ?? m.reservedAt).replace("T", " ").slice(0, 19)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${
                          STATUS_CLS[m.status] ?? "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {m.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-700">{m.feature}</td>
                    <td className="px-3 py-2 text-slate-500">{m.kind}</td>
                    <td className="px-3 py-2 text-slate-500">
                      {m.origin}/{m.trigger}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-700">#{m.channel}</td>
                    <td className="px-3 py-2 text-slate-700">{m.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add the nav entry**

In `app/(dashboard)/layout.tsx`, add to the `TABS` array (after the Drive Sync entry):

```ts
  { href: "/sent", label: "Outbound", enabled: true },
```

- [ ] **Step 4: Verify build + lint**

Run: `npm run lint && npm run build`
Expected: PASS — the `/sent` route and page compile; no lint errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/sent/route.ts "app/(dashboard)/sent/page.tsx" "app/(dashboard)/layout.tsx"
git commit -m "feat(outbound): read-only Outbound web tab + /api/sent

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Backfill from `published` / `asks`

**Files:**
- Create: `scripts/backfill-outbound.ts`
- (the `backfill-outbound` npm script was added in Task 5 Step 10)

**Interfaces:**
- Consumes: `db`, `schema` from `../lib/db`; `TRACKED_CHANNELS` from `../lib/slackChannels`; `verdictKey`, `askKey` from `../lib/outboundKeys`.
- Produces: a one-time, idempotent seed of `outbound_messages` rows for every existing published verdict and asked question.

- [ ] **Step 1: Implement `scripts/backfill-outbound.ts`**

```ts
/**
 * One-time backfill: seed outbound_messages from the already-sent rows in the
 * published + asks tables, so the audit log reflects history sent before this
 * feature existed. Idempotent (ON CONFLICT DO NOTHING) — safe to re-run. Approval
 * edits/acks and webhook failure notices are not reconstructable and are skipped;
 * the log is complete from the first new send onward.
 *
 * Usage: npm run backfill-outbound
 * Runs under `--conditions=react-server` so the import chain resolves.
 */
import { db, schema } from "../lib/db";
import { askKey, verdictKey } from "../lib/outboundKeys";
import { TRACKED_CHANNELS } from "../lib/slackChannels";

function channelId(name: string): string {
  return TRACKED_CHANNELS.find((c) => c.name === name)?.id ?? "";
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    /* rely on ambient env */
  }

  const pub = await db.select().from(schema.published);
  for (const r of pub) {
    await db
      .insert(schema.outboundMessages)
      .values({
        key: verdictKey(r.period, r.date),
        feature: "verdict",
        kind: "post",
        channel: r.channel,
        channelId: channelId(r.channel),
        text: r.text,
        threadTs: null,
        ts: r.ts,
        status: "sent",
        origin: "unknown",
        trigger: "unknown",
        error: null,
        attempts: 1,
        reservedAt: r.postedAt,
        sentAt: r.postedAt,
      })
      .onConflictDoNothing();
  }

  const asks = await db.select().from(schema.asks);
  let asksSeeded = 0;
  for (const a of asks) {
    if (!a.askedTs) continue;
    asksSeeded += 1;
    await db
      .insert(schema.outboundMessages)
      .values({
        key: askKey(a.gapType, a.date),
        feature: "ask",
        kind: "post",
        channel: a.channel,
        channelId: channelId(a.channel),
        text: a.question,
        threadTs: null,
        ts: a.askedTs,
        status: "sent",
        origin: "unknown",
        trigger: "unknown",
        error: null,
        attempts: 1,
        reservedAt: a.askedAt,
        sentAt: a.askedAt,
      })
      .onConflictDoNothing();
  }

  process.stderr.write(
    `backfill-outbound: seeded ${pub.length} verdict(s) and ${asksSeeded} ask(s).\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`backfill-outbound: ${message}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS. (Running the script itself needs `POSTGRES_URL`; it is an ops step — run `npm run backfill-outbound` once against the live DB after the migration is applied.)

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-outbound.ts
git commit -m "feat(outbound): one-time backfill from published/asks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Documentation — CLAUDE.md command entry

**Files:**
- Modify: `CLAUDE.md` (Commands section)

- [ ] **Step 1: Add the `sent` command to the Commands list**

In `CLAUDE.md`, under `## Commands`, add a bullet near the other `field-*` commands:

```markdown
- `npm run sent -- --start YYYY-MM-DD --end YYYY-MM-DD [--format table]` — print the durable record of every Slack message the bot posted/edited in the window (the `outbound_messages` table: text, channel, feature, kind, status, origin/trigger, ts). Read-only audit log; defaults to the current Kyiv month. Backs the **Outbound** web tab. Every send (from any execution point — Vercel webhook, cron, local CLI) is recorded + deduped at the `lib/slack.ts` chokepoint via reserve-then-send. One-time seed of pre-existing history: `npm run backfill-outbound`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document npm run sent + outbound-message record

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Chokepoint instrumentation → Task 4 (sendTracked + slack.ts + all send sites: field-publish, field-ask, applyApproval, events webhook, field-bonus thread+DM). `openDm` intentionally untracked (no message text). ✓
- `outbound_messages` data model → Task 1. ✓
- Idempotency key conventions (`<rev>` content hash) → Task 2 (`contentRev`, key builders) + applied in Task 4. ✓
- Reserve-then-send (INSERT ON CONFLICT, retry-on-failed) → Task 2 (`decideReserve`) + Task 3 (`reserveSend`) + Task 4 (`sendTracked`). ✓
- `origin` (vercel/local) + `trigger` (cli/cron/webhook/unknown) → Task 2 (`detectOrigin`) + Task 4 (callers pass `trigger`). ✓
- Additive to published/asks → confirmed: those tables/calls are untouched except adding `meta` to their post calls. ✓
- Shared pure shaping `lib/sentLog.ts` → Task 5, consumed by CLI (Task 5) + web (Task 6). ✓
- CLI `npm run sent` → Task 5. ✓
- Web Outbound tab + `/api/sent` (read directly, no snapshot) → Task 6. ✓
- Backfill from published/asks → Task 7. ✓
- Two-interface + docs → Task 8. ✓

**Placeholder scan:** No TODO/TBD; every code step shows complete code. ✓

**Type consistency:** `SendMeta` defined in `lib/sendTracked.ts`, re-exported from `lib/slack.ts`, consumed by callers. `SentRow`/`SentSummary` defined in `lib/sentLog.ts`, imported by `scripts/sentReport.ts` and re-declared structurally in the client page (client components can't import server-touching modules' values, but the shape matches the API response). `decideReserve` signature identical across Task 2 (def) and Task 3 (use). `trigger` is `SendTrigger` everywhere. ✓
