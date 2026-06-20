# Vercel/Postgres Phase 2 — storage-adapter swap (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Move the agent's mutable state from the filesystem to Postgres (Drizzle, `lib/db.ts`/`lib/schema.ts` from Phase 1) — `slackMirror`, `resolutions`, `published`, `asks`, `reports` — keeping every function's name/semantics but making them `async`, and keeping all pure logic untouched.

**Spec:** `docs/superpowers/specs/2026-06-20-vercel-postgres-migration-design.md`

**Architecture:** Same adapter functions, now backed by Drizzle queries over `slack_messages`/`slack_sync`/`resolutions`/`published`/`asks`/`reports`. Pure helpers (`mergeMessages`, `upsertMessages`, `monthsInPeriod`, `verdictForDay`, `applyResolution`, `resolutionFor`, `isPublished`, `recordPublished`, `isAsked`, `recordAsk`, `setAskState`, all classifiers/formatters) are **unchanged**. Callers (`scripts/*.ts`, API routes) `await` the now-async reads/writes.

## Decisions (pinned)

- **D1 — mirror:** keep `mergeMessages`/`upsertMessages` pure + unchanged; the Postgres `slackMirror` does **read-month-rows → merge → bulk upsert**. Month is the read/write unit (query rows whose `iso_time` starts with `YYYY-MM`). `monthFilePath`/`syncFilePath` (FS path helpers) are **removed**; `monthsInPeriod` stays (decides which months to touch).
- **D2 — adapter tests:** adapters are treated as **IO (not unit-tested)** — drop the fs round-trip describe blocks, keep ALL pure-logic tests, and cover adapter correctness with a **live Neon smoke** (a `scripts/db-smoke.ts`, run manually). Matches the repo convention (`lib/jira`/`lib/slack`/`lib/vimeo` are network-untested). (Revisit `pglite` later if we want round-trips in CI.)
- **D3 — `db:import`:** a one-off `scripts/db-import.ts` loads existing committed `reports/*` + any local FS state into Postgres, so nothing already produced is lost.

## Row ↔ object mapping

All ISO/date fields are `text` columns holding the exact strings (Phase 1), so mapping is 1:1. Nullable columns (`by`, `files`, `thread_ts`, `reply_count`, `edited`, `deleted`, `note`, `override`, `csv`) map `null → undefined` on read; omit-or-undefined on write.

---

### Task 1: `lib/resolutions.ts` → Postgres (smallest; establishes the pattern)

**Files:** Modify `lib/resolutions.ts`, `lib/resolutions.test.ts`.

- [ ] **Step 1** — Replace the fs implementation. Keep `Resolution`/`ResolutionDecision` types and the PURE `resolutionFor`/`applyResolution` **exactly as-is**. Replace the store fns:

```ts
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import type { DayVerdict } from "./fieldDayVerdict";

// ... Resolution + ResolutionDecision types unchanged ...

function toResolution(r: typeof schema.resolutions.$inferSelect): Resolution {
  return {
    date: r.date,
    decision: r.decision as ResolutionDecision,
    note: r.note,
    source: r.source,
    recordedAt: r.recordedAt,
    ...(r.by != null ? { by: r.by } : {}),
  };
}

/** All resolutions (empty when none). */
export async function readResolutions(): Promise<Resolution[]> {
  const rows = await db.select().from(schema.resolutions);
  return rows.map(toResolution);
}

/** Insert or replace the resolution for its date. */
export async function upsertResolution(resolution: Resolution): Promise<void> {
  const values = {
    date: resolution.date,
    decision: resolution.decision,
    note: resolution.note,
    source: resolution.source,
    by: resolution.by ?? null,
    recordedAt: resolution.recordedAt,
  };
  await db
    .insert(schema.resolutions)
    .values(values)
    .onConflictDoUpdate({ target: schema.resolutions.date, set: values });
}
```

Remove `readResolutions`'s old fs body, `writeResolutions`, `ResolutionsOpts`, `defaultBaseDir`, `storePath`, and the `node:fs`/`node:path` imports. (`resolutionFor`/`applyResolution` keep working — they take arrays.) `eq` import only if used; remove if not.

