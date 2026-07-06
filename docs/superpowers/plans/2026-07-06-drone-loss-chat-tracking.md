# Drone-Loss Chat Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make drone-loss state durable and visible in Slack — a `loss_records` ledger, a loss line on verdict messages, a `loss` approver-instruction axis, nightly counter + tiered alerts, an agent read tool, and a `field-loss` CLI + web view.

**Architecture:** A Neon `loss_records` ledger (keyed `(date, report_ts)`) becomes the single source of loss truth. A hash-gated sync (`lib/lossSync.ts`) classifies only new/edited Звіт crash text via the existing `extractLoss`; approver instructions write `instruction`-source rows that permanently outrank `extracted` rows. All consumers converge on the ledger: `computeVerdicts` (loss line render), `runNightly` (counter + alerts), `computeBonusReport` (money math), the agent tool, the CLI, and the web.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Drizzle over Vercel/Neon Postgres, Vitest, Anthropic SDK.

**Spec:** `docs/superpowers/specs/2026-07-05-drone-loss-chat-tracking-design.md`

## Global Constraints

- Team-facing Slack text is **Ukrainian**; English never leaks to channels.
- Pure logic lives in `lib/` modules with no React/Next/DB imports, unit-tested.
- Server-only modules import `"server-only"`; CLIs run with `--conditions=react-server`; vitest resolves `server-only` to an empty module (see `vitest.config.ts`).
- All Slack sends go through `postMessage` in `lib/slack.ts` (reserve-then-send dedup on `key`).
- Every feature ships a CLI **and** a web surface (CLAUDE.md non-negotiable).
- New tables: `drizzle-kit generate` migrations only — never hand-edit generated SQL.
- Run all commands from the repo root `/workspaces/orients-ops-console`.
- Never fabricate `found = true` — when classification fails, the previous row stands.

---

### Task 1: `loss_records` + `loss_alerts` schema and migration

**Files:**
- Modify: `lib/schema.ts` (append after the `airborneOverrides` table, ~line 88)
- Generated: `drizzle/0012_*.sql` (via drizzle-kit; do not hand-edit)

**Interfaces:**
- Produces: `schema.lossRecords` (columns `date`, `reportTs`, `lost`, `found`, `note`, `source`, `crashTextHash`, `updatedAt`, `updatedBy`; PK `(date, report_ts)`), `schema.lossAlerts` (PK `period`; `lastAlertedCount`, `fieldqaWarnedAt3`).

- [ ] **Step 1: Add the tables to `lib/schema.ts`**

Append after the `airborneOverrides` table definition:

```ts
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

/** Loss-alert state per period — what the bot already told people. */
export const lossAlerts = pgTable("loss_alerts", {
  period: text("period").primaryKey(), // periodKey, e.g. "2026-07"
  lastAlertedCount: integer("last_alerted_count").notNull(),
  fieldqaWarnedAt3: boolean("fieldqa_warned_at_3").notNull(),
});
```

(`boolean`, `integer`, `text`, `pgTable`, `primaryKey` are already imported at the top of `lib/schema.ts`.)

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0012_*.sql` containing `CREATE TABLE "loss_records"` and `CREATE TABLE "loss_alerts"`, and no other table altered.

- [ ] **Step 3: Apply the migration — raw SQL, NOT drizzle-kit migrate**

`drizzle-kit migrate` is unreliable on this DB (pre-existing journal drift — see the 2026-07-04 SDD ledger). The **controller** applies the generated `drizzle/0012_*.sql` statements directly to Neon in one transaction (both are additive `CREATE TABLE`s — safe before the code deploys). Implementer: generate + commit only; report the migration as pending controller application.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/schema.ts drizzle/
git commit -m "feat(loss): loss_records ledger + loss_alerts schema"
```

---

### Task 2: Pure ledger logic — `lib/lossLedger.ts`

**Files:**
- Create: `lib/lossLedger.ts`
- Test: `lib/lossLedger.test.ts`

**Interfaces:**
- Consumes: `TEAM_LOSS_CUTOFF` from `lib/fieldBonus` (pure module, value `3`).
- Produces:
  - `interface LossRow { date: string; reportTs: string; lost: boolean; found: boolean; note: string; source: "extracted" | "instruction"; crashTextHash: string | null; updatedAt: string; updatedBy: string | null }`
  - `upsertWins(existing: LossRow | undefined, incoming: { source: LossRow["source"] }): boolean`
  - `interface EffectiveLoss { date: string; found: boolean; note: string }`
  - `effectiveLosses(rows: LossRow[], period: { start: string; end: string }): EffectiveLoss[]` — one entry per date whose effective state is lost
  - `unrecoveredLossDates(rows: LossRow[], period: { start: string; end: string }): string[]`
  - `lossForVerdict(rows: LossRow[], date: string, reportTs: string | null): { lost: boolean; found: boolean } | undefined`

- [ ] **Step 1: Write the failing tests**

Create `lib/lossLedger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  effectiveLosses,
  lossForVerdict,
  unrecoveredLossDates,
  upsertWins,
  type LossRow,
} from "./lossLedger";

const row = (over: Partial<LossRow>): LossRow => ({
  date: "2026-07-04",
  reportTs: "111.222",
  lost: true,
  found: false,
  note: "втрата борта",
  source: "extracted",
  crashTextHash: "abc",
  updatedAt: "2026-07-06T00:00:00Z",
  updatedBy: null,
  ...over,
});

const JULY = { start: "2026-07-01", end: "2026-07-31" };

describe("upsertWins", () => {
  it("allows any write when no row exists", () => {
    expect(upsertWins(undefined, { source: "extracted" })).toBe(true);
    expect(upsertWins(undefined, { source: "instruction" })).toBe(true);
  });
  it("lets an instruction overwrite anything", () => {
    expect(upsertWins(row({ source: "extracted" }), { source: "instruction" })).toBe(true);
    expect(upsertWins(row({ source: "instruction" }), { source: "instruction" })).toBe(true);
  });
  it("never lets extraction overwrite an instruction", () => {
    expect(upsertWins(row({ source: "instruction" }), { source: "extracted" })).toBe(false);
    expect(upsertWins(row({ source: "extracted" }), { source: "extracted" })).toBe(true);
  });
});

describe("effectiveLosses / unrecoveredLossDates", () => {
  it("one entry per lost date; lost=false rows are invisible", () => {
    const rows = [row({}), row({ date: "2026-07-05", reportTs: "333.444" }), row({ date: "2026-07-03", reportTs: "555.6", lost: false })];
    expect(effectiveLosses(rows, JULY).map((l) => l.date)).toEqual(["2026-07-04", "2026-07-05"]);
    expect(unrecoveredLossDates(rows, JULY)).toEqual(["2026-07-04", "2026-07-05"]);
  });
  it("two same-date reports with losses dedupe to one date", () => {
    const rows = [row({}), row({ reportTs: "999.0" })];
    expect(unrecoveredLossDates(rows, JULY)).toEqual(["2026-07-04"]);
  });
  it("a per-report instruction row overrides the extracted row for the same reportTs", () => {
    const rows = [row({}), row({ source: "instruction", found: true, crashTextHash: null })];
    expect(unrecoveredLossDates(rows, JULY)).toEqual([]);
    expect(effectiveLosses(rows, JULY)).toEqual([{ date: "2026-07-04", found: true, note: "втрата борта" }]);
  });
  it("a day-wide instruction (reportTs '') overrides every report of the date", () => {
    const rows = [row({}), row({ reportTs: "999.0" }), row({ reportTs: "", source: "instruction", found: true, note: "знайшли" })];
    expect(unrecoveredLossDates(rows, JULY)).toEqual([]);
  });
  it("clamps to the period", () => {
    const rows = [row({ date: "2026-06-30" }), row({})];
    expect(unrecoveredLossDates(rows, JULY)).toEqual(["2026-07-04"]);
  });
});

describe("lossForVerdict", () => {
  it("returns the extracted state for the exact report", () => {
    expect(lossForVerdict([row({})], "2026-07-04", "111.222")).toEqual({ lost: true, found: false });
  });
  it("prefers a per-report instruction, then a day-wide instruction", () => {
    const rows = [row({}), row({ source: "instruction", found: true })];
    expect(lossForVerdict(rows, "2026-07-04", "111.222")).toEqual({ lost: true, found: true });
    const dayWide = [row({}), row({ reportTs: "", source: "instruction", found: true })];
    expect(lossForVerdict(dayWide, "2026-07-04", "111.222")).toEqual({ lost: true, found: true });
  });
  it("returns undefined when there is no loss (or lost=false)", () => {
    expect(lossForVerdict([row({ lost: false })], "2026-07-04", "111.222")).toBeUndefined();
    expect(lossForVerdict([], "2026-07-04", null)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/lossLedger.test.ts`
Expected: FAIL — `Cannot find module './lossLedger'`.

- [ ] **Step 3: Implement `lib/lossLedger.ts`**

