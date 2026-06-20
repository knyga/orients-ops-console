# Vercel + Postgres migration (event-based bot) — Design

**Date:** 2026-06-20
**Status:** Proposed (pending review)
**Supersedes the storage assumptions of:** S1 (Slack mirror), S3 (verdict + resolutions), S4–S7 (published/asks/approvals). The pure logic of all of these is **unchanged**; only the storage backend and the runtime triggers change.

## Why

The console must deploy to **Vercel** (UI + bot) and react to approver/answer replies **automatically, event-based**. Vercel imposes two hard constraints the current design violates:

1. **No always-on processes.** Serverless functions are short-lived, so Socket Mode / polling daemons can't run. Event-based on Vercel = a **Slack Events API webhook**; periodic work = **Vercel Cron**.
2. **No persistent filesystem.** The runtime FS is ephemeral/read-only, so every `--write` (the `data/slack/` mirror, `reports/resolutions/store.json`, the published/asks logs, the `reports/*` artifacts) is lost. Committed `reports/*.json` ship read-only with the deploy, but **live agent state cannot live on the FS**.

**Decision (user, 2026-06-20):** move all mutable agent state to **Postgres** (Vercel Postgres / Neon). This is feasible because every storage module is already isolated behind read/write adapter functions, with the business logic in pure, separately-tested modules — so this is largely an **adapter swap**, not a rewrite.

## Goals / non-goals

**Goals**
- All mutable state in Postgres: the Slack mirror, sync cursors, resolutions, published log, asks log, and the report artifacts the web renders.
- An **Events API** route that reacts in real time to approver overrides (S7) and answer ingestion (S6).
- **Vercel Cron** routes for the periodic loop steps (sync, verdict recompute, optional publish/ask).
- One source of truth shared by the web, the events route, the cron jobs, **and the local CLIs** (all connect to the same `DATABASE_URL`).
- Pure logic (`mergeMessages`, `verdictForDay`, `applyResolution`, `gapsForDay`, `decideApproval`, classifiers, formatters) untouched and still unit-tested.

**Non-goals (this migration)**
- No change to the verdict/policy rules. No new features beyond the runtime/storage move.
- Not removing the CLIs — they remain (now DB-backed) for local/CI use.
- Auto-publish/auto-ask cadence stays conservative (dry-run discipline preserved; see §Cron).

## Architecture

```
Slack ──event──▶ POST /api/slack/events        (verify signing secret; 3s ack)
                      │  thread reply in a tracked channel?
                      ├─ approver (lib/approvers)  → classifyApproval → resolution(DB) → chat.update + thread ack
                      └─ reply under a bot question → classifyAnswer    → resolution/ask state(DB)
Vercel Cron ──▶ GET /api/cron/sync     (fetchRawMessages → mergeMessages → DB)
            ──▶ GET /api/cron/verdict  (recompute verdicts → DB; optional auto-publish settled days)
Web UI ───────▶ /api/<feature>?period= → reads report rows from DB
CLIs ─────────▶ same lib adapters → same Postgres (DATABASE_URL)
```

## Storage layer

### Driver + query layer

- **Driver:** `@vercel/postgres` (Neon-backed, serverless-pooled, works locally via `POSTGRES_URL`). One client, used by API routes, cron, and CLIs alike.
- **Query layer:** **Drizzle ORM** (`drizzle-orm` + `drizzle-kit`) — TypeScript-native, typed queries that fit the repo's `strict` ethos, first-class SQL migrations via `drizzle-kit generate`/`migrate`. (Alternative considered: raw parameterized SQL via `sql\`\`` — fewer deps, but loses the type-safety we lean on. Drizzle recommended; settle at review.)
- New module `lib/db.ts`: constructs the Drizzle client from `process.env.POSTGRES_URL`. NOT `server-only` (CLIs import it), but holds the connection only — same precedent as `lib/reports.ts`.

### Schema (Drizzle tables)