- [ ] **Step 2** — Trim `lib/resolutions.test.ts`: delete the `describe("store I/O")` block (fs round-trips) and its `node:fs`/`os`/`path` + `beforeEach`/`afterEach` imports. Keep the `describe("resolutionFor / applyResolution")` block and its imports (`applyResolution`, `resolutionFor`, type `Resolution`, type `DayVerdict`). Do NOT import `readResolutions`/`writeResolutions`/`upsertResolution` there anymore.

- [ ] **Step 3** — `npx vitest run lib/resolutions.test.ts` (pure tests pass), `npx tsc --noEmit` (clean). Commit: `refactor(resolutions): back the store with Postgres`.

---

### Task 2: `lib/published.ts` → Postgres

**Files:** Modify `lib/published.ts`, `lib/published.test.ts`.

- [ ] **Step 1** — Keep `PublishedEntry`/`PublishedLog` types + PURE `isPublished`/`recordPublished` unchanged. Replace `readPublished`/`writePublished` (and drop `PublishedOpts`/`defaultBaseDir`/`logPath`/fs):

```ts
import { and, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { periodKey, type Period } from "./period";

// PublishedEntry (incl. ts + override) and PublishedLog types unchanged.

function toEntry(r: typeof schema.published.$inferSelect): PublishedEntry {
  return {
    date: r.date,
    channel: r.channel,
    text: r.text,
    ts: r.ts,
    postedAt: r.postedAt,
    ...(r.override != null ? { override: r.override as PublishedEntry["override"] } : {}),
  };
}

/** The published log for a period (empty object when absent). */
export async function readPublished(period: Period): Promise<PublishedLog> {
  const key = periodKey(period);
  const rows = await db.select().from(schema.published).where(eq(schema.published.period, key));
  const log: PublishedLog = {};
  for (const r of rows) log[r.date] = toEntry(r);
  return log;
}

/** Overwrite the period's published log (upsert every entry by (period,date)). */
export async function writePublished(period: Period, log: PublishedLog): Promise<void> {
  const key = periodKey(period);
  for (const entry of Object.values(log)) {
    const values = {
      period: key,
      date: entry.date,
      channel: entry.channel,
      text: entry.text,
      ts: entry.ts,
      postedAt: entry.postedAt,
      override: entry.override ?? null,
    };
    await db
      .insert(schema.published)
      .values(values)
      .onConflictDoUpdate({ target: [schema.published.period, schema.published.date], set: values });
  }
}
```

(`and` import only if used; drop otherwise.)

- [ ] **Step 2** — Trim `lib/published.test.ts`: delete the `describe("store I/O")` block + fs imports; keep `describe("isPublished / recordPublished (pure)")` and its imports (`isPublished`, `recordPublished`, types).

- [ ] **Step 3** — `npx vitest run lib/published.test.ts`, `npx tsc --noEmit`. Commit: `refactor(published): back the log with Postgres`.

---

### Task 3: `lib/asks.ts` → Postgres

**Files:** Modify `lib/asks.ts`, `lib/asks.test.ts`.

- [ ] **Step 1** — Keep `AskState`/`AskRecord`/`AskLog` types + PURE `isAsked`/`recordAsk`/`setAskState` unchanged. Replace `readAsks`/`writeAsks` (drop `AsksOpts`/`defaultBaseDir`/`logPath`/fs):