```ts
/**
 * Pure drone-loss ledger logic: source precedence (an approver `instruction`
 * row permanently outranks `extracted`), the effective per-date loss view, and
 * the team counter. No DB/Next imports — the DB access lives in lib/lossStore.
 * Row identity is (date, reportTs); reportTs "" marks a day-wide instruction
 * (written from a legacy thread with no reportTs) that overrides every report
 * of its date.
 */
export interface LossRow {
  date: string;
  reportTs: string;
  lost: boolean;
  found: boolean;
  note: string;
  source: "extracted" | "instruction";
  crashTextHash: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface EffectiveLoss {
  date: string;
  found: boolean;
  note: string;
}

/** May `incoming` replace `existing` (same key)? Mirrors sheetImportShouldSkip. */
export function upsertWins(existing: LossRow | undefined, incoming: { source: LossRow["source"] }): boolean {
  if (!existing) return true;
  if (incoming.source === "instruction") return true;
  return existing.source !== "instruction";
}

/** The effective loss state for one date's rows: a day-wide instruction wins,
 *  else per-report with instruction-beats-extracted per reportTs. */
function effectiveForDate(dayRows: LossRow[]): { lost: boolean; found: boolean; note: string } | null {
  const dayWide = dayRows.find((r) => r.reportTs === "" && r.source === "instruction");
  if (dayWide) return dayWide.lost ? dayWide : null;
  const byTs = new Map<string, LossRow>();
  for (const r of dayRows) {
    const cur = byTs.get(r.reportTs);
    if (!cur || (r.source === "instruction" && cur.source !== "instruction")) byTs.set(r.reportTs, r);
  }
  const losses = [...byTs.values()].filter((r) => r.lost);
  if (losses.length === 0) return null;
  // The date counts as unrecovered if ANY of its report losses is unrecovered.
  const unrecovered = losses.find((r) => !r.found);
  return unrecovered ?? losses[0];
}

/** One entry per date in the period whose effective state is a loss. */
export function effectiveLosses(rows: LossRow[], period: { start: string; end: string }): EffectiveLoss[] {
  const inWindow = rows.filter((r) => r.date >= period.start && r.date <= period.end);
  const out: EffectiveLoss[] = [];
  for (const date of [...new Set(inWindow.map((r) => r.date))].sort()) {
    const eff = effectiveForDate(inWindow.filter((r) => r.date === date));
    if (eff) out.push({ date, found: eff.found, note: eff.note });
  }
  return out;
}

/** Distinct dates with an unrecovered loss inside the period (the team counter). */
export function unrecoveredLossDates(rows: LossRow[], period: { start: string; end: string }): string[] {
  return effectiveLosses(rows, period)
    .filter((l) => !l.found)
    .map((l) => l.date);
}

/** The loss state a verdict row should render: per-report instruction, then a
 *  day-wide instruction, then the report's own extracted row. */
export function lossForVerdict(
  rows: LossRow[],
  date: string,
  reportTs: string | null,
): { lost: boolean; found: boolean } | undefined {
  const exact = reportTs
    ? rows.find((r) => r.date === date && r.reportTs === reportTs && r.source === "instruction")
    : undefined;
  const dayWide = rows.find((r) => r.date === date && r.reportTs === "" && r.source === "instruction");
  const extracted = reportTs
    ? rows.find((r) => r.date === date && r.reportTs === reportTs && r.source === "extracted")
    : undefined;
  const rec = exact ?? dayWide ?? extracted;
  return rec?.lost ? { lost: true, found: rec.found } : undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/lossLedger.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add lib/lossLedger.ts lib/lossLedger.test.ts
git commit -m "feat(loss): pure loss-ledger logic — precedence, effective view, counter"
```

---

### Task 3: DB store — `lib/lossStore.ts`

**Files:**
- Create: `lib/lossStore.ts`

**Interfaces:**
- Consumes: `db`, `schema` from `lib/db`; `upsertWins`, `LossRow` from `lib/lossLedger` (Task 2); `schema.lossRecords`/`schema.lossAlerts` (Task 1).
- Produces:
  - `readLossRecords(): Promise<LossRow[]>`
  - `upsertLossRecord(row: LossRow): Promise<boolean>` — false when precedence blocks the write
  - `interface LossAlertState { lastAlertedCount: number; fieldqaWarnedAt3: boolean }`
  - `readLossAlertState(period: string): Promise<LossAlertState | null>`
  - `writeLossAlertState(period: string, state: LossAlertState): Promise<void>`

Thin DB wrapper — no unit test, matching `lib/airborneOverrides.ts` (the logic it delegates to is tested in Task 2).

- [ ] **Step 1: Implement `lib/lossStore.ts`**

```ts
/**
 * Durable drone-loss ledger store over the `loss_records` + `loss_alerts`
 * Postgres tables. NOT server-only: the CLIs import it (like lib/resolutions.ts).
 * Precedence (instruction outranks extracted) is pure in lib/lossLedger; this
 * module only enforces it at write time.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { upsertWins, type LossRow } from "./lossLedger";

export type { LossRow } from "./lossLedger";

function toRow(r: typeof schema.lossRecords.$inferSelect): LossRow {
  return {
    date: r.date,
    reportTs: r.reportTs,
    lost: r.lost,
    found: r.found,
    note: r.note,
    source: r.source as LossRow["source"],
    crashTextHash: r.crashTextHash,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  };
}

/** All loss rows (every classified crash text, including lost=false). */
export async function readLossRecords(): Promise<LossRow[]> {
  const rows = await db.select().from(schema.lossRecords);
  return rows.map(toRow);
}

/** Insert or replace one row, honoring source precedence. Returns whether it landed. */
export async function upsertLossRecord(row: LossRow): Promise<boolean> {
  const existing = await db
    .select()
    .from(schema.lossRecords)
    .where(and(eq(schema.lossRecords.date, row.date), eq(schema.lossRecords.reportTs, row.reportTs)));
  if (!upsertWins(existing[0] ? toRow(existing[0]) : undefined, row)) return false;
  await db
    .insert(schema.lossRecords)
    .values(row)
    .onConflictDoUpdate({ target: [schema.lossRecords.date, schema.lossRecords.reportTs], set: row });
  return true;
}

export interface LossAlertState {
  lastAlertedCount: number;
  fieldqaWarnedAt3: boolean;
}

export async function readLossAlertState(period: string): Promise<LossAlertState | null> {
  const rows = await db.select().from(schema.lossAlerts).where(eq(schema.lossAlerts.period, period));
  return rows[0] ? { lastAlertedCount: rows[0].lastAlertedCount, fieldqaWarnedAt3: rows[0].fieldqaWarnedAt3 } : null;
}

export async function writeLossAlertState(period: string, state: LossAlertState): Promise<void> {
  const values = { period, lastAlertedCount: state.lastAlertedCount, fieldqaWarnedAt3: state.fieldqaWarnedAt3 };
  await db.insert(schema.lossAlerts).values(values).onConflictDoUpdate({ target: schema.lossAlerts.period, set: values });
}
```

- [ ] **Step 2: Typecheck + full test suite (no regressions)**