```
slack_messages   (channel, ts) PK
  author_id, author, iso_time (timestamptz), text, permalink,
  files jsonb, thread_ts, reply_count, edited, deleted bool,
  first_seen, last_seen
  index (channel, iso_time), index (channel, thread_ts)

slack_sync       channel PK, last_sync timestamptz

resolutions      date PK, decision, note, source, by, recorded_at
                 (all-time; keyed by flight date)

published        (period, date) PK
                 channel, text, ts, posted_at, override jsonb

asks             (period, gap_key) PK
                 gap_type, date, channel, question, state,
                 asked_ts, asked_at, note

reports          (feature, period) PK, json jsonb, csv text, updated_at
                 (the web render source — replaces committed reports/*.json)
```

### Adapter migration (the heart)

Each existing storage module keeps its **function names and semantics** but its body swaps fs → Drizzle, becoming **async**:

| Module | Today (fs, sync) | After (Postgres, async) |
|---|---|---|
| `lib/slackMirror.ts` | `readMonthFile`/`writeMonthFile`/`readChannelMessages`/`read|writeSyncCursor` | same names, `async`, query `slack_messages`/`slack_sync`. **`mergeMessages`/`upsertMessages` stay pure** and unchanged. |
| `lib/resolutions.ts` | `readResolutions`/`writeResolutions`/`upsertResolution` | async, `resolutions` table. **`applyResolution`/`resolutionFor` stay pure.** |
| `lib/published.ts` | `readPublished`/`writePublished` | async, `published` table. **`isPublished`/`recordPublished` stay pure.** |
| `lib/asks.ts` | `readAsks`/`writeAsks` | async, `asks` table. **`isAsked`/`recordAsk`/`setAskState` stay pure.** |
| `lib/reports.ts` | `writeReport`/`readReportJson`/`listPeriods` | async, `reports` table. `periodKey`/`parsePeriodKey` stay pure (already in `lib/period.ts`). |

Ripple: callers `await` these. The CLIs' `main()` is already async; the few synchronous in-loop reads (e.g. `verdictForDay` map reading resolutions) hoist to a single `await readResolutions()` before the loop (already the pattern in `scripts/field-verdict.ts`). The pure functions consume plain objects/arrays exactly as today, so they don't change.