```ts
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { periodKey, type Period } from "./period";
import type { GapType } from "./askGaps";

function toRecord(r: typeof schema.asks.$inferSelect): AskRecord {
  return {
    gapType: r.gapType as GapType,
    date: r.date,
    channel: r.channel,
    question: r.question,
    state: r.state as AskState,
    askedTs: r.askedTs,
    askedAt: r.askedAt,
    ...(r.note != null ? { note: r.note } : {}),
  };
}

export async function readAsks(period: Period): Promise<AskLog> {
  const key = periodKey(period);
  const rows = await db.select().from(schema.asks).where(eq(schema.asks.period, key));
  const log: AskLog = {};
  for (const r of rows) log[r.gapKey] = toRecord(r);
  return log;
}

export async function writeAsks(period: Period, log: AskLog): Promise<void> {
  const key = periodKey(period);
  for (const [gapKey, rec] of Object.entries(log)) {
    const values = {
      period: key,
      gapKey,
      gapType: rec.gapType,
      date: rec.date,
      channel: rec.channel,
      question: rec.question,
      state: rec.state,
      askedTs: rec.askedTs,
      askedAt: rec.askedAt,
      note: rec.note ?? null,
    };
    await db
      .insert(schema.asks)
      .values(values)
      .onConflictDoUpdate({ target: [schema.asks.period, schema.asks.gapKey], set: values });
  }
}
```

- [ ] **Step 2** — Trim `lib/asks.test.ts`: delete `describe("store I/O")` + fs imports; keep `describe("pure log ops")`.

- [ ] **Step 3** — `npx vitest run lib/asks.test.ts`, `npx tsc --noEmit`. Commit: `refactor(asks): back the log with Postgres`.

---

### Task 4: `lib/reports.ts` → Postgres

**Files:** Modify `lib/reports.ts`, `lib/reports.test.ts`, and the API routes that call it.

- [ ] **Step 1** — Keep the re-export of `periodKey`/`parsePeriodKey`/`Period` from `./period`. Replace `writeReport`/`readReportJson`/`listPeriods` (drop `ReportOpts`/`defaultBaseDir`/`reportPath`/fs):

```ts
import { desc, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { periodKey, type Period } from "./period";
export { periodKey, parsePeriodKey, type Period } from "./period";

export async function writeReport(
  feature: string,
  period: Period,
  artifacts: { json: string; csv: string },
): Promise<{ key: string }> {
  const key = periodKey(period);
  const values = {
    feature,
    period: key,
    json: JSON.parse(artifacts.json),
    csv: artifacts.csv,
    updatedAt: new Date().toISOString(),
  };
  await db
    .insert(schema.reports)
    .values(values)
    .onConflictDoUpdate({ target: [schema.reports.feature, schema.reports.period], set: values });
  return { key };
}

export async function readReportJson<T>(feature: string, key: string): Promise<T | null> {
  const rows = await db
    .select()
    .from(schema.reports)
    .where(and(eq(schema.reports.feature, feature), eq(schema.reports.period, key)))
    .limit(1);
  return rows.length ? (rows[0].json as T) : null;
}

export async function listPeriods(feature: string): Promise<string[]> {
  const rows = await db
    .select({ period: schema.reports.period })
    .from(schema.reports)
    .where(eq(schema.reports.feature, feature))
    .orderBy(desc(schema.reports.period));
  return rows.map((r) => r.period);
}
```

(Add `and` to the import.) Note `writeReport` now stores parsed JSON in `jsonb` and no longer returns file paths — update callers' log lines (they referenced `jsonPath`/`csvPath`).

- [ ] **Step 2** — Replace `lib/reports.test.ts`: keep the `periodKey`/`parsePeriodKey` pure describe blocks (they import from `./reports` re-export — still valid). Delete the `describe("writeReport / readReportJson / listPeriods")` fs block.

- [ ] **Step 3** — Update API routes (`app/api/field-ops|field-qa|field-verdict|jira|github|policy/route.ts`) and any pages/CLIs that call `readReportJson`/`listPeriods`/`writeReport` to `await` them (the route handlers are already `async`). The shapes returned are unchanged.

- [ ] **Step 4** — `npx vitest run lib/reports.test.ts`, `npx tsc --noEmit`, `npm run build`. Commit: `refactor(reports): back artifacts with Postgres`.

---

### Task 5: `lib/slackMirror.ts` → Postgres (D1: read-merge-write)

**Files:** Modify `lib/slackMirror.ts`, `lib/slackMirror.test.ts`.

- [ ] **Step 1** — Keep `StoredMessage`/`MonthFile`/`SyncCursor` types + PURE `upsertMessages`/`mergeMessages`/`monthsInPeriod` **unchanged**. Remove `MirrorOpts`/`defaultBaseDir`/`channelDir`/`monthFilePath`/`syncFilePath`/`readJson`/`writeJsonAtomic`/fs. Replace the I/O:

```ts
import { and, eq, gte, lte, like } from "drizzle-orm";
import { db, schema } from "./db";
import type { Period } from "./period";
// StoredMessage / MonthFile / SyncCursor types + monthsInPeriod + upsertMessages + mergeMessages unchanged.

function toStored(r: typeof schema.slackMessages.$inferSelect): StoredMessage {
  return {
    ts: r.ts, channel: r.channel, authorId: r.authorId, author: r.author,
    isoTime: r.isoTime, text: r.text, permalink: r.permalink,
    firstSeen: r.firstSeen, lastSeen: r.lastSeen,
    ...(r.files != null ? { files: r.files as StoredMessage["files"] } : {}),
    ...(r.threadTs != null ? { thread_ts: r.threadTs } : {}),
    ...(r.replyCount != null ? { reply_count: r.replyCount } : {}),
    ...(r.edited != null ? { edited: r.edited } : {}),
    ...(r.deleted != null ? { deleted: r.deleted } : {}),
  };
}

/** All stored messages for a channel+month (YYYY-MM), as a MonthFile, or null. */
export async function readMonthFile(channel: string, month: string): Promise<MonthFile | null> {
  const rows = await db.select().from(schema.slackMessages)
    .where(and(eq(schema.slackMessages.channel, channel), like(schema.slackMessages.isoTime, `${month}%`)));
  if (rows.length === 0) return null;
  const messages: Record<string, StoredMessage> = {};
  for (const r of rows) messages[r.ts] = toStored(r);
  return { version: 1, channel, month, messages };
}

/** Bulk-upsert a month's messages (the merged map) by (channel, ts). */
export async function writeMonthFile(channel: string, month: string, file: MonthFile): Promise<void> {
  for (const m of Object.values(file.messages)) {
    const values = {
      channel, ts: m.ts, authorId: m.authorId, author: m.author, isoTime: m.isoTime,
      text: m.text, permalink: m.permalink, files: m.files ?? null,
      threadTs: m.thread_ts ?? null, replyCount: m.reply_count ?? null,
      edited: m.edited ?? null, deleted: m.deleted ?? false,
      firstSeen: m.firstSeen, lastSeen: m.lastSeen,
    };
    await db.insert(schema.slackMessages).values(values)
      .onConflictDoUpdate({ target: [schema.slackMessages.channel, schema.slackMessages.ts], set: values });
  }
}

/** Messages for a channel within [start,end] by day, sorted by ts. Includes tombstoned. */
export async function readChannelMessages(channel: string, period: Period): Promise<StoredMessage[]> {
  const rows = await db.select().from(schema.slackMessages)
    .where(and(
      eq(schema.slackMessages.channel, channel),
      gte(schema.slackMessages.isoTime, `${period.start}T00:00:00.000Z`),
      lte(schema.slackMessages.isoTime, `${period.end}T23:59:59.999Z`),
    ));
  return rows.map(toStored).sort((a, b) => a.ts.localeCompare(b.ts));
}

export async function readSyncCursor(channel: string): Promise<SyncCursor | null> {
  const rows = await db.select().from(schema.slackSync).where(eq(schema.slackSync.channel, channel)).limit(1);
  return rows.length ? { version: 1, lastSync: rows[0].lastSync } : null;
}

export async function writeSyncCursor(channel: string, lastSync: string): Promise<void> {
  await db.insert(schema.slackSync).values({ channel, lastSync })
    .onConflictDoUpdate({ target: schema.slackSync.channel, set: { lastSync } });
}
```

Note: `readChannelMessages` filters by full ISO bounds (date → `T00:00:00.000Z`..`T23:59:59.999Z`), equivalent to the old `day ∈ [start,end]`. The pure day-filter logic is no longer needed (SQL does it).

