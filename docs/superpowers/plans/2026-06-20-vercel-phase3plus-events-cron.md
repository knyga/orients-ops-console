# Vercel Phase 3+ — Slack events, cron, deploy (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Checkbox (`- [ ]`) steps.

**Context:** Phases 1–2 are done (branch `vercel-postgres`, merged to `main`): the app is Postgres-backed (Neon), all adapters async, web reads the `reports` table, `db:import` backfilled history. What remains is the **runtime that makes the bot event-based on Vercel**.

**Spec:** `docs/superpowers/specs/2026-06-20-vercel-postgres-migration-design.md`.

**Goal of this plan:** Phase 3 (Slack Events webhook → automatic approver/answer handling), Phase 4 (Vercel Cron for sync + verdict recompute), and the deploy runbook.

**Key constraint recap:** Vercel = short-lived serverless functions + no persistent FS. Event-based ⇒ a Slack **Events API** webhook; periodic ⇒ **Vercel Cron**. State is already in Postgres, so both just call the existing async adapters + pure logic.

---

## Phase 3 — `/api/slack/events` (the automatic reaction)

### Design

Slack POSTs every subscribed event to one route. The handler must: verify the request, ack within 3s, and (for a thread reply in a tracked channel) run the existing S6/S7 flow — but triggered by the event instead of the `field-approvals`/`field-remember` CLIs.

**Reuse, don't duplicate:** today the approve/answer *effect* (classify → resolution → `chat.update` + thread ack / ask-state) lives inside the CLI `main()`s. Extract the per-reply effect into shared lib functions so the events route and the CLIs call the same code:

- `lib/applyApproval.ts` → `applyApproverReply({ entry, replyText, approverName, replyPermalink, replyTs }): Promise<void>` — the S7 body (classifyApproval → upsertResolution(accepted_exception|rejected) → updateMessage strike+amend + threaded ack → mark `published.override`). Pure-ish wrapper around the existing pieces.
- `lib/applyAnswer.ts` → `applyAnswerReply({ record, replies }): Promise<void>` — the S6 body (classifyAnswer → resolution/ask-state).
- Refactor `scripts/field-approvals.ts` / `scripts/field-remember.ts` to call these (no behavior change; keeps one source of truth).