**Injectable client for tests:** adapters take an optional `{ db }` (like today's `{ baseDir }`) so tests inject a test database. See §Testing.

### What leaves the filesystem

- `data/slack/` (mirror) → `slack_messages` + `slack_sync`. The `.gitignore` entry stays (no local mirror in prod), and the FS mirror can remain a **local-dev convenience** only if we keep a thin FS adapter behind a flag — but the **single-source-of-truth recommendation is Postgres everywhere** (drop the FS path to avoid drift; CLIs hit the same DB).
- `reports/*.json|csv` → `reports` table. Committed report files are no longer the web's source; they can be dropped or kept as periodic exports (decision below).

## Event-based reactions — `/api/slack/events`

- New route `app/api/slack/events/route.ts` (`runtime="nodejs"`, `dynamic="force-dynamic"`).
- **Security:** verify Slack's `x-slack-signature` + `x-slack-request-timestamp` against `SLACK_SIGNING_SECRET` (constant-time); reject stale (>5 min) or bad signatures. Handle the one-time `url_verification` challenge.
- **Ack fast:** Slack requires a response within 3s. The handler validates + enqueues/does minimal work, returns 200 quickly. Classification (a Claude call ~1–2s) fits within 3s for a single reply; if it risks timeout, defer the heavy step to a follow-up (e.g. write a "pending" row and let the verdict cron finalize) — keep the first cut synchronous and revisit only if Slack retries appear.
- **Filter:** only `event.type === "message"` with a `thread_ts` (a reply), in a tracked channel, not from the bot itself, not a subtype edit/delete (handle those minimally).
- **Dispatch** (reuses existing pure logic + classifiers):
  - parent is a **published verdict** (lookup `published` by `thread_ts`) AND author ∈ `APPROVERS` → `classifyApproval` → write `resolutions` row → `chat.update` (strike + amend) + threaded ack (the **exact S7 flow**, now triggered by the event instead of `field-approvals --write`).
  - parent is a **bot question** (`asks` by `asked_ts`) → `classifyAnswer` → resolution/ask-state (the **S6 flow**).
- Subscriptions (Slack app config, user does): Event Subscriptions on, request URL = `https://<deploy>/api/slack/events`, subscribe to bot events `message.channels` + `message.groups`; add `SLACK_SIGNING_SECRET` to env.
- **Idempotency:** Slack re-delivers events on non-200/slow ack. The S7/S6 override markers (in `published`/`asks`) already make re-application a no-op; also dedupe on `event_id` if needed.

## Periodic loop — Vercel Cron

`vercel.json` cron entries hitting protected GET routes (guarded by a `CRON_SECRET` header):
- `/api/cron/sync` — `fetchRawMessages` for tracked channels → `mergeMessages` → `slack_messages` (the mirror refresh; the events route covers instant replies, cron covers edits/deletes/backfill + non-event channels).
- `/api/cron/verdict` — recompute verdicts (airborne + Vimeo-by-name + dataset notice + resolutions) → `reports`. Optionally auto-publish **newly settled** days (still gated: a config flag `PUBLISH_ENABLED`, a target channel, never PENDING) — default OFF until trusted.
- Cadence TBD (e.g. sync every 15 min, verdict daily). Decided at plan time.

## Web

- API routes (`/api/<feature>`) read the `reports` table instead of committed files (`readReportJson` now hits DB). The hybrid "committed vs live refresh" UX is preserved; "committed" now means "in the `reports` table." `usePeriodReport` unchanged (still fetches the same API shape).
- The Field-Verdict tab etc. are unchanged client-side.

## Secrets / env (Vercel project env vars)

`POSTGRES_URL` (Neon), `SLACK_TOKEN`, `SLACK_SIGNING_SECRET` (new), `ANTHROPIC_API_KEY`, `VIMEO_TOKEN`, plus the existing Jira/GitHub vars, `CRON_SECRET` (new). `.env.example` updated; all already read via `process.env`.

## Testing

- **Pure logic:** unchanged, still fast unit tests (the bulk of our 247 tests stay green untouched).
- **Adapters:** today they're unit-tested against a tmpdir FS. With Postgres they become integration tests. Options (decide at plan): (a) `pglite`/`pg-mem` in-memory Postgres for fast adapter tests; (b) a disposable test schema against a real Neon branch in CI; (c) treat adapters as "network/IO, not unit-tested" (repo convention for `lib/jira`/`lib/slack`) and rely on pure-logic tests + a smoke. **Recommendation:** `pglite` (embedded Postgres in-process) so adapter round-trip tests stay in `npm test` with no external DB.
- **Events route:** unit-test the pure parts (signature verification helper, event-filter/dispatch decision) ; the Slack/Claude calls are network (untested), same as today.

## Rollout (phased — each ships independently)

1. **DB foundation:** add deps, `lib/db.ts`, Drizzle schema + first migration, `pglite` test harness.
2. **Adapter swap:** migrate `slackMirror`/`resolutions`/`published`/`asks`/`reports` to Postgres (names/semantics preserved, now async); update CLIs to `await`; keep all pure-logic tests green; adapter round-trip tests on `pglite`. Backfill: a one-off `npm run db:import` that loads any existing committed `reports/*` + local mirror into the DB.
3. **Events route:** `/api/slack/events` (signature verify + dispatch to the S6/S7 flows). This delivers the **automatic, event-based** behavior the user asked for.
4. **Cron:** `/api/cron/sync` + `/api/cron/verdict` + `vercel.json`; optional guarded auto-publish.
5. **Web cutover:** API routes read the `reports` table; drop the committed-file read path.

After phase 3 the bot reacts to approvals in real time on Vercel; phases 4–5 complete the hosted loop.

## Open decisions (confirm at review / plan)

1. **Drizzle vs raw SQL** (recommended Drizzle).
2. **Adapter test strategy** (recommended `pglite`).
3. **Keep committed `reports/*` as exports, or DB-only?** (recommended DB-only; optional periodic export job if a git audit trail is still wanted).
4. **Single source of truth = Postgres everywhere, dropping the FS mirror path?** (recommended yes, to avoid drift.)
5. **Cron cadence** + whether cron may **auto-publish** settled verdicts (default OFF / dry-run until trusted).
6. **3s ack:** inline classification vs deferred (start inline; revisit if Slack retries).