- [ ] **Step 2** — Trim `lib/slackMirror.test.ts`: keep the PURE blocks (`upsertMessages`, `mergeMessages`, `monthsInPeriod`). Delete the fs blocks (`path + period helpers` path-fn assertions, `month-file + cursor I/O`, `readChannelMessages` fs round-trips) and the `node:fs`/`os`/`path` + `monthFilePath`/`syncFilePath` imports. Keep `monthsInPeriod` test (pure).

- [ ] **Step 3** — `npx vitest run lib/slackMirror.test.ts`, `npx tsc --noEmit`. Commit: `refactor(slack-mirror): back the mirror with Postgres (read-merge-write)`.

---

### Task 6: Update CLI callers to `await` + drop FS bits

**Files:** `scripts/slack-sync.ts`, `scripts/field-verdict.ts`, `scripts/field-publish.ts`, `scripts/field-ask.ts`, `scripts/field-remember.ts`, `scripts/field-approvals.ts`, `scripts/fieldops.ts`, `scripts/fieldQa.ts`, and any others calling the changed adapters.

- [ ] **Step 1** — Find every call site: `grep -rn "readReportJson\|writeReport\|listPeriods\|readResolutions\|upsertResolution\|readPublished\|writePublished\|readAsks\|writeAsks\|readMonthFile\|writeMonthFile\|readChannelMessages\|read(Sync|Channel)\|writeSyncCursor\|readSyncCursor" scripts app`. Add `await` to each (all are inside `async` functions). For `slack-sync`, the per-month loop now awaits `readMonthFile`/`writeMonthFile`; resolve them sequentially (small N).
- [ ] **Step 2** — Remove now-defunct FS specifics: `scripts/fieldops.ts` still reads the flight-hours **inputs CSV** from disk — that input stays a file (committed input), unchanged. Only the report/mirror/state reads/writes become DB calls. `defaultBaseDir`/`periodKey` path joins for inputs (field-qa/fieldops inputs CSV) remain file-based (those are committed inputs, not agent state) — leave them.
- [ ] **Step 3** — `npx tsc --noEmit`, `npm run lint`, `npm test` (pure suite green), `npm run build`. Commit: `refactor(cli): await Postgres-backed adapters`.

---

### Task 7: `db:import` backfill + live smoke

**Files:** Create `scripts/db-import.ts`, `scripts/db-smoke.ts`; add `db:import` script.

- [ ] **Step 1** — `scripts/db-smoke.ts`: round-trip each adapter against Neon (insert→read→assert→cleanup) — the D2 adapter coverage. Run via `node --conditions=react-server --import tsx scripts/db-smoke.ts`.
- [ ] **Step 2** — `scripts/db-import.ts`: read any committed `reports/<feature>/<period>.json` from disk and `writeReport` them into Postgres; if a local `data/slack/**` mirror or `reports/{resolutions,published,asks}` exist, load them too. Idempotent. Add `"db:import": "node --conditions=react-server --import tsx scripts/db-import.ts"`.
- [ ] **Step 3** — Run `npm run db:smoke`-style check (manual) + `npm run db:import` against Neon; verify via a `SELECT count(*)` smoke. Commit: `feat(db): import backfill + live smoke`.

---

## Final verification
- [ ] `npm test` green (pure suites; lower count is expected — fs round-trip tests removed per D2).
- [ ] `npx tsc --noEmit` + `npm run lint` clean.
- [ ] `npm run build` succeeds (no client bundle imports `lib/db`).
- [ ] Live end-to-end against Neon: `npm run slack-sync -- init` (writes `slack_messages`), `npm run field-qa -- … --write` + `npm run field-verdict -- … --write` (writes `reports`), `npm run field-publish … --publish` then an approver reply + `npm run field-approvals --write` (writes `resolutions`/`published`) — all reading/writing Postgres, no FS state.

## Notes
- `lib/db.ts` is NOT `server-only` (CLIs import it) but the browser never imports it — verify no `"use client"` file imports `lib/db`/adapters; pages fetch via API routes only.
- Pure logic is the contract: if a pure function's behavior changes, you've gone too far — only the read/write bodies move to SQL.
- The committed-input CSVs (`reports/field-ops/inputs/*`, field-qa source) stay file-based — they're human inputs, not agent state.