Run: `npx tsc --noEmit && npm test`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add lib/lossStore.ts
git commit -m "feat(loss): loss_records/loss_alerts DB store with precedence guard"
```

---

### Task 4: Hash-gated ledger sync — `lib/lossSync.ts`

**Files:**
- Create: `lib/lossSync.ts`
- Test: `lib/lossSync.test.ts`

**Interfaces:**
- Consumes: `extractLoss` (`lib/lossExtract`), `readLossRecords`/`upsertLossRecord` (Task 3), `readChannelMessages` (`lib/slackMirror`), `parseMonth` (`lib/fieldReports`), `readAliases`/`mergeAliases` (`lib/rosterAliases`), `SEED_ALIASES` (`lib/fieldRoster`), `LossRow` (Task 2), `Period` (`lib/period`).
- Produces:
  - `crashHash(text: string): string`
  - `syncLossLedger(period: Period, opts?: { onLog?: (m: string) => void }): Promise<LossRow[]>` — returns ALL ledger rows post-sync (callers period-filter via `lossLedger` helpers)

- [ ] **Step 1: Write the failing tests**

Create `lib/lossSync.test.ts` (mock the server-only deps with `vi.hoisted`, the house pattern from `lib/computeBonuses.test.ts`):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LossRow } from "./lossLedger";

const mocks = vi.hoisted(() => ({
  extractLoss: vi.fn(),
  readLossRecords: vi.fn(),
  upsertLossRecord: vi.fn(),
  readChannelMessages: vi.fn(),
  readAliases: vi.fn(),
}));
vi.mock("./lossExtract", () => ({ extractLoss: mocks.extractLoss }));
vi.mock("./lossStore", () => ({
  readLossRecords: mocks.readLossRecords,
  upsertLossRecord: mocks.upsertLossRecord,
}));
vi.mock("./slackMirror", () => ({ readChannelMessages: mocks.readChannelMessages }));
vi.mock("./rosterAliases", () => ({
  readAliases: mocks.readAliases,
  mergeAliases: (a: Record<string, string>, b: Record<string, string>) => ({ ...a, ...b }),
}));

import { crashHash, syncLossLedger } from "./lossSync";

const JULY = { start: "2026-07-01", end: "2026-07-31", timezone: "Europe/Kyiv" };
// A parseable Звіт: date line, roster+window line, then crash text.
const ZVIT = "04.07.2026\nАндріан+Данило 10:00-16:00\nвтрата борта (думаю знайдем)";
const msg = { text: ZVIT, permalink: "p", ts: "111.222" };

const ledgerRow = (over: Partial<LossRow>): LossRow => ({
  date: "2026-07-04",
  reportTs: "111.222",
  lost: true,
  found: false,
  note: "втрата борта",
  source: "extracted",
  crashTextHash: crashHash("втрата борта (думаю знайдем)"),
  updatedAt: "2026-07-05T00:00:00Z",
  updatedBy: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readAliases.mockResolvedValue({});
  mocks.readChannelMessages.mockResolvedValue([msg]);
  mocks.upsertLossRecord.mockResolvedValue(true);
  mocks.extractLoss.mockResolvedValue({ lost: true, found: false, note: "втрата борта" });
});

describe("syncLossLedger", () => {
  it("classifies a Звіт with no ledger row and upserts it (including lost=false)", async () => {
    mocks.readLossRecords.mockResolvedValue([]);
    mocks.extractLoss.mockResolvedValue({ lost: false, found: false, note: "" });
    await syncLossLedger(JULY);
    expect(mocks.extractLoss).toHaveBeenCalledOnce();
    expect(mocks.upsertLossRecord).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-07-04", reportTs: "111.222", lost: false, source: "extracted" }),
    );
  });
  it("skips an unchanged crash text (hash gate) — zero Claude calls", async () => {
    mocks.readLossRecords.mockResolvedValue([ledgerRow({})]);
    await syncLossLedger(JULY);
    expect(mocks.extractLoss).not.toHaveBeenCalled();
    expect(mocks.upsertLossRecord).not.toHaveBeenCalled();
  });
  it("re-classifies when the Звіт crash text was edited", async () => {
    mocks.readLossRecords.mockResolvedValue([ledgerRow({ crashTextHash: "stale-hash" })]);
    await syncLossLedger(JULY);
    expect(mocks.extractLoss).toHaveBeenCalledOnce();
  });
  it("never touches an instruction row", async () => {
    mocks.readLossRecords.mockResolvedValue([ledgerRow({ source: "instruction", crashTextHash: null })]);
    await syncLossLedger(JULY);
    expect(mocks.extractLoss).not.toHaveBeenCalled();
    expect(mocks.upsertLossRecord).not.toHaveBeenCalled();
  });
  it("a classifier failure on one Звіт keeps the old row and continues", async () => {
    mocks.readLossRecords.mockResolvedValue([]);
    mocks.extractLoss.mockRejectedValue(new Error("api down"));
    const rows = await syncLossLedger(JULY);
    expect(mocks.upsertLossRecord).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/lossSync.test.ts`
Expected: FAIL — `Cannot find module './lossSync'`.

- [ ] **Step 3: Implement `lib/lossSync.ts`**

```ts
/**
 * Hash-gated drone-loss ledger sync. SERVER-ONLY (Claude via lossExtract).
 * Parses the period's #field-qa Звіти from the Slack mirror and classifies ONLY
 * crash text that is new or edited since its stored sha256 — a normal run makes
 * zero Claude calls. Approver `instruction` rows are never touched. A classifier
 * failure keeps the previous row (never fabricate a recovery) and continues.
 * Shared by the nightly (counter + alerts), computeVerdicts consumers via the
 * ledger, and computeBonusReport (the money math).
 */
import "server-only";
import { createHash } from "node:crypto";
import { extractLoss } from "./lossExtract";
import { readLossRecords, upsertLossRecord } from "./lossStore";
import { readChannelMessages } from "./slackMirror";
import { parseMonth } from "./fieldReports";
import { mergeAliases, readAliases } from "./rosterAliases";
import { SEED_ALIASES } from "./fieldRoster";
import type { LossRow } from "./lossLedger";
import type { Period } from "./period";

export function crashHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Sync the ledger for a period; returns ALL ledger rows post-sync. */
export async function syncLossLedger(
  period: Period,
  opts: { onLog?: (m: string) => void } = {},
): Promise<LossRow[]> {
  const log = opts.onLog ?? (() => {});
  const aliases = mergeAliases(SEED_ALIASES, await readAliases());
  const messages = (await readChannelMessages("field-qa", period)).filter((m) => !m.deleted);
  const reports = parseMonth(messages, aliases);
  const byKey = new Map((await readLossRecords()).map((r) => [`${r.date}#${r.reportTs}`, r]));

  let classified = 0;
  let failed = 0;
  for (const r of reports) {
    if (!r.crashText) continue;
    const key = `${r.flightDate}#${r.reportTs}`;
    const existing = byKey.get(key);
    if (existing?.source === "instruction") continue;
    const hash = crashHash(r.crashText);
    if (existing && existing.crashTextHash === hash) continue;
    try {
      const cls = await extractLoss(r.crashText);
      classified += 1;
      const row: LossRow = {
        date: r.flightDate,
        reportTs: r.reportTs,
        lost: cls.lost,
        found: cls.found,
        note: cls.note,
        source: "extracted",
        crashTextHash: hash,
        updatedAt: new Date().toISOString(),
        updatedBy: null,
      };
      if (await upsertLossRecord(row)) byKey.set(key, row);
    } catch (e) {
      failed += 1;
      log(`loss-sync: classify failed for ${key} — ${e instanceof Error ? e.message : String(e)} (keeping previous state)`);
    }
  }
  log(`loss-sync: ${classified} classified, ${failed} failed, ${byKey.size} ledger row(s)`);
  return [...byKey.values()];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/lossSync.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add lib/lossSync.ts lib/lossSync.test.ts
git commit -m "feat(loss): hash-gated ledger sync — classify only new/edited crash text"
```

---

### Task 5: Verdict rendering — the loss line

**Files:**
- Modify: `lib/fieldDayVerdict.ts` (the `DayVerdict` interface, ~line 57)
- Modify: `lib/verdictPublish.ts` (new `withLossLine` + `formatDayMessage` return, ~line 212)
- Modify: `lib/computeVerdicts.ts` (attach `loss` per row)
- Test: `lib/verdictPublish.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `readLossRecords` (Task 3), `lossForVerdict` (Task 2).
- Produces: `DayVerdict.loss?: { lost: boolean; found: boolean }`; `withLossLine(body: string, day: DayVerdict): string` exported from `lib/verdictPublish.ts`.

The loss line joins the **body region** (above `👥 У полі:`), so `splitRosterSuffix`/`splitDroneLine` and the roster/drone region edits keep working untouched — the line travels inside `body`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/verdictPublish.test.ts` (reuse the file's existing `DayVerdict` fixture helper if one exists; otherwise this standalone block):

```ts
import { formatDayMessage, withLossLine } from "./verdictPublish";
import type { DayVerdict } from "./fieldDayVerdict";

const lossDay = (loss?: { lost: boolean; found: boolean }): DayVerdict => ({
  date: "2026-07-04",
  reportTs: "111.222",
  reportSeq: 1,
  reportCount: 1,
  status: "ACCEPTED",
  airborneMinutes: 120,
  videoMinutes: 90,
  ratio: 0.75,
  datasetStatus: "POSTED",
  withinGrace: false,
  reasons: [],
  roster: ["Андріан", "Данило"],
  unknownInitials: [],
  airborneReported: true,
  ...(loss ? { loss } : {}),
});