**Thread → record lookup.** The event carries `channel` + `thread_ts` (the bot's verdict/question message ts). Add DB lookups keyed by ts (not period):
- `lib/published.ts` → `findPublishedByTs(ts): Promise<{period, entry} | null>` (`SELECT * FROM published WHERE ts = $1 LIMIT 1`).
- `lib/asks.ts` → `findAskByTs(askedTs): Promise<{period, record} | null>`.

### Tasks

- [x] **T1 — signature verification (pure, tested).** `lib/slackSignature.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
/** Verify Slack's v0 request signature. `now`/`maxSkewSec` injected for tests. */
export function verifySlackSignature(args: {
  signingSecret: string; signature: string | null; timestamp: string | null;
  rawBody: string; nowSec: number; maxSkewSec?: number;
}): boolean {
  const { signingSecret, signature, timestamp, rawBody, nowSec, maxSkewSec = 300 } = args;
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > maxSkewSec) return false; // replay guard
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
```
Unit-test: good signature passes; bad signature, stale timestamp, missing headers fail.

- [x] **T2 — by-ts lookups.** Add `findPublishedByTs` / `findAskByTs` (above) + a tiny live-smoke. (IO, not unit-tested per D2.)

- [x] **T3 — extract shared effect fns** (`lib/applyApproval.ts`, `lib/applyAnswer.ts`) from the two CLIs; repoint the CLIs to them. `npm test` stays green; live re-smoke an approval via CLI to confirm no regression. *(Done: the effect is `applyApproverDecision`/`applyAnswerDecision` (shared by CLI + route); the single-reply webhook path is `applyApproverReply`/`applyAnswerReply`. CLIs run clean in dry-run; 238 tests green.)*

- [x] **T4 — the route** `app/api/slack/events/route.ts` (`runtime="nodejs"`, `dynamic="force-dynamic"`):

```ts
export async function POST(req: Request) {
  const raw = await req.text();                       // raw body needed for the signature
  const ok = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    signature: req.headers.get("x-slack-signature"),
    timestamp: req.headers.get("x-slack-request-timestamp"),
    rawBody: raw, nowSec: Math.floor(Date.now() / 1000),
  });
  if (!ok) return new Response("bad signature", { status: 401 });

  const body = JSON.parse(raw);
  if (body.type === "url_verification") return Response.json({ challenge: body.challenge });
  if (body.type !== "event_callback") return new Response("ok");

  const e = body.event;
  // Only thread replies, in a tracked channel, not the bot itself, no edit/delete subtype.
  if (e?.type === "message" && e.thread_ts && e.thread_ts !== e.ts && !e.subtype && e.user) {
    const channel = TRACKED_CHANNELS.find((c) => c.id === e.channel);
    if (channel) {
      const pub = await findPublishedByTs(e.thread_ts);
      if (pub && isApprover(e.user)) {
        const approver = approverFor(e.user)!;
        await applyApproverReply({ entry: pub.entry, period: pub.period, replyText: e.text ?? "",
          approverName: approver.name, replyPermalink: permalinkFor(channel.id, e.ts), replyTs: e.ts });
      } else {
        const ask = await findAskByTs(e.thread_ts);
        if (ask) await applyAnswerReply({ record: ask.record, period: ask.period, replyText: e.text ?? "", replyPermalink: permalinkFor(channel.id, e.ts) });
      }
    }
  }
  return new Response("ok"); // ack fast; work above is one Claude call (~1–2s, within Slack's 3s)
}
```
Notes: idempotent (the `override`/ask-state guards make Slack re-delivery a no-op). If the inline Claude call ever risks the 3s window, defer it (write a "pending reply" row; the verdict cron finalizes) — start inline.

- [x] **T5 — env + verify.** Add `SLACK_SIGNING_SECRET` to `.env.example` + Vercel. `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`. Local smoke: POST a crafted `url_verification` body with a valid signature → returns the challenge; an `event_callback` reply → applies (against a test thread). *(Done: tsc/lint/build clean, 238 tests; smoke confirmed valid sig → challenge, bad sig → 401, stale ts → 401, event_callback → 200 ok via live Neon lookup. `SLACK_SIGNING_SECRET` still to be added to Vercel env at deploy.)*

### Slack app config (you, after first deploy)
- Basic Information → copy **Signing Secret** → `SLACK_SIGNING_SECRET` in Vercel.
- Event Subscriptions → enable → Request URL `https://<deploy>/api/slack/events` (Slack verifies via the challenge) → subscribe to bot events **`message.channels`** + **`message.groups`** → save → reinstall.

---

## Phase 4 — Vercel Cron

Cron hits protected GET routes. Vercel injects `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is set; the route checks it.

- [ ] **T6 — extract the sync + verdict orchestration** into callable lib functions (so a route and the CLI share them): `lib/syncChannels.ts` → `syncAllChannels({ mode, windowDays })` (the `scripts/slack-sync.ts` per-channel loop), and `lib/computeVerdicts.ts` → `computeAndWriteVerdicts(period)` (the `scripts/field-verdict.ts` body). Repoint the CLIs to call them.

- [ ] **T7 — cron routes** (`runtime="nodejs"`, guard helper):

```ts
function authorized(req: Request) {
  return req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
}
// app/api/cron/sync/route.ts
export async function GET(req: Request) {
  if (!authorized(req)) return new Response("unauthorized", { status: 401 });
  await syncAllChannels({ mode: "incremental", windowDays: 7 });
  return new Response("ok");
}
// app/api/cron/verdict/route.ts — recompute current Kyiv month → reports; optional auto-publish (flag-gated, default off)
```

- [ ] **T8 — `vercel.json`:**

```json
{
  "crons": [
    { "path": "/api/cron/sync", "schedule": "*/15 * * * *" },
    { "path": "/api/cron/verdict", "schedule": "0 6 * * *" }
  ]
}
```
(Note: Vercel **Hobby** allows daily crons only; sub-hourly `sync` needs **Pro**. If on Hobby, set both to daily for now.) Add `CRON_SECRET` to Vercel env.

- [ ] **T9 — verify.** tsc/lint/test/build. Locally `curl` each cron route with `Authorization: Bearer $CRON_SECRET` → 200 + state changes in Neon; without it → 401.

---

## Phase 6 — Deploy

- [ ] Push `main`; Vercel auto-builds. Confirm env vars present (POSTGRES_*, SLACK_TOKEN, SLACK_SIGNING_SECRET, ANTHROPIC_API_KEY, VIMEO_TOKEN, JIRA_*, GH_ACCESS_TOKEN, CRON_SECRET).
- [ ] Build runs `db:migrate`? No — keep migrations manual (`npm run db:migrate` against Neon from local/CI) to avoid surprising schema changes on deploy. Document running it before deploying a schema change.
- [ ] Open the deployed URL → verify the dashboard reads Neon (the imported reports show).
- [ ] Wire Slack Event Subscriptions (Phase 3 config) → post a test verdict (`field-publish` to `#orients-ops-console-test`) → reply as an approver → confirm the bot reacts **with no CLI run** (the webhook did it).
- [ ] Watch the first cron fires (Vercel dashboard → Cron logs).

---

## Cross-cutting

- **Idempotency everywhere** is the safety net for Slack's at-least-once delivery: override markers (`published.override`), ask states, and verdict re-runs are all no-ops on repeat.
- **Outward-posting stays guarded:** auto-publish in cron is flag-gated (`PUBLISH_ENABLED`, default off) and targets a configured channel; `#orients-ops-console-test` first.
- **Secrets** only in Vercel env / local `.env`; never the browser.
- **3s ack:** if Slack starts retrying (duplicate reactions appearing), switch the events route to defer classification to the verdict cron.
- **No new client bundle risk:** the events/cron routes are server-only API routes; `lib/db` stays out of `"use client"` files.

## Open decisions
1. Cron cadence + Hobby vs Pro (sub-hourly sync needs Pro).
2. Auto-publish from cron: keep OFF until dry-runs trusted (recommended).
3. Inline vs deferred classification in the events route (start inline).