describe("loss line", () => {
  it("renders the unrecovered-loss line inside the body (above the crew line)", () => {
    const text = formatDayMessage(lossDay({ lost: true, found: false }));
    expect(text).toContain("⚠️ Втрата борта (не знайдено).");
    expect(text.indexOf("Втрата борта")).toBeLessThan(text.indexOf("👥 У полі:"));
  });
  it("renders the recovered line", () => {
    expect(formatDayMessage(lossDay({ lost: true, found: true }))).toContain("✅ Борт втрачено і знайдено.");
  });
  it("is byte-identical to the old render when there is no loss", () => {
    expect(formatDayMessage(lossDay())).toBe(formatDayMessage(lossDay(undefined)));
    expect(formatDayMessage(lossDay())).not.toContain("борт");
  });
  it("withLossLine is a no-op without a loss", () => {
    expect(withLossLine("body", lossDay())).toBe("body");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/verdictPublish.test.ts`
Expected: FAIL — `withLossLine` is not exported (and the loss line assertions fail).

- [ ] **Step 3: Implement**

In `lib/fieldDayVerdict.ts`, add to the `DayVerdict` interface (after `droneReportPresent`):

```ts
  /** Drone-loss state for THIS report (from the loss ledger); absent = no loss. */
  loss?: { lost: boolean; found: boolean };
```

In `lib/verdictPublish.ts`, add after `withDroneRegion`:

```ts
/** Append the drone-loss line to the BODY region (above 👥/🛸, so the region
 *  splitters and roster/drone edits are untouched). No loss → body unchanged. Pure. */
export function withLossLine(body: string, day: DayVerdict): string {
  if (!day.loss?.lost) return body;
  return `${body}\n${day.loss.found ? "✅ Борт втрачено і знайдено." : "⚠️ Втрата борта (не знайдено)."}`;
}
```

Change the `formatDayMessage` return (line ~212) from:

```ts
  return withDroneRegion(withRosterSuffix(body, day.roster), day);
```

to:

```ts
  return withDroneRegion(withRosterSuffix(withLossLine(body, day), day.roster), day);
```

In `lib/computeVerdicts.ts`: add imports

```ts
import { readLossRecords } from "./lossStore";
import { lossForVerdict } from "./lossLedger";
```

After `const corrections = await readRosterCorrections();` (~line 108) add:

```ts
  const lossRows = await readLossRecords();
```

In the `flightRows.map` return (~line 144), add the loss attachment:

```ts
    const loss = lossForVerdict(lossRows, date, row.reportTs);
    return {
      ...resolved,
      roster: eff.roster,
      unknownInitials: row.unknownInitials,
      ...(drones && drones.length ? { droneReport: drones } : {}),
      ...(loss ? { loss } : {}),
    };
```

- [ ] **Step 4: Run tests to verify they pass (and no regressions)**

Run: `npx vitest run lib/verdictPublish.test.ts && npm test`
Expected: PASS. Existing `formatDayMessage`/backfill/refresh tests unchanged (no-loss renders are byte-identical).

- [ ] **Step 5: Commit**

```bash
git add lib/fieldDayVerdict.ts lib/verdictPublish.ts lib/computeVerdicts.ts lib/verdictPublish.test.ts
git commit -m "feat(loss): per-report loss line on verdict messages"
```

---

### Task 6: The `loss` instruction axis

**Files:**
- Modify: `lib/instructionClassifyPrompt.ts` (axis type + tool schema + guidance)
- Modify: `lib/proposalSummary.ts` (Ukrainian echo case)
- Modify: `lib/applyInstruction.ts` (route the axis)
- Modify: `scripts/fieldInstructionsReport.ts` (`--loss found|lost` manual flag)
- Modify: `scripts/field-instructions.ts` (usage comment only, add the `--loss` line)
- Test: `lib/instructionClassifyPrompt.test.ts`, `lib/proposalSummary.test.ts` (extend), `lib/applyInstruction.test.ts` (extend), `scripts/fieldInstructionsReport.test.ts` (extend)

**Interfaces:**
- Consumes: `upsertLossRecord` (Task 3).
- Produces: `InstructionAxis` includes `"loss"`; `InstructionClassification.lossState?: "found" | "lost"`; `buildManualInstruction` accepts `{ loss?: "found" | "lost" }`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/proposalSummary.test.ts`:

```ts
it("renders the loss axis", () => {
  expect(renderProposalSummary("2026-07-04", { intent: "instruction", axis: "loss", lossState: "found", reason: "знайшли" }))
    .toBe("борт 2026-07-04: знайдено (втрату знято)");
  expect(renderProposalSummary("2026-07-04", { intent: "instruction", axis: "loss", lossState: "lost", reason: "не знайшли" }))
    .toBe("борт 2026-07-04: втрачено (не знайдено)");
});
```

Append to `lib/instructionClassifyPrompt.test.ts`:

```ts
it("the tool schema carries the loss axis + lossState", () => {
  const schema = CLASSIFY_INSTRUCTION_TOOL.input_schema as {
    properties: { axis: { enum: string[] }; lossState: { enum: string[] } };
  };
  expect(schema.properties.axis.enum).toContain("loss");
  expect(schema.properties.lossState.enum).toEqual(["found", "lost"]);
});

it("the prompt guides the loss axis", () => {
  const p = buildInstructionPrompt("verdict", "борт знайшли", null);
  expect(p).toContain('axis="loss"');
  expect(p).toContain('lossState="found"');
});
```

Append to `lib/applyInstruction.test.ts` (follow the file's existing `vi.hoisted` mock setup; add `upsertLossRecord` to the mocked `./lossStore`):

```ts
it("loss axis writes an instruction ledger row for the report and acks in Ukrainian", async () => {
  const res = await applyInstruction({
    entry: entryFixture({ date: "2026-07-04", reportTs: "111.222" }),
    period: JULY,
    axis: "loss",
    instruction: { intent: "instruction", axis: "loss", lossState: "found", reason: "борт знайшли" },
    by: "Oleksandr K",
    evidence: "https://slack/permalink",
  });
  expect(res.applied).toBe(true);
  expect(mocks.upsertLossRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      date: "2026-07-04",
      reportTs: "111.222",
      lost: true,
      found: true,
      source: "instruction",
      updatedBy: "Oleksandr K",
    }),
  );
  const ack = mocks.postMessage.mock.calls.at(-1)?.[1] as string;
  expect(ack).toContain("знайдено");
});

it("loss axis with a null reportTs writes a day-wide row (reportTs '')", async () => {
  await applyInstruction({
    entry: entryFixture({ date: "2026-07-04", reportTs: null }),
    period: JULY,
    axis: "loss",
    instruction: { intent: "instruction", axis: "loss", lossState: "lost", reason: "не знайшли" },
    by: "Oleksandr K",
    evidence: "",
  });
  expect(mocks.upsertLossRecord).toHaveBeenCalledWith(expect.objectContaining({ reportTs: "", found: false }));
});
```

Append to `scripts/fieldInstructionsReport.test.ts`:

```ts
it("parses --loss and builds the loss instruction", () => {
  const a = parseArgs(["--date", "2026-07-04", "--loss", "found"]);
  expect(a.loss).toBe("found");
  const built = buildManualInstruction({ loss: "found" }, "manual");
  expect(built).toEqual({ axis: "loss", instruction: { intent: "instruction", axis: "loss", lossState: "found", reason: "manual" } });
});
it("rejects an invalid --loss value", () => {
  expect(() => parseArgs(["--loss", "maybe"])).toThrow(/--loss/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/proposalSummary.test.ts lib/instructionClassifyPrompt.test.ts lib/applyInstruction.test.ts scripts/fieldInstructionsReport.test.ts`
Expected: FAIL on each new case (type errors for `"loss"` axis count as failures).

- [ ] **Step 3: Implement**

`lib/instructionClassifyPrompt.ts`:

```ts
export type InstructionAxis = "crew" | "eligibility" | "day" | "dataset" | "video" | "airborne" | "loss";
```

Add to `InstructionClassification` (after `airborneMinutes`):

```ts
  // loss
  lossState?: "found" | "lost";
```

In `CLASSIFY_INSTRUCTION_TOOL`: extend the `axis` enum to `["crew", "eligibility", "day", "dataset", "video", "airborne", "loss"]`, update the tool `description` list to `…airborne minutes / drone loss…`, and add a property after `airborneMinutes`:

```ts
      lossState: {
        type: "string",
        enum: ["found", "lost"],
        description: "loss: found = the lost drone was recovered (the loss no longer counts); lost = confirm it is permanently lost",
      },
```

In `buildInstructionPrompt`, add a guidance line after the airborne one:

```ts
    `- loss: "борт знайшли"/"дрон знайдено" → axis="loss", lossState="found"; "борт втрачено остаточно"/"не знайшли, списуємо" → axis="loss", lossState="lost".`,
```

`lib/proposalSummary.ts` — add before `default`:

```ts
    case "loss":
      return c.lossState === "found"
        ? `борт ${date}: знайдено (втрату знято)`
        : `борт ${date}: втрачено (не знайдено)`;
```

`lib/applyInstruction.ts` — add import `import { upsertLossRecord } from "./lossStore";`, document the axis in the header comment (`- loss → upsertLossRecord(instruction) + ack (body re-renders on next field-verdict)`), and insert before the `// airborne` block:

```ts
  if (axis === "loss") {
    if (c.lossState !== "found" && c.lossState !== "lost") return { applied: false };
    await upsertLossRecord({
      date: entry.date,
      // A legacy thread (no reportTs) records a day-wide override (reportTs "").
      reportTs: entry.reportTs ?? "",
      lost: true,
      found: c.lossState === "found",
      note: c.reason,
      source: "instruction",
      crashTextHash: null,
      updatedAt: new Date().toISOString(),
      updatedBy: by,
    });
    const label =
      c.lossState === "found"
        ? `🛸 Зафіксовано: борт знайдено — втрату за ${entry.date} знято`
        : `🛸 Зафіксовано: борт за ${entry.date} втрачено (не знайдено)`;
    const applied = await ack(entry, `${label} — ${by}. Причина: ${c.reason}`, "loss", trigger);
    return { applied };
  }
```

`scripts/fieldInstructionsReport.ts`: add `loss?: "found" | "lost";` to both the parsed-args interface (~line 28) and the manual-spec interface (~line 92). In `parseArgs`, after the `--airborne` branch:

```ts
    else if (flag === "--loss") {
      if (value !== "found" && value !== "lost") throw new Error(`--loss must be "found" or "lost", got "${value}"`);
      a.loss = value; i += 1;
    }
```

In `buildManualInstruction`, before the `reject` branch:

```ts
  if (spec.loss) {
    return { axis: "loss", instruction: { intent: "instruction", axis: "loss", lossState: spec.loss, reason } };
  }
```

`scripts/field-instructions.ts`: extend the usage header comment's manual-mode flag list with `--loss found|lost`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/proposalSummary.test.ts lib/instructionClassifyPrompt.test.ts lib/applyInstruction.test.ts scripts/fieldInstructionsReport.test.ts && npm test`
Expected: PASS, no regressions (the webhook path — `applyInstructionReply` — needs no change: the new axis flows through classification → proposal → confirm → `applyInstruction`).

- [ ] **Step 5: Commit**

```bash
git add lib/instructionClassifyPrompt.ts lib/proposalSummary.ts lib/applyInstruction.ts scripts/fieldInstructionsReport.ts scripts/field-instructions.ts lib/*.test.ts scripts/fieldInstructionsReport.test.ts
git commit -m "feat(loss): approver instruction axis — «борт знайшли» via thread reply"
```

---

### Task 7: Nightly — loss sync, counter, tiered alerts

**Files:**
- Create: `lib/lossNotice.ts` (pure alert planning + Ukrainian texts)
- Test: `lib/lossNotice.test.ts`
- Modify: `lib/runNightly.ts` (wire the stage)

**Interfaces:**
- Consumes: `TEAM_LOSS_CUTOFF` (`lib/fieldBonus`), `syncLossLedger` (Task 4), `unrecoveredLossDates` (Task 2), `readLossAlertState`/`writeLossAlertState`/`LossAlertState` (Task 3), `openDm`/`postMessage`/`APPROVERS` (already imported in `runNightly`).
- Produces: `planLossAlerts(count: number, prev: LossAlertState | null, periodLabel: string): { operatorDm: string | null; fieldQaWarning: string | null; next: LossAlertState }`.

- [ ] **Step 1: Write the failing tests**

Create `lib/lossNotice.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planLossAlerts } from "./lossNotice";

describe("planLossAlerts", () => {
  it("no change → no messages, state preserved", () => {
    const p = planLossAlerts(2, { lastAlertedCount: 2, fieldqaWarnedAt3: false }, "2026-07");
    expect(p.operatorDm).toBeNull();
    expect(p.fieldQaWarning).toBeNull();
    expect(p.next).toEqual({ lastAlertedCount: 2, fieldqaWarnedAt3: false });
  });
  it("first sighting (no state) with losses → operator DM", () => {
    const p = planLossAlerts(2, null, "2026-07");
    expect(p.operatorDm).toContain("2");
    expect(p.operatorDm).toContain("2026-07");
    expect(p.fieldQaWarning).toBeNull();
  });
  it("2→3 → DM + one-time #field-qa warning in Ukrainian", () => {
    const p = planLossAlerts(3, { lastAlertedCount: 2, fieldqaWarnedAt3: false }, "2026-07");
    expect(p.operatorDm).toContain("3 (було 2)");
    expect(p.fieldQaWarning).toContain("втрат");
    expect(p.fieldQaWarning).toContain("обнул");
    expect(p.next).toEqual({ lastAlertedCount: 3, fieldqaWarnedAt3: true });
  });
  it("recovery 3→2 → DM, and a later re-3 does NOT re-warn the channel", () => {
    const down = planLossAlerts(2, { lastAlertedCount: 3, fieldqaWarnedAt3: true }, "2026-07");
    expect(down.operatorDm).toContain("2 (було 3)");
    expect(down.fieldQaWarning).toBeNull();
    const up = planLossAlerts(3, down.next, "2026-07");
    expect(up.fieldQaWarning).toBeNull();
  });
  it("4th loss → DM says the month is wiped", () => {
    const p = planLossAlerts(4, { lastAlertedCount: 3, fieldqaWarnedAt3: true }, "2026-07");
    expect(p.operatorDm).toContain("обнулено");
  });
  it("zero losses and no prior state → nothing", () => {
    const p = planLossAlerts(0, null, "2026-07");
    expect(p.operatorDm).toBeNull();
    expect(p.fieldQaWarning).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/lossNotice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/lossNotice.ts`**

```ts
/**
 * Pure tiered drone-loss alert planning (spec: every counter change → operator
 * DM; reaching TEAM_LOSS_CUTOFF → a one-time Ukrainian #field-qa warning).
 * The caller persists `next` ONLY after the sends succeed, so a failed send
 * retries next run (the outbound key dedups a half-delivered pair).
 */
import { TEAM_LOSS_CUTOFF } from "./fieldBonus";
import type { LossAlertState } from "./lossStore";

export interface LossAlertPlan {
  operatorDm: string | null;
  fieldQaWarning: string | null;
  next: LossAlertState;
}

function operatorDmText(count: number, prev: number, periodLabel: string): string {
  const status =
    count > TEAM_LOSS_CUTOFF
      ? `Місяць обнулено для всієї команди (понад ${TEAM_LOSS_CUTOFF} втрати).`
      : count === TEAM_LOSS_CUTOFF
        ? "Наступна втрата обнуляє місяць для всієї команди."
        : `Ліміт — ${TEAM_LOSS_CUTOFF} на місяць.`;
  return `🛸 Втрати бортів за ${periodLabel}: ${count} (було ${prev}). ${status}`;
}

export function planLossAlerts(count: number, prev: LossAlertState | null, periodLabel: string): LossAlertPlan {
  const state = prev ?? { lastAlertedCount: 0, fieldqaWarnedAt3: false };
  const operatorDm = count !== state.lastAlertedCount ? operatorDmText(count, state.lastAlertedCount, periodLabel) : null;
  const fieldQaWarning =
    count >= TEAM_LOSS_CUTOFF && !state.fieldqaWarnedAt3
      ? `⚠️ Увага: у команді вже ${count} втрати бортів цього місяця. Ще одна втрата — і місячний бонус обнуляється для всіх.`
      : null;
  return {
    operatorDm,
    fieldQaWarning,
    next: { lastAlertedCount: count, fieldqaWarnedAt3: state.fieldqaWarnedAt3 || fieldQaWarning !== null },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/lossNotice.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the stage into `lib/runNightly.ts`**

Add imports:

```ts
import { syncLossLedger } from "./lossSync";
import { unrecoveredLossDates, type LossRow } from "./lossLedger";
import { readLossAlertState, writeLossAlertState } from "./lossStore";
import { planLossAlerts } from "./lossNotice";
```

Inside the per-month loop (stage `extract/verdict`), in the `isNewest` branch, between `extractFieldQa` and `computeVerdicts` — best-effort like the crew stage (a loss hiccup must never block publish):

```ts
        // 2b. Sync the drone-loss ledger + tiered alerts for the active month.
        // BEST-EFFORT: loss is money/visibility state, not part of the gate.
        try {
          const lossRows: LossRow[] = await syncLossLedger(period, { onLog: log });
          const count = unrecoveredLossDates(lossRows, period).length;
          const alertState = await readLossAlertState(key);
          const plan = planLossAlerts(count, alertState, key);
          if (opts.publish) {
            if (plan.operatorDm) {
              const dm = await openDm(APPROVERS[0].userId);
              await postMessage(dm, plan.operatorDm, {
                key: `loss-alert:${key}:${count}`,
                feature: "loss-alert",
                channel: "dm",
                trigger: "cron",
              });
            }
            if (plan.fieldQaWarning) {
              await postMessage(channel.id, plan.fieldQaWarning, {
                key: `loss-warn:${key}`,
                feature: "loss-alert",
                channel: channel.name,
                trigger: "cron",
              });
            }
            if (plan.operatorDm || plan.fieldQaWarning) await writeLossAlertState(key, plan.next);
          } else if (plan.operatorDm || plan.fieldQaWarning) {
            log(`field-nightly (dry-run): loss alerts — ${[plan.operatorDm, plan.fieldQaWarning].filter(Boolean).join(" | ")}`);
          }
        } catch (e) {
          log(`field-nightly: loss stage skipped — ${e instanceof Error ? e.message : String(e)}`);
          if (opts.publish) await notifyOperator("loss", e instanceof Error ? e.message : String(e), log);
        }
```

Note `key` here is the month's `periodKey(period)` already computed in the loop. The sync runs **before** `computeVerdicts` so the loss line renders from fresh ledger state, and `refreshPublishedDays` (already in stage 3) re-edits any published message whose text changed. The catch-up (prior) month reuses committed verdicts and deliberately skips the loss stage — a prior-month loss correction lands via the instruction axis, whose ack + next recompute handle the re-render (same contract as the airborne axis). The `if (opts.publish)` guard on `notifyOperator` matches the outer catch's convention (a dry-run never DMs).

- [ ] **Step 6: Typecheck + full suite + dry-run**

Run: `npx tsc --noEmit && npm test && npm run field-nightly 2>&1 | grep -i "loss"`
Expected: tests pass; the dry-run log shows `loss-sync: … classified` and (first run, July having 2 losses) a dry-run alert line containing `Втрати бортів за 2026-07: 2 (було 0)`.

- [ ] **Step 7: Commit**

```bash
git add lib/lossNotice.ts lib/lossNotice.test.ts lib/runNightly.ts
git commit -m "feat(loss): nightly loss sync + tiered counter alerts"
```

---

### Task 8: `field-bonus` converges on the ledger

**Files:**
- Modify: `lib/computeBonuses.ts` (replace the per-run `extractLoss` loop, ~lines 45–53)
- Test: `lib/computeBonuses.test.ts` (update the loss mocks)

**Interfaces:**
- Consumes: `syncLossLedger` (Task 4), `effectiveLosses` (Task 2).
- Produces: unchanged `computeBonusReport` signature; the pure `computeBonuses` input `losses: LossRecord[]` is fed from the ledger (`EffectiveLoss` is shape-compatible with `LossRecord`: `{ date, found, note }`).

- [ ] **Step 1: Update the tests**

In `lib/computeBonuses.test.ts`, replace the `./lossExtract` mock with a `./lossSync` + ledger-based mock (follow the file's existing `vi.hoisted` structure):

```ts
// was: vi.mock("./lossExtract", () => ({ extractLoss: mocks.extractLoss }));
vi.mock("./lossSync", () => ({ syncLossLedger: mocks.syncLossLedger }));
```

and update the loss-path cases to resolve ledger rows, e.g.:

```ts
mocks.syncLossLedger.mockResolvedValue([
  { date: "2026-07-04", reportTs: "111.222", lost: true, found: false, note: "втрата", source: "extracted", crashTextHash: "h", updatedAt: "t", updatedBy: null },
]);
```

Add one new case:

```ts
it("an instruction recovery in the ledger clears the loss for the money math", async () => {
  mocks.syncLossLedger.mockResolvedValue([
    { date: "2026-07-04", reportTs: "111.222", lost: true, found: false, note: "втрата", source: "extracted", crashTextHash: "h", updatedAt: "t", updatedBy: null },
    { date: "2026-07-04", reportTs: "111.222", lost: true, found: true, note: "знайшли", source: "instruction", crashTextHash: null, updatedAt: "t2", updatedBy: "Oleksandr K" },
  ]);
  const report = await computeBonusReport(JULY);
  expect(report.teamZeroed).toBe(false);
  expect(report.penalties).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify the new/updated cases fail**

Run: `npx vitest run lib/computeBonuses.test.ts`
Expected: FAIL — `computeBonuses.ts` still mocks/imports `extractLoss`.

- [ ] **Step 3: Implement**

In `lib/computeBonuses.ts`: replace the import `import { extractLoss } from "./lossExtract";` with

```ts
import { syncLossLedger } from "./lossSync";
import { effectiveLosses } from "./lossLedger";
```

Replace the losses loop (lines 45–53) with:

```ts
  // Losses now come from the durable ledger (hash-gated classification inside
  // syncLossLedger — a cold CLI run classifies any un-hashed Звіт itself, so no
  // prior nightly is required). Approver instruction rows override extraction.
  const lossRows = await syncLossLedger(period, { onLog: log });
  const losses: LossRecord[] = effectiveLosses(lossRows, { start: period.start, end: period.end });
  log(`field-bonus: ${losses.filter((l) => !l.found).length} unrecovered loss(es)`);
```

(Keep `parseMonth`/`parsedByReportTs` — arrival time for the early bonus still needs the Звіт parse. Update the header comment: crash text classification moved to the ledger.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/computeBonuses.test.ts lib/fieldBonus.test.ts && npm test`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add lib/computeBonuses.ts lib/computeBonuses.test.ts
git commit -m "feat(loss): field-bonus reads the loss ledger instead of re-classifying"
```

---

### Task 9: Agent read tool — `field_loss_status`

**Files:**
- Create: `lib/agent/tools/fieldLoss.ts`
- Test: `lib/agent/tools/fieldLoss.test.ts`
- Modify: `lib/agent/loop.ts` (default tool set, ~line 72)

**Interfaces:**
- Consumes: `Tool` (`./types`), `readLossRecords` (Task 3), `effectiveLosses` (Task 2), `TEAM_LOSS_CUTOFF` (`lib/fieldBonus`), `FIELD_TIMEZONE` (`lib/reconcile`).
- Produces: `fieldLossTools: Tool[]` (one read tool `field_loss_status`, input `{ start?: string, end?: string }`).

- [ ] **Step 1: Write the failing tests**

Create `lib/agent/tools/fieldLoss.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readLossRecords: vi.fn() }));
vi.mock("@/lib/lossStore", () => ({ readLossRecords: mocks.readLossRecords }));

import { fieldLossTools } from "./fieldLoss";

const tool = fieldLossTools[0];
const row = {
  date: "2026-07-04", reportTs: "111.222", lost: true, found: false, note: "втрата борта",
  source: "extracted" as const, crashTextHash: "h", updatedAt: "t", updatedBy: null,
};

beforeEach(() => vi.clearAllMocks());

describe("field_loss_status", () => {
  it("is a read tool named field_loss_status", () => {
    expect(tool.name).toBe("field_loss_status");
    expect(tool.kind).toBe("read");
  });
  it("reports losses, the counter, and the margin for an explicit period", async () => {
    mocks.readLossRecords.mockResolvedValue([row, { ...row, date: "2026-07-05", reportTs: "333.4" }]);
    const res = await tool.run!({ start: "2026-07-01", end: "2026-07-31" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("2026-07-04");
    expect(res.content).toContain("Невідновлених втрат: 2");
    expect(res.content).toContain("ліміт 3");
  });
  it("says there are no losses when the ledger is clean", async () => {
    mocks.readLossRecords.mockResolvedValue([]);
    const res = await tool.run!({ start: "2026-07-01", end: "2026-07-31" });
    expect(res.content).toContain("Втрат немає");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agent/tools/fieldLoss.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/agent/tools/fieldLoss.ts`**

```ts
/**
 * Field drone-loss read tool for the agent loop: the loss ledger, the
 * unrecovered counter, and the distance to the >3-loss month wipe. Read-only —
 * executes live inside the loop (like jira_search). Loss corrections go through
 * the approver instruction axis, not the agent.
 */
import { readLossRecords } from "@/lib/lossStore";
import { effectiveLosses } from "@/lib/lossLedger";
import { TEAM_LOSS_CUTOFF } from "@/lib/fieldBonus";
import { FIELD_TIMEZONE } from "@/lib/reconcile";
import type { Tool } from "./types";

function kyivMonth(): { start: string; end: string } {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const [y, m] = today.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const fieldLossTools: Tool[] = [
  {
    name: "field_loss_status",
    description:
      "Drone-loss ledger for a period: which flight days lost a drone (втрата борта), which were recovered (знайшли), " +
      "the unrecovered count, and how close the team is to the >3-loss month wipe. " +
      "Use for questions about втрати бортів / lost drones / drone-loss penalties. Dates are YYYY-MM-DD; defaults to the current Kyiv month.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "Period start (YYYY-MM-DD). Default: current Kyiv month." },
        end: { type: "string", description: "Period end (YYYY-MM-DD). Default: current Kyiv month." },
      },
      required: [],
    },
    kind: "read",
    run: async (args) => {
      const fallback = kyivMonth();
      const start = typeof args.start === "string" && DATE_RE.test(args.start) ? args.start : fallback.start;
      const end = typeof args.end === "string" && DATE_RE.test(args.end) ? args.end : fallback.end;
      const losses = effectiveLosses(await readLossRecords(), { start, end });
      const unrecovered = losses.filter((l) => !l.found).length;
      const lines = losses.map((l) => `${l.date}: ${l.found ? "знайдено ✅" : "втрачено ⚠️"} — ${l.note}`);
      return {
        ok: true,
        content: [
          `Втрати бортів ${start}..${end}:`,
          ...(lines.length ? lines : ["Втрат немає."]),
          `Невідновлених втрат: ${unrecovered} (ліміт ${TEAM_LOSS_CUTOFF} на місяць; ${TEAM_LOSS_CUTOFF + 1}-та обнуляє місячний бонус усієї команди).`,
        ].join("\n"),
      };
    },
  },
];
```

In `lib/agent/loop.ts`: add `import { fieldLossTools } from "./tools/fieldLoss";` and change line ~72:

```ts
  const tools = opts.tools ?? [...jiraTools, ...fieldLossTools];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/agent/tools/fieldLoss.test.ts lib/agent/loop.test.ts && npm test`
Expected: PASS (loop tests pass their own `opts.tools`, so the default change is regression-free).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/tools/fieldLoss.ts lib/agent/tools/fieldLoss.test.ts lib/agent/loop.ts
git commit -m "feat(loss): field_loss_status agent read tool"
```

---

### Task 10: `field-loss` CLI

**Files:**
- Create: `scripts/fieldLossReport.ts` (pure shaping — args, report, table)
- Create: `scripts/field-loss.ts` (entry)
- Modify: `package.json` (script)
- Test: `scripts/fieldLossReport.test.ts`

**Interfaces:**
- Consumes: `readLossRecords` (Task 3), `effectiveLosses`/`unrecoveredLossDates` (Task 2), `TEAM_LOSS_CUTOFF` (`lib/fieldBonus`), `readReportJson`/`periodKey` (`lib/reports`), `Penalty` type (`lib/fieldBonus`).
- Produces:
  - `interface LossReport { period: { start: string; end: string }; losses: EffectiveLoss[]; unrecovered: number; cutoff: number; teamZeroed: boolean; penalties: Penalty[] }`
  - `buildLossReport(rows: LossRow[], period, penalties: Penalty[]): LossReport`
  - `renderTable(report: LossReport): string`
  - `parseArgs(argv: string[]): { start?: string; end?: string; format?: "table" }`

- [ ] **Step 1: Write the failing tests**

Create `scripts/fieldLossReport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildLossReport, parseArgs, renderTable } from "./fieldLossReport";
import type { LossRow } from "../lib/lossLedger";

const row: LossRow = {
  date: "2026-07-04", reportTs: "111.222", lost: true, found: false, note: "втрата борта",
  source: "extracted", crashTextHash: "h", updatedAt: "t", updatedBy: null,
};
const JULY = { start: "2026-07-01", end: "2026-07-31" };

describe("field-loss report", () => {
  it("parses --start/--end/--format", () => {
    expect(parseArgs(["--start", "2026-07-01", "--end", "2026-07-31", "--format", "table"]))
      .toEqual({ start: "2026-07-01", end: "2026-07-31", format: "table" });
  });
  it("builds counter + teamZeroed from the ledger", () => {
    const r = buildLossReport([row, { ...row, date: "2026-07-05", reportTs: "3.4" }], JULY, []);
    expect(r.unrecovered).toBe(2);
    expect(r.cutoff).toBe(3);
    expect(r.teamZeroed).toBe(false);
    expect(buildLossReport(
      ["2026-07-04", "2026-07-05", "2026-07-08", "2026-07-09"].map((date, i) => ({ ...row, date, reportTs: String(i) })),
      JULY, [],
    ).teamZeroed).toBe(true);
  });
  it("renders a table with the margin line", () => {
    const t = renderTable(buildLossReport([row], JULY, []));
    expect(t).toContain("2026-07-04");
    expect(t).toContain("unrecovered: 1 / 3");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/fieldLossReport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`scripts/fieldLossReport.ts`:

```ts
/**
 * Pure shaping for the `field-loss` CLI and GET /api/field-loss: the loss
 * ledger's effective view for a period, the unrecovered counter vs the team
 * cutoff, and any crew penalties from the committed field-bonus report.
 * No DB/Next imports — unit-tested.
 */
import { effectiveLosses, unrecoveredLossDates, type EffectiveLoss, type LossRow } from "../lib/lossLedger";
import { TEAM_LOSS_CUTOFF, type Penalty } from "../lib/fieldBonus";

export interface LossReport {
  period: { start: string; end: string };
  losses: EffectiveLoss[];
  unrecovered: number;
  cutoff: number;
  teamZeroed: boolean;
  /** Crew penalty exposure from the committed field-bonus report ([] when absent). */
  penalties: Penalty[];
}

export function parseArgs(argv: string[]): { start?: string; end?: string; format?: "table" } {
  const out: { start?: string; end?: string; format?: "table" } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--start") { out.start = argv[i + 1]; i += 1; }
    else if (argv[i] === "--end") { out.end = argv[i + 1]; i += 1; }
    else if (argv[i] === "--format") { if (argv[i + 1] === "table") out.format = "table"; i += 1; }
    else throw new Error(`Unknown flag ${argv[i]}`);
  }
  return out;
}

export function buildLossReport(rows: LossRow[], period: { start: string; end: string }, penalties: Penalty[]): LossReport {
  const losses = effectiveLosses(rows, period);
  const unrecovered = unrecoveredLossDates(rows, period).length;
  return { period, losses, unrecovered, cutoff: TEAM_LOSS_CUTOFF, teamZeroed: unrecovered > TEAM_LOSS_CUTOFF, penalties };
}

export function renderTable(report: LossReport): string {
  const lines = [
    `Drone losses ${report.period.start}..${report.period.end}`,
    ...report.losses.map((l) => `  ${l.date}  ${l.found ? "FOUND   " : "LOST    "}  ${l.note}`),
    ...(report.losses.length ? [] : ["  (none)"]),
    `unrecovered: ${report.unrecovered} / ${report.cutoff}${report.teamZeroed ? "  TEAM ZEROED (>3)" : ""}`,
    ...report.penalties.map((p) => `  penalty ${p.group.join("+")}: -${p.pct * 100}% (${p.reason})`),
  ];
  return lines.join("\n");
}
```

`scripts/field-loss.ts` (mirror the house entry pattern — `process.loadEnvFile`, Kyiv-month default, JSON to stdout):

```ts
/**
 * CLI: the drone-loss ledger for a period — effective losses, the unrecovered
 * counter vs the >3 team cutoff, and crew penalty exposure from the committed
 * field-bonus report. READ-ONLY (corrections go through
 * `npm run field-instructions -- --date D --loss found|lost`).
 *
 * Usage:
 *   npm run field-loss                                       # current Kyiv month, JSON
 *   npm run field-loss -- --start 2026-07-01 --end 2026-07-31 --format table
 * Mirrors GET /api/field-loss. Needs POSTGRES_URL. Runs under --conditions=react-server.
 */
import { readLossRecords } from "../lib/lossStore";
import { readReportJson, periodKey } from "../lib/reports";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import type { BonusReport } from "../lib/fieldBonus";
import { buildLossReport, parseArgs, renderTable } from "./fieldLossReport";

function kyivMonth(): { start: string; end: string } {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const [y, m] = today.split("-").map(Number);
  const mm = String(m).padStart(2, "0");
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }
  const args = parseArgs(process.argv.slice(2));
  const fallback = kyivMonth();
  const period = { start: args.start ?? fallback.start, end: args.end ?? fallback.end };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.start) || !/^\d{4}-\d{2}-\d{2}$/.test(period.end)) {
    console.error("field-loss: --start/--end must be YYYY-MM-DD");
    process.exit(1);
  }
  const rows = await readLossRecords();
  const bonus = await readReportJson<BonusReport>("field-bonus", periodKey(period));
  const report = buildLossReport(rows, period, bonus?.penalties ?? []);
  if (args.format === "table") console.log(renderTable(report));
  else console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(`field-loss: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
```

`package.json` — add after the `"field-nightly"` script:

```json
    "field-loss": "node --conditions=react-server --import tsx scripts/field-loss.ts",
```

- [ ] **Step 4: Run tests + the CLI end-to-end**

Run: `npx vitest run scripts/fieldLossReport.test.ts && npm run field-loss -- --format table`
Expected: tests PASS; the table shows the two July losses (`2026-07-04 LOST`, `2026-07-05 LOST`, `unrecovered: 2 / 3`) — the ledger was populated by the Task 7/8 runs (if empty, run `npm run field-bonus` once first: it syncs the ledger).

- [ ] **Step 5: Commit**

```bash
git add scripts/fieldLossReport.ts scripts/fieldLossReport.test.ts scripts/field-loss.ts package.json
git commit -m "feat(loss): field-loss CLI — ledger, counter, penalty exposure"
```

---

### Task 11: Web — `GET /api/field-loss` + Losses tab

**Files:**
- Create: `app/api/field-loss/route.ts`
- Create: `app/(dashboard)/losses/page.tsx`
- Modify: `app/(dashboard)/layout.tsx` (nav entry)

**Interfaces:**
- Consumes: `buildLossReport` (Task 10), `readLossRecords` (Task 3), `parsePeriodKey` (`lib/period`), `readReportJson`/`periodKey` (`lib/reports`), `BonusReport` (`lib/fieldBonus`).
- Produces: `GET /api/field-loss?period=<key>` → the Task 10 `LossReport` JSON.

- [ ] **Step 1: Implement the API route**

`app/api/field-loss/route.ts` (mirrors `app/api/instructions/route.ts` — DB-backed live state, no committed snapshot):

```ts
import { NextResponse } from "next/server";
import { parsePeriodKey } from "@/lib/period";
import { readLossRecords } from "@/lib/lossStore";
import { readReportJson, periodKey } from "@/lib/reports";
import { buildLossReport } from "@/scripts/fieldLossReport";
import type { BonusReport } from "@/lib/fieldBonus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/field-loss?period=<key> — the drone-loss ledger's effective view for
 * a period: losses, the unrecovered counter vs the >3 team cutoff, and crew
 * penalty exposure from the committed field-bonus report. Backed directly by
 * our own DB (no committed snapshot), like /api/instructions.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period");
  if (!period) {
    return NextResponse.json({ error: "Provide `period` (YYYY-MM or YYYY-MM-DD_YYYY-MM-DD)." }, { status: 400 });
  }
  const parsed = parsePeriodKey(period);
  if (!parsed) {
    return NextResponse.json({ error: "`period` must be YYYY-MM or YYYY-MM-DD_YYYY-MM-DD." }, { status: 400 });
  }
  const [rows, bonus] = await Promise.all([
    readLossRecords(),
    readReportJson<BonusReport>("field-bonus", periodKey(parsed)),
  ]);
  return NextResponse.json(buildLossReport(rows, parsed, bonus?.penalties ?? []));
}
```

- [ ] **Step 2: Implement the page**

`app/(dashboard)/losses/page.tsx` (mirrors the Instructions tab's fetch/render conventions):

```tsx
"use client";

import { useEffect, useState } from "react";

interface Loss { date: string; found: boolean; note: string }
interface Penalty { group: string[]; lossesInWindow: number; pct: number; reason: string }
interface LossReport {
  period: { start: string; end: string };
  losses: Loss[];
  unrecovered: number;
  cutoff: number;
  teamZeroed: boolean;
  penalties: Penalty[];
}

function currentMonth(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit" })
    .format(new Date())
    .slice(0, 7);
}

export default function LossesPage() {
  const [period, setPeriod] = useState<string>(currentMonth());
  const [report, setReport] = useState<LossReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError(null);
    fetch(`/api/field-loss?period=${encodeURIComponent(period)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
        return r.json() as Promise<LossReport>;
      })
      .then((data) => { if (!cancelled) setReport(data); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [period]);

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Drone Losses</h1>
        <input
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {report && (
        <>
          <div className="rounded border border-slate-200 p-4">
            <p className="text-sm">
              Unrecovered losses: <span className="font-semibold">{report.unrecovered}</span> / {report.cutoff} allowed
              {report.teamZeroed && <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-red-800">TEAM ZEROED (&gt;{report.cutoff})</span>}
            </p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-1 pr-4">Date</th><th className="py-1 pr-4">State</th><th className="py-1">Note</th>
              </tr>
            </thead>
            <tbody>
              {report.losses.map((l) => (
                <tr key={l.date} className="border-b border-slate-100">
                  <td className="py-1 pr-4">{l.date}</td>
                  <td className="py-1 pr-4">{l.found ? "✅ found" : "⚠️ lost"}</td>
                  <td className="py-1">{l.note}</td>
                </tr>
              ))}
              {report.losses.length === 0 && (
                <tr><td colSpan={3} className="py-2 text-slate-500">No losses in this period.</td></tr>
              )}
            </tbody>
          </table>
          {report.penalties.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm">
              {report.penalties.map((p, i) => (
                <p key={i}>Crew {p.group.join(" + ")}: −{p.pct * 100}% ({p.reason})</p>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
```

In `app/(dashboard)/layout.tsx`, add to `TABS` after the Instructions entry:

```ts
  { href: "/losses", label: "Losses", enabled: true },
```

- [ ] **Step 3: Build + verify in the running app**

Run: `npm run build && npm test`
Expected: build passes. Then `curl -s "http://localhost:3003/api/field-loss?period=2026-07"` against `npm run dev` shows `"unrecovered": 2`.

- [ ] **Step 4: Commit**

```bash
git add app/api/field-loss/route.ts "app/(dashboard)/losses/page.tsx" "app/(dashboard)/layout.tsx"
git commit -m "feat(loss): /api/field-loss + Losses dashboard tab"
```

---

### Task 12: Docs, skill, and end-to-end verification

**Files:**
- Modify: `CLAUDE.md` (command entry + nightly note)
- Create: `.claude/skills/field-loss/SKILL.md`

- [ ] **Step 1: Document the command in CLAUDE.md**

Add a bullet after the `field-nightly` entry:

```markdown
- `npm run field-loss -- --start YYYY-MM-DD --end YYYY-MM-DD [--format table]` — the drone-loss ledger for a period: effective losses (approver `instruction` rows outrank `extracted` classification), the unrecovered counter vs the >3-loss team cutoff, and crew penalty exposure from the committed field-bonus report. **Read-only**; corrections go through `npm run field-instructions -- --date D --loss found|lost` or an approver's «борт знайшли» verdict-thread reply (confirm-first). The nightly syncs the ledger (hash-gated — only new/edited Звіт crash text is classified), renders a per-report loss line on verdict messages (`⚠️ Втрата борта` / `✅ Борт втрачено і знайдено`), DMs the operator on every counter change, and posts a one-time Ukrainian #field-qa warning at the 3rd unrecovered loss. Backs the **Losses** web tab (`GET /api/field-loss`) and the agent's `field_loss_status` read tool. (See `docs/superpowers/specs/2026-07-05-drone-loss-chat-tracking-design.md`.)
```

- [ ] **Step 2: Write the skill**

`.claude/skills/field-loss/SKILL.md`:

```markdown
---
name: field-loss
description: Use when answering questions about lost drones (втрата борта) — how many losses this month, which were recovered, how close the team is to the >3-loss month wipe, or which crew carries penalty exposure.
---

# Field Drone Losses

The durable source of loss truth is the `loss_records` Neon ledger: the nightly
(and any `field-bonus` run) classifies each #field-qa Звіт's crash text via
Claude (hash-gated — unchanged text is never re-classified), and approver
instructions («борт знайшли» in a verdict thread, or
`npm run field-instructions -- --date D --loss found|lost --write`) write
override rows that permanently outrank extraction.

## How to answer

Run the read-only CLI (defaults to the current Kyiv month):

    npm run field-loss -- --start 2026-07-01 --end 2026-07-31 [--format table]

JSON fields: `losses[]` (`{date, found, note}` — the effective per-date view),
`unrecovered`, `cutoff` (3), `teamZeroed` (>3 unrecovered wipes the whole
team's month), `penalties[]` (crew exposure from the committed field-bonus
report — −50% at 2 losses within 12 crew trips, −100% at 3).

Needs `POSTGRES_URL`. The web mirror is the **Losses** tab (`GET
/api/field-loss?period=YYYY-MM`); in Slack, ask the agent «скільки втрат
бортів у липні?» (the `field_loss_status` tool).

## Correcting the ledger

Never edit rows by hand. A recovery is an approver reply «борт знайшли» in the
day's verdict thread (confirm-first) or the manual CLI above; the Звіт-edit
path still works for initial declarations (the next sync re-classifies edited
text).
```

- [ ] **Step 3: Full verification**

Run:

```bash
npm run lint && npx tsc --noEmit && npm test
npm run field-loss -- --format table
npm run field-nightly 2>&1 | tail -20
```

Expected: lint/types/tests clean. `field-loss` prints the July ledger (2 unrecovered as of 2026-07-06, unless 04.07 was since recovered). The nightly dry-run logs the loss stage (`loss-sync: 0 classified` on a warm ledger) and posts nothing.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .claude/skills/field-loss/SKILL.md
git commit -m "docs(loss): field-loss command, skill, nightly notes"
```

---

## Self-Review Notes

- **Spec coverage:** §1 ledger → Tasks 1–3; §2 nightly+alerts → Tasks 4, 7; §3 loss line → Task 5; §4 instruction axis → Task 6; §5 agent tool → Task 9; §6 CLI/web/bonus convergence → Tasks 8, 10, 11; §7 error handling → Tasks 4 (classify failure), 7 (state-after-send); §8 testing → per-task TDD steps. Out-of-scope items (cross-date catch-up Звіти, alert-side penalty prediction) stay out.
- **Ordering:** strictly dependency-ordered; Tasks 9–11 are independent of each other and may run in any order after Task 8.
- **Operational note:** the first real (`--publish`) nightly after deploy will DM the operator `Втрати бортів за 2026-07: 2 (було 0)` — expected, not a bug. The 04.07/05.07 verdict messages gain the ⚠️ line via the refresh pass on that same run.
