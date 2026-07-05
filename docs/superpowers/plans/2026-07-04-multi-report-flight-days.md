# Multi-Report Flight Days Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A flight day can carry multiple «Звіт» field reports (one per team); each report gets its own verdict, Slack message/thread, approver-instruction scope, and bonus payout, keyed by the Звіт message's Slack `ts`.

**Architecture:** The parser stops collapsing same-day reports (`parseMonth` returns all, each with `reportTs`). `mergeFlightDays` emits one row per report (synthetic `reportTs: null` row for no-Звіт flight days); `verdictForDay` gains pass-through `reportTs/reportSeq/reportCount`. Day-shared axes (video, airborne, dataset, drone) are computed once per date and replicated onto each row. All date-keyed stores (published log, resolutions, roster corrections, bonus notifications) re-key on `verdictKey = reportKey(date, reportTs)` (`date#ts`, bare date when `reportTs` null), with bare-date rows read-compatible as the legacy single-report form.

**Tech Stack:** TypeScript strict, Vitest, drizzle-orm on Neon Postgres, Next.js 16. Spec: `docs/superpowers/specs/2026-07-04-multi-report-flight-days-design.md`.

## Global Constraints

- `lib/reconcile.ts`, `lib/fieldReports.ts`, `lib/fieldDayVerdict.ts`, `lib/fieldBonus.ts`, `lib/verdictPublish.ts`, `lib/rosterCorrection.ts` are PURE (no React/Next/DB imports) — keep them that way.
- All team-facing Slack copy is Ukrainian; verdict `reasons` stay English (internal).
- Single-report days must render **byte-identical** Slack messages to today (no «виїзд 1/1» noise) — the backfill/idempotency comparisons depend on it.
- Report identity = the Звіт message's own Slack `ts` (`m.ts`, NOT `thread_ts`). Corrections are Slack edits (same ts). No supersede/fuzzy-dedup logic.
- Legacy bare-date store keys = "the day's single report". Never migrate stored data; read-compatibility only.
- The ≥3h deploy gate, crew, day-accept/reject, and eligibility are per-report; video/airborne/dataset/drone-count are day-scoped. `reportTs: ""` on a resolution/correction = day-wide scope.
- Run tests with `npx vitest run <file>`; the full suite with `npm test`. CLIs run via `node --env-file=.env --conditions=react-server --import tsx <script>` (or the `npm run <feature>` wrappers).
- Commit after each task with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Shared trunk checkout: stage ONLY your own files by explicit path (never `git add -A`); leave `next-env.d.ts` untouched.
- **Verification DB:** the prod Neon DB is NOT migrated until Task 12. Any step that runs a CLI needing the new columns (Tasks 5 verify, 8 Steps 3–4, 11 Step 3) must run against the Neon branch created in Task 5 by prefixing the command with `POSTGRES_URL=<branch-url>` (the controller supplies the URL). Never run `npm run db:migrate` against prod before Task 12.

---

### Task 1: Parser keeps every report (`lib/fieldReports.ts`)

**Files:**
- Modify: `lib/fieldReports.ts`
- Test: `lib/fieldReports.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `FieldReport` gains `reportTs: string`; `parseZvit(text, meta: { permalink: string; threadTs: string; reportTs: string }, aliases?)`; `parseMonth(messages, aliases?)` now returns **all** reports sorted by `(flightDate, reportTs)` — no per-date dedup. Callers in Tasks 4 and 8 rely on exactly these names.

- [ ] **Step 1: Write the failing tests** (append to `lib/fieldReports.test.ts`; match its existing style)

```ts
describe("multi-report days", () => {
  it("keeps two same-day reports from different crews, each with its own reportTs", () => {
    const msgs = [
      { text: "Звіт 01.07.2026\nАндріан+ Надія 12:30-16:10\n\nТюнили 15ку", permalink: "p1", ts: "1782912665.697519" },
      { text: "Звіт 01.07.2026\nВладислав + Надія 18.20-20.10\n\nКласифікатор", permalink: "p2", ts: "1782927922.936129" },
    ];
    const reports = parseMonth(msgs);
    expect(reports).toHaveLength(2);
    expect(reports[0].reportTs).toBe("1782912665.697519");
    expect(reports[0].deployMin).toBe(220);
    expect(reports[1].reportTs).toBe("1782927922.936129");
    expect(reports[1].deployMin).toBe(110);
  });

  it("sorts by flightDate then ts across dates", () => {
    const msgs = [
      { text: "Звіт 02.07.2026\nА+Б 10:00-14:00", permalink: "p3", ts: "3.0" },
      { text: "Звіт 01.07.2026\nВ+Г 09:00-13:00", permalink: "p4", ts: "2.0" },
    ];
    expect(parseMonth(msgs).map((r) => r.flightDate)).toEqual(["2026-07-01", "2026-07-02"]);
  });
});
```

Also update any existing test asserting last-wins-per-date (there is one covering the "latest message per date" behavior): it must now expect BOTH reports. A same-ts edit needs no test here — the Slack mirror stores edits under the same ts, so the parser never sees two versions.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run lib/fieldReports.test.ts`
Expected: FAIL — `reportTs` undefined / length 1 vs 2.

- [ ] **Step 3: Implement**

In `lib/fieldReports.ts`:

```ts
export interface FieldReport {
  flightDate: string;
  /** Slack ts of the Звіт message — the report's identity and its thread root. */
  reportTs: string;
  roster: string[];
  unknownInitials: string[];
  start: string | null;
  end: string | null;
  deployMin: number | null;
  crashText: string | null;
  permalink: string;
  threadTs: string;
}

export function parseZvit(
  text: string,
  meta: { permalink: string; threadTs: string; reportTs: string },
  aliases: Record<string, string> = {},
): FieldReport | null {
  // ... existing body unchanged until the return ...
  return { flightDate, reportTs: meta.reportTs, roster, unknownInitials, start, end, deployMin, crashText, permalink: meta.permalink, threadTs: meta.threadTs };
}

export function parseMonth(
  messages: { text: string; permalink: string; thread_ts?: string; ts: string }[],
  aliases: Record<string, string> = {},
): FieldReport[] {
  const reports: FieldReport[] = [];
  for (const m of messages) {
    const r = parseZvit(m.text ?? "", { permalink: m.permalink, threadTs: m.thread_ts ?? m.ts, reportTs: m.ts }, aliases);
    if (r) reports.push(r);
  }
  return reports.sort(
    (a, b) => a.flightDate.localeCompare(b.flightDate) || a.reportTs.localeCompare(b.reportTs),
  );
}
```

Update the module doc comment: the old "a report date that lags the post time / latest wins" note becomes "every Звіт message is a distinct report (one message = one report; corrections are Slack edits)".

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/fieldReports.test.ts`
Expected: PASS (including the updated former last-wins test).

- [ ] **Step 5: Commit** — `git commit -m "feat(reports): parseMonth keeps every Звіт (reportTs identity, no last-wins)"` (with trailer). Note: `lib/computeVerdicts.ts` / `lib/computeBonuses.ts` still compile (they consume the array), but their behavior updates land in Tasks 4/10 — the full suite may not be green until then; run only this file's tests here.

---

### Task 2: Pure verdict types + `reportKey` (`lib/fieldDayVerdict.ts`)

**Files:**
- Modify: `lib/fieldDayVerdict.ts`
- Test: `lib/fieldDayVerdict.test.ts`

**Interfaces:**
- Produces: `reportKey(date: string, reportTs: string | null | undefined): string`; `VerdictInput` gains optional `reportTs?: string | null; reportSeq?: number; reportCount?: number`; `DayVerdict` gains required `reportTs: string | null; reportSeq: number; reportCount: number` (defaults `null`/`1`/`1`). Tasks 3–10 import `reportKey` from here.

- [ ] **Step 1: Write the failing tests** (append to `lib/fieldDayVerdict.test.ts`)

```ts
describe("report identity", () => {
  it("reportKey composes date#ts and falls back to the bare date", () => {
    expect(reportKey("2026-07-01", "1782912665.697519")).toBe("2026-07-01#1782912665.697519");
    expect(reportKey("2026-07-01", null)).toBe("2026-07-01");
    expect(reportKey("2026-07-01", undefined)).toBe("2026-07-01");
  });

  it("verdictForDay passes report identity through, defaulting to a single day-report", () => {
    const base = { flightDate: "2026-07-01", airborneMinutes: 100, videoMinutes: 90, datasetStatus: "POSTED" as const, today: "2026-07-02", graceWorkingDays: 3 };
    const v = verdictForDay({ ...base, reportTs: "1.0", reportSeq: 2, reportCount: 2, deployMin: 110 });
    expect(v.reportTs).toBe("1.0");
    expect(v.reportSeq).toBe(2);
    expect(v.reportCount).toBe(2);
    expect(v.status).toBe("REJECTED"); // per-report 3h gate
    const legacy = verdictForDay(base);
    expect(legacy.reportTs).toBeNull();
    expect(legacy.reportSeq).toBe(1);
    expect(legacy.reportCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/fieldDayVerdict.test.ts` → FAIL (`reportKey` not exported).

- [ ] **Step 3: Implement**

```ts
/** Canonical store key for one report's verdict: "<date>#<reportTs>"; the bare
 *  date for a synthetic no-Звіт row — and for every legacy pre-multi-report row. */
export function reportKey(date: string, reportTs: string | null | undefined): string {
  return reportTs ? `${date}#${reportTs}` : date;
}
```

`VerdictInput` additions (after `hasZvit`):

```ts
  /** Звіт message ts — the report's identity; null/absent = synthetic no-Звіт day. */
  reportTs?: string | null;
  /** 1-based position among the day's reports (display: «виїзд 2/2»). */
  reportSeq?: number;
  reportCount?: number;
```

`DayVerdict` additions (after `date`):

```ts
  /** Звіт message ts; null = no-Звіт synthetic row or a legacy day verdict. */
  reportTs: string | null;
  reportSeq: number;
  reportCount: number;
```

In `verdictForDay`'s return object add:

```ts
    reportTs: input.reportTs ?? null,
    reportSeq: input.reportSeq ?? 1,
    reportCount: input.reportCount ?? 1,
```

Update the module doc comment: gate axes split into per-report (deploy, crew) vs day-shared (video, dataset, drone).

- [ ] **Step 4: Run** — `npx vitest run lib/fieldDayVerdict.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(verdict): report identity on DayVerdict + reportKey helper`.

---

### Task 3: Per-report flight rows (`scripts/fieldVerdictReport.ts`)

**Files:**
- Modify: `scripts/fieldVerdictReport.ts`
- Test: `scripts/fieldVerdictReport.test.ts`

**Interfaces:**
- Consumes: `FieldReport` (Task 1).
- Produces: `FlightDayInput` becomes one row per report:

```ts
export interface FlightDayInput {
  date: string;
  airborneMinutes: number;      // day-shared
  airborneReported: boolean;    // day-shared
  reportTs: string | null;      // null = synthetic no-Звіт row
  reportSeq: number;
  reportCount: number;
  deployWindow?: { start: string; end: string };
  /** number → gate on it; null → Звіт without a window; undefined → no Звіт. */
  deployMin?: number | null;
  roster: string[];
  unknownInitials: string[];
}
```

`mergeFlightDays(airborneByDate, parsed, period?)` keeps its name; `parsed` rows now need `reportTs`, `roster`, `unknownInitials` too (pass `FieldReport[]` straight through). `toCsv` gains `reportTs,reportSeq,reportCount` columns after `date`.

- [ ] **Step 1: Write the failing tests** (extend `scripts/fieldVerdictReport.test.ts`; adapt existing `mergeFlightDays` fixtures — they must now pass `reportTs/roster/unknownInitials` and expect the new row fields)

```ts
const rpt = (over: Partial<{ flightDate: string; reportTs: string; deployMin: number | null; start: string | null; end: string | null; roster: string[]; unknownInitials: string[] }>) => ({
  flightDate: "2026-07-01", reportTs: "1.0", deployMin: 220, start: "12:30", end: "16:10", roster: ["Андріан", "Надія"], unknownInitials: [], ...over,
});

it("emits one row per report with day-shared airborne and per-report windows", () => {
  const rows = mergeFlightDays(
    new Map([["2026-07-01", 153.4]]),
    [rpt({}), rpt({ reportTs: "2.0", deployMin: 110, start: "18:20", end: "20:10", roster: ["Влад", "Надія"] })],
  );
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => [r.reportSeq, r.reportCount, r.deployMin])).toEqual([[1, 2, 220], [2, 2, 110]]);
  expect(rows[0].airborneMinutes).toBe(153.4);
  expect(rows[1].airborneMinutes).toBe(153.4);
  expect(rows[1].roster).toEqual(["Влад", "Надія"]);
});

it("keeps a synthetic reportTs-null row for an airborne day with no Звіт", () => {
  const rows = mergeFlightDays(new Map([["2026-07-02", 60]]), []);
  expect(rows).toEqual([
    { date: "2026-07-02", airborneMinutes: 60, airborneReported: true, reportTs: null, reportSeq: 1, reportCount: 1, roster: [], unknownInitials: [] },
  ]);
});

it("still requires a window (deployMin) for a report-only date to count as a flight day", () => {
  expect(mergeFlightDays(new Map(), [rpt({ deployMin: null, start: null, end: null })])).toHaveLength(0);
});

it("a window-less second Звіт on an airborne day surfaces as its own row (curable gap)", () => {
  const rows = mergeFlightDays(new Map([["2026-07-01", 100]]), [rpt({}), rpt({ reportTs: "2.0", deployMin: null, start: null, end: null })]);
  expect(rows).toHaveLength(2);
  expect(rows[1].deployMin).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run scripts/fieldVerdictReport.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
export function mergeFlightDays(
  airborneByDate: Map<string, number>,
  parsed: {
    flightDate: string; reportTs: string; deployMin: number | null;
    start: string | null; end: string | null;
    roster: string[]; unknownInitials: string[];
  }[],
  period?: { start: string; end: string },
): FlightDayInput[] {
  const reportsByDate = new Map<string, typeof parsed>();
  for (const r of parsed) {
    const arr = reportsByDate.get(r.flightDate) ?? [];
    arr.push(r);
    reportsByDate.set(r.flightDate, arr);
  }
  // A date is a flight day when the bot reported airborne time OR some Звіт has
  // a deployment window. Once a date qualifies, EVERY report on it becomes a row
  // (a window-less one is a curable gap on that report).
  const dates = new Set<string>(airborneByDate.keys());
  for (const r of parsed) if (r.deployMin != null) dates.add(r.flightDate);
  const inPeriod = (d: string) => !period || (d >= period.start && d <= period.end);
  const rows: FlightDayInput[] = [];
  for (const date of [...dates].filter(inPeriod).sort((a, b) => a.localeCompare(b))) {
    const day = { airborneMinutes: airborneByDate.get(date) ?? 0, airborneReported: airborneByDate.has(date) };
    const reports = (reportsByDate.get(date) ?? []).slice().sort((a, b) => a.reportTs.localeCompare(b.reportTs));
    if (reports.length === 0) {
      rows.push({ date, ...day, reportTs: null, reportSeq: 1, reportCount: 1, roster: [], unknownInitials: [] });
      continue;
    }
    reports.forEach((r, i) =>
      rows.push({
        date, ...day,
        reportTs: r.reportTs, reportSeq: i + 1, reportCount: reports.length,
        deployMin: r.deployMin,
        ...(r.start && r.end ? { deployWindow: { start: r.start, end: r.end } } : {}),
        roster: r.roster, unknownInitials: r.unknownInitials,
      }),
    );
  }
  return rows;
}
```

`toCsv`: header → `date,reportTs,reportSeq,reportCount,status,airborneMinutes,...`; row cells insert `d.reportTs ?? ""`, `String(d.reportSeq)`, `String(d.reportCount)` after `d.date`. `formatTable`: render the date cell as `` `${d.date}${d.reportCount > 1 ? ` #${d.reportSeq}/${d.reportCount}` : ""}` `` (widen the pad to 16).

- [ ] **Step 4: Run** — `npx vitest run scripts/fieldVerdictReport.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(verdict): mergeFlightDays emits one row per Звіт`.

---

### Task 4: Report-scoped resolutions + roster-correction lookup (pure)

**Files:**
- Modify: `lib/resolutions.ts`, `lib/rosterCorrection.ts`, `lib/schema.ts`
- Test: `lib/resolutions.test.ts`, new cases in existing `rosterCorrection` coverage (`lib/fieldBonus.test.ts` hosts them today — put `correctionForReport` tests in `lib/fieldBonus.test.ts` or a new `lib/rosterCorrection.test.ts`)

**Interfaces:**
- Produces:
  - `Resolution` gains `reportTs?: string` (`""`/absent = day-wide; a Звіт ts = that report only).
  - `applyResolution(verdict: DayVerdict, resolutions: Resolution[])` — unchanged signature; scope-aware via `verdict.reportTs`.
  - `deriveDatasetStatus(datasetPosted, date, resolutions, reportTs?: string | null)` and `dayRescuedByException(date, resolutions, reportTs?: string | null)` gain the scope param (default `null` = day-wide view).
  - `RosterCorrection` gains `reportTs?: string`; new pure `correctionForReport(corrections: RosterCorrection[], date: string, reportTs: string | null, reportCount: number): RosterCorrection | undefined` in `lib/rosterCorrection.ts`.
  - `lib/schema.ts`: `resolutions` gains `reportTs: text("report_ts").notNull().default("")`, PK `(date, axis, report_ts)`; `rosterCorrections` gains the same column, PK `(date, report_ts)`. (Migration lands in Task 5.)

- [ ] **Step 1: Write the failing tests**

`lib/resolutions.test.ts` additions:

```ts
it("a report-scoped rejection vetoes only its report", () => {
  const rej = { date: "2026-07-01", reportTs: "2.0", axis: "day" as const, decision: "rejected" as const, note: "дубль", source: "s", recordedAt: "t" };
  const v1 = { ...someAcceptedVerdict, date: "2026-07-01", reportTs: "1.0" };
  const v2 = { ...someAcceptedVerdict, date: "2026-07-01", reportTs: "2.0" };
  expect(applyResolution(v1, [rej]).status).toBe(v1.status);      // untouched
  expect(applyResolution(v2, [rej]).status).toBe("REJECTED");
});

it("a day-wide (no reportTs) resolution applies to every report of the day", () => {
  const rej = { date: "2026-07-01", axis: "day" as const, decision: "rejected" as const, note: "n", source: "s", recordedAt: "t" };
  expect(applyResolution({ ...someAcceptedVerdict, date: "2026-07-01", reportTs: "1.0" }, [rej]).status).toBe("REJECTED");
});

it("deriveDatasetStatus honours report scope for day-axis declines", () => {
  const rej = { date: "2026-07-01", reportTs: "2.0", axis: "day" as const, decision: "rejected" as const, note: "n", source: "s", recordedAt: "t" };
  expect(deriveDatasetStatus(false, "2026-07-01", [rej], "1.0").status).toBe("MISSING");
  expect(deriveDatasetStatus(false, "2026-07-01", [rej], "2.0").status).toBe("DECLINED");
});
```

(`someAcceptedVerdict`: reuse the file's existing DayVerdict fixture, adding the three new required fields `reportTs/reportSeq/reportCount` — the compiler will point at every fixture needing them.)

`correctionForReport` tests:

```ts
it("prefers the exact report-scoped correction, falls back day-wide only on single-report days", () => {
  const dayWide = { date: "2026-07-01", roster: ["Ш"], note: "", by: "b", source: "manual", recordedAt: "t" };
  const scoped = { date: "2026-07-01", reportTs: "2.0", roster: ["С"], note: "", by: "b", source: "slack", recordedAt: "t" };
  expect(correctionForReport([dayWide, scoped], "2026-07-01", "2.0", 2)).toBe(scoped);
  expect(correctionForReport([dayWide], "2026-07-01", "1.0", 2)).toBeUndefined(); // multi-report: Звіт roster wins
  expect(correctionForReport([dayWide], "2026-07-01", "1.0", 1)).toBe(dayWide);
  expect(correctionForReport([dayWide], "2026-07-01", null, 1)).toBe(dayWide);    // synthetic row
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/resolutions.test.ts lib/fieldBonus.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`lib/resolutions.ts` — add to `Resolution`; add the scope predicate and use it in all three functions:

```ts
/** Does this resolution bind the given report? ''/absent scope = the whole day. */
function appliesTo(r: Resolution, date: string, reportTs: string | null): boolean {
  if (r.date !== date) return false;
  const scope = r.reportTs ?? "";
  return scope === "" || scope === (reportTs ?? "");
}
```

- `applyResolution`: `resolutions.filter((r) => appliesTo(r, verdict.date, verdict.reportTs) && (r.axis === "video" || r.axis === "day"))`.
- `deriveDatasetStatus(datasetPosted, date, resolutions, reportTs: string | null = null)`: same predicate for the `(dataset|day)` filter.
- `dayRescuedByException(date, resolutions, reportTs: string | null = null)`: same for `(video|day)`.
- `toResolution`: `...(r.reportTs ? { reportTs: r.reportTs } : {})`; `upsertResolution` values gain `reportTs: resolution.reportTs ?? ""`, conflict target `[schema.resolutions.date, schema.resolutions.axis, schema.resolutions.reportTs]`.

`lib/rosterCorrection.ts` — add `reportTs?: string` to `RosterCorrection` (doc: `""`/absent = day-wide — approver legacy + sheet import) and:

```ts
/**
 * The correction binding one report: an exact report-scoped one wins; a day-wide
 * correction binds only a single-report day or the synthetic no-Звіт row — on a
 * multi-report day each Звіт's own roster is authoritative.
 */
export function correctionForReport(
  corrections: RosterCorrection[],
  date: string,
  reportTs: string | null,
  reportCount: number,
): RosterCorrection | undefined {
  const forDate = corrections.filter((c) => c.date === date);
  const scoped = reportTs ? forDate.find((c) => c.reportTs === reportTs) : undefined;
  if (scoped) return scoped;
  if (reportTs !== null && reportCount > 1) return undefined;
  return forDate.find((c) => !c.reportTs);
}
```

`lib/schema.ts` — apply the two table changes from the Interfaces block (composite PKs via `primaryKey({ columns: [...] })`; `rosterCorrections.date` loses `.primaryKey()`).

`lib/rosterCorrections.ts` — `toCorrection` adds `...(r.reportTs ? { reportTs: r.reportTs } : {})`; `upsertRosterCorrection` values add `reportTs: c.reportTs ?? ""` and conflict target becomes `[schema.rosterCorrections.date, schema.rosterCorrections.reportTs]`; the sheet-guard select adds `and(eq(schema.rosterCorrections.date, c.date), eq(schema.rosterCorrections.reportTs, ""))` (import `and`).

- [ ] **Step 4: Run** — `npx vitest run lib/resolutions.test.ts lib/fieldBonus.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(resolutions): report-scoped resolutions + roster-correction lookup`.

---

### Task 5: DB migration (report_ts / verdict_key columns, PK swaps)

**Files:**
- Modify: `lib/schema.ts` (the `published` + `bonusNotified` halves; `resolutions`/`rosterCorrections` changed in Task 4)
- Create: `drizzle/0011_*.sql` (via `npm run db:generate`, then hand-edit)

**Interfaces:**
- Produces: `schema.published` gains `reportTs: text("report_ts")` (nullable) and `verdictKey: text("verdict_key").notNull()`, PK `(period, verdict_key)`; `schema.bonusNotified` gains the same two columns, PK `(period, verdict_key)`. Tasks 6/9/10 depend on these columns.

- [ ] **Step 1: Update `lib/schema.ts`**

```ts
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
    override: jsonb("override"),
  },
  (t) => [primaryKey({ columns: [t.period, t.verdictKey] })],
);

export const bonusNotified = pgTable(
  "bonus_notified",
  {
    period: text("period").notNull(),
    date: text("date").notNull(),
    reportTs: text("report_ts"),
    verdictKey: text("verdict_key").notNull(),
    threadTs: text("thread_ts"),
    dms: jsonb("dms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.period, t.verdictKey] })],
);
```

- [ ] **Step 2: Generate the migration** — Run `npm run db:generate`. Inspect the new `drizzle/0011_*.sql`.

- [ ] **Step 3: Hand-edit the generated SQL** so NOT NULL additions backfill first. The final file must have this shape (keep drizzle's own constraint names — check the generated DROP/ADD lines and, if unsure of live names, run `select conrelid::regclass, conname from pg_constraint where contype='p' and conrelid in ('published'::regclass,'bonus_notified'::regclass,'resolutions'::regclass,'roster_corrections'::regclass);` against Neon):

```sql
ALTER TABLE "resolutions" ADD COLUMN "report_ts" text NOT NULL DEFAULT '';
ALTER TABLE "resolutions" DROP CONSTRAINT "resolutions_date_axis_pk";
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_date_axis_report_ts_pk" PRIMARY KEY ("date","axis","report_ts");

ALTER TABLE "roster_corrections" ADD COLUMN "report_ts" text NOT NULL DEFAULT '';
ALTER TABLE "roster_corrections" DROP CONSTRAINT "roster_corrections_pkey";
ALTER TABLE "roster_corrections" ADD CONSTRAINT "roster_corrections_date_report_ts_pk" PRIMARY KEY ("date","report_ts");

ALTER TABLE "published" ADD COLUMN "report_ts" text;
ALTER TABLE "published" ADD COLUMN "verdict_key" text;
UPDATE "published" SET "verdict_key" = "date";
ALTER TABLE "published" ALTER COLUMN "verdict_key" SET NOT NULL;
ALTER TABLE "published" DROP CONSTRAINT "published_period_date_pk";
ALTER TABLE "published" ADD CONSTRAINT "published_period_verdict_key_pk" PRIMARY KEY ("period","verdict_key");

ALTER TABLE "bonus_notified" ADD COLUMN "report_ts" text;
ALTER TABLE "bonus_notified" ADD COLUMN "verdict_key" text;
UPDATE "bonus_notified" SET "verdict_key" = "date";
ALTER TABLE "bonus_notified" ALTER COLUMN "verdict_key" SET NOT NULL;
ALTER TABLE "bonus_notified" DROP CONSTRAINT "bonus_notified_period_date_pk";
ALTER TABLE "bonus_notified" ADD CONSTRAINT "bonus_notified_period_verdict_key_pk" PRIMARY KEY ("period","verdict_key");
```

If drizzle-kit's generated file differs only cosmetically (statement-breakpoint comments, constraint names), keep its names and just insert the two `UPDATE … SET "verdict_key" = "date";` lines before the corresponding `SET NOT NULL`.

- [ ] **Step 4: DO NOT run `db:migrate` yet.** The migration changes conflict targets that the CURRENTLY DEPLOYED code upserts against — apply it in Task 12 (rollout), immediately before pushing, to keep the broken window to minutes. Verify the SQL parses: `npx tsc --noEmit` for the schema half, and eyeball the SQL.

- [ ] **Step 5: Commit** — `feat(db): report_ts/verdict_key columns + per-report primary keys (migration not yet applied)`.

---

### Task 6: Published log re-keying (`lib/published.ts`)

**Files:**
- Modify: `lib/published.ts`
- Test: `lib/published.test.ts`

**Interfaces:**
- Consumes: `reportKey` (Task 2), schema columns (Task 5).
- Produces:
  - `PublishedEntry` gains `reportTs: string | null`.
  - `PublishedLog` keyed by `verdictKey` (`reportKey(entry.date, entry.reportTs)`); legacy rows keep bare-date keys.
  - `isPublished(log: PublishedLog, target: { date: string; reportTs: string | null; reportCount: number }): boolean` — **signature change**; legacy bare-date entry covers a report only when `reportCount === 1`.
  - `recordPublished(log, entry)` keys by `reportKey`.
  - `readPublished`/`writePublished`/`findPublishedByTs` carry the new column (write conflict target `[period, verdictKey]`).

- [ ] **Step 1: Write the failing tests** (extend `lib/published.test.ts`; existing pure tests updated for the new entry field)

```ts
const entry = (date: string, reportTs: string | null): PublishedEntry =>
  ({ date, reportTs, channel: "field-qa", text: "t", postedAt: "p", ts: `${date}-ts` });

it("records per-report entries under date#ts without colliding", () => {
  let log: PublishedLog = {};
  log = recordPublished(log, entry("2026-07-01", "1.0"));
  log = recordPublished(log, entry("2026-07-01", "2.0"));
  expect(Object.keys(log).sort()).toEqual(["2026-07-01#1.0", "2026-07-01#2.0"]);
});

it("isPublished: exact key, legacy bare-date fallback only for single-report days", () => {
  const legacy: PublishedLog = { "2026-06-29": entry("2026-06-29", null) };
  expect(isPublished(legacy, { date: "2026-06-29", reportTs: "9.0", reportCount: 1 })).toBe(true);
  expect(isPublished(legacy, { date: "2026-06-29", reportTs: null, reportCount: 1 })).toBe(true);
  // 07-01 conflict: a legacy day entry does NOT cover a multi-report day's reports
  const conflicted: PublishedLog = { "2026-07-01": entry("2026-07-01", null) };
  expect(isPublished(conflicted, { date: "2026-07-01", reportTs: "1.0", reportCount: 2 })).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/published.test.ts` → FAIL.

- [ ] **Step 3: Implement** — per the Interfaces block:

```ts
import { reportKey } from "./fieldDayVerdict";

export interface PublishTarget { date: string; reportTs: string | null; reportCount: number }

export function isPublished(log: PublishedLog, target: PublishTarget): boolean {
  if (Object.prototype.hasOwnProperty.call(log, reportKey(target.date, target.reportTs))) return true;
  // A legacy bare-date entry is "the day's single report".
  return target.reportTs !== null && target.reportCount === 1 &&
    Object.prototype.hasOwnProperty.call(log, target.date);
}

export function recordPublished(log: PublishedLog, entry: PublishedEntry): PublishedLog {
  return { ...log, [reportKey(entry.date, entry.reportTs)]: entry };
}
```

`toEntry` adds `reportTs: r.reportTs ?? null`; `readPublished` keys `log[r.verdictKey]`; `writePublished` values add `reportTs: entry.reportTs, verdictKey: reportKey(entry.date, entry.reportTs)` with conflict target `[schema.published.period, schema.published.verdictKey]`. Update the header comment ("keyed by flight date" → "keyed by verdictKey").

- [ ] **Step 4: Run** — `npx vitest run lib/published.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(published): verdictKey-keyed published log with legacy bare-date reads`.

---

### Task 7: Publish formatting + driver (`lib/verdictPublish.ts`, `lib/publishVerdicts.ts`, `lib/outboundKeys.ts`)

**Files:**
- Modify: `lib/verdictPublish.ts` (`formatDayMessage` only), `lib/outboundKeys.ts` (`verdictKey`), `lib/publishVerdicts.ts`, `scripts/fieldPublishReport.ts`
- Test: `lib/verdictPublish.test.ts`, `scripts/fieldPublishReport.test.ts`

**Interfaces:**
- Consumes: `DayVerdict.reportTs/reportSeq/reportCount` (Task 2), `isPublished`/`recordPublished` (Task 6).
- Produces:
  - `formatDayMessage(day)` — unchanged signature; when `day.reportCount > 1` the date segment becomes `` `${dateWithWeekday(day.date)}, виїзд ${seq}/${count}${win}` `` where `win` = `` ` (${start}–${end})` `` if `deployWindow` present.
  - `outboundKeys.verdictKey(periodKey: string, date: string, reportTs?: string | null)` — appends `:${reportTs}` when present.
  - `publishSettledDays` posts per report; `PublishResult.posted/skipped` now contain `reportKey` strings.
  - `scripts/fieldPublishReport.ts` preview rows gain `reportTs`; `alreadyPublished` uses the new `isPublished` target.

- [ ] **Step 1: Write the failing tests**

`lib/verdictPublish.test.ts` (fixtures gain the three new DayVerdict fields — compiler-guided):

```ts
it("labels multi-report days «виїзд N/M (window)» and keeps single-report days byte-identical", () => {
  const base: DayVerdict = { /* reuse the file's REJECTED fixture */ date: "2026-07-01", reportTs: "2.0", reportSeq: 2, reportCount: 2, deployWindow: { start: "18:20", end: "20:10" }, deployMin: 110, /* ... */ };
  expect(formatDayMessage(base)).toContain("2026-07-01 (середа), виїзд 2/2 (18:20–20:10) — відхилено");
  const single: DayVerdict = { ...base, reportTs: "1.0", reportSeq: 1, reportCount: 1 };
  expect(formatDayMessage(single)).not.toContain("виїзд 1/1");
});
```

`scripts/fieldPublishReport.test.ts`: existing previews updated; add a case where a legacy `PublishedLog` bare-date entry marks a single-report day `alreadyPublished: true` while a 2-report day's rows are both `false`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/verdictPublish.test.ts scripts/fieldPublishReport.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`formatDayMessage` — replace `const date = dateWithWeekday(day.date);` with:

```ts
  const win = day.deployWindow ? ` (${day.deployWindow.start}–${day.deployWindow.end})` : "";
  const date = day.reportCount > 1
    ? `${dateWithWeekday(day.date)}, виїзд ${day.reportSeq}/${day.reportCount}${win}`
    : dateWithWeekday(day.date);
```

(All four status branches already interpolate `date`, so no other edits.)

`lib/outboundKeys.ts`:

```ts
export const verdictKey = (periodKey: string, date: string, reportTs?: string | null): string =>
  reportTs ? `verdict:${periodKey}:${date}:${reportTs}` : `verdict:${periodKey}:${date}`;
```

`lib/publishVerdicts.ts` loop body:

```ts
  for (const day of publishableDays(days)) {
    const target = { date: day.date, reportTs: day.reportTs, reportCount: day.reportCount };
    const label = reportKey(day.date, day.reportTs);
    if (isPublished(publishedLog, target)) { skipped.push(label); continue; }
    const text = formatDayMessage(day);
    const ts = await postMessage(channel.id, text, {
      key: verdictKey(key, day.date, day.reportTs), feature: "verdict", channel: channel.name, trigger,
    });
    publishedLog = recordPublished(publishedLog, {
      date: day.date, reportTs: day.reportTs, channel: channel.name, text,
      postedAt: new Date().toISOString(), ts,
    });
    await writePublished(period, publishedLog);
    posted.push(label);
    log(`field-publish: posted ${label} to #${channel.name} (ts ${ts})`);
  }
```

(import `reportKey` from `./fieldDayVerdict`.)

`scripts/fieldPublishReport.ts`: preview row adds `reportTs: d.reportTs` and `alreadyPublished: isPublished(log, { date: d.date, reportTs: d.reportTs, reportCount: d.reportCount })`.

- [ ] **Step 4: Run** — `npx vitest run lib/verdictPublish.test.ts scripts/fieldPublishReport.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(publish): per-report verdict messages, outbound keys, and idempotency`.

---

### Task 8: computeVerdicts per-report orchestration (`lib/computeVerdicts.ts`)

**Files:**
- Modify: `lib/computeVerdicts.ts`
- Test: extend `lib/fieldDayVerdict.test.ts`-style coverage only if a `lib/computeVerdicts.test.ts` exists; otherwise verify via Step 3's CLI run (the orchestration is server-only; its pieces are unit-tested in Tasks 1–4).

**Interfaces:**
- Consumes: `parseMonth` (Task 1), `mergeFlightDays` (Task 3), `deriveDatasetStatus/applyResolution` scope params + `correctionForReport` (Task 4).
- Produces: `VerdictReport.days` = one `DayVerdict` per report (shape consumed by Tasks 7/9/10 — already updated).

- [ ] **Step 1: Rewrite the day loop.** Replace `parsedByDate` + the `days` mapping (lines ~107–151) with:

```ts
  const parsedReports = parseMonth(fieldQaMessages, aliases);
  const corrections = await readRosterCorrections();

  // One row per Звіт (plus a synthetic reportTs-null row for a no-Звіт flight
  // day). Day-shared axes — video, airborne, dataset signal, drone report —
  // replicate onto every row of the date; deploy window + crew are per-report.
  const flightRows = mergeFlightDays(airborneByDate, parsedReports, period);
  const days: DayVerdict[] = flightRows.map((row) => {
    const date = row.date;
    const videoMinutes = Math.round((videoMinutesByDate.get(date) ?? 0) * 10) / 10;
    const windowEnd = addWorkingDays(date, GRACE_WORKING_DAYS);
    const datasetPosted = hasDatasetNotice(datasetMessages, date, windowEnd);
    const { status: datasetStatus, note: datasetNote } = deriveDatasetStatus(datasetPosted, date, resolutions, row.reportTs);
    const fqDay = fqDayByDate.get(date);
    const base = verdictForDay({
      flightDate: date,
      airborneMinutes: row.airborneMinutes,
      videoMinutes,
      datasetStatus,
      today,
      graceWorkingDays: GRACE_WORKING_DAYS,
      airborneReported: row.airborneReported,
      deployWindow: row.deployWindow,
      deployMin: row.deployMin,
      hasZvit: row.reportTs != null,
      reportTs: row.reportTs,
      reportSeq: row.reportSeq,
      reportCount: row.reportCount,
      ...(fqDay?.droneReport !== undefined ? { droneReportPresent: fqDay.droneReport.length > 0 } : {}),
    });
    const withNote = datasetNote ? { ...base, reasons: [...base.reasons, datasetNote] } : base;
    const resolved = applyResolution(withNote, resolutions);
    const eff = applyRosterCorrection(row.roster, true, correctionForReport(corrections, date, row.reportTs, row.reportCount));
    const drones = fqDay?.droneReport;
    return {
      ...resolved,
      roster: eff.roster,
      unknownInitials: row.unknownInitials,
      ...(drones && drones.length ? { droneReport: drones } : {}),
    };
  });
```

(imports: add `correctionForReport` from `./rosterCorrection`; drop the now-unused `parsedByDate` line.)

- [ ] **Step 2: Typecheck + full suite** — `npx tsc --noEmit && npm test`. Fix any remaining fixture compile errors from the `DayVerdict` shape change in OTHER test files mechanically (add `reportTs: null, reportSeq: 1, reportCount: 1` or a shared fixture helper).

- [ ] **Step 3: End-to-end sanity on the real bug** — Run:
`npm run field-verdict -- --start 2026-07-01 --end 2026-07-01 --format table`
Expected: **two rows** for 2026-07-01 — `#1/2` (deploy 220, ACCEPTED given video 142/153 + dataset ✓ + drone report) and `#2/2` (deploy 110, REJECTED «deployment 110m is under 3h»). Both carry the same airborne/video figures.

- [ ] **Step 4: June regression check** — Run:
`npm run field-verdict -- --start 2026-06-01 --end 2026-06-30 --format table`
Expected: same day set as the committed June report, every row `reportCount 1`, statuses unchanged. If any June date shows 2+ rows, STOP and inspect the mirror for a repost (the design says duplicates surface visibly — but a June regression must be reconciled with the operator before publish; do not `--write`).

- [ ] **Step 5: Commit** — `feat(verdict): compute one verdict per Звіт with day-shared axes`.

---

### Task 9: Instruction/approval writers carry report scope

**Files:**
- Modify: `lib/applyApproval.ts`, `lib/applyRosterCorrection.ts`, `lib/applyInstruction.ts`, `lib/backfillPublished.ts`
- Test: `lib/backfillPublished.test.ts` (+ existing `applyInstruction.test.ts` fixtures updated for `PublishedEntry.reportTs`)

**Interfaces:**
- Consumes: `PublishedEntry.reportTs` (Task 6), `Resolution.reportTs`/`RosterCorrection.reportTs` (Task 4), `reportKey` (Task 2).
- Produces: every writer scopes by the entry's report; all outbound dedup keys that took a `date` now take `reportKey(entry.date, entry.reportTs)` (no key-builder signature changes — the composite string is passed as the existing `date` param).

- [ ] **Step 1: `lib/applyApproval.ts`**
  - `amendPublishedVerdict`: `approvalOutboundKeys(reportKey(entry.date, entry.reportTs), decision)`; replace the final `writePublished(period, { [entry.date]: {...} })` with `writePublished(period, recordPublished({}, { ...entry, override: { decision, by, ackedAt: new Date().toISOString() } }))` (import `recordPublished`).
  - `applyApproverDecision`: `upsertResolution({ date: entry.date, reportTs: entry.reportTs ?? "", axis: "day", ... })` — a per-report entry vetoes/rescues only its report; a legacy entry stays day-wide.

- [ ] **Step 2: `lib/applyRosterCorrection.ts`**
  - `upsertRosterCorrection({ date: entry.date, reportTs: entry.reportTs ?? "", ... })`.
  - Keys: `rosterEditKey(reportKey(entry.date, entry.reportTs), contentRev(updatedText))`, same for `rosterAckKey`.
  - Final write: `writePublished(period, recordPublished({}, { ...entry, text: updatedText }))`.

- [ ] **Step 3: `lib/applyInstruction.ts`**
  - `ack(...)`: `instructionAckKey(reportKey(entry.date, entry.reportTs), axis, contentRev(text))`.
  - dataset/video axes: leave `upsertResolution` **without** `reportTs` (day-wide — the spec's day-scoped axes). Dataset-decline amend check becomes `dayRescuedByException(entry.date, await readResolutions(), entry.reportTs ?? null)`. Add a comment: a dataset decline machine-rejects ALL of the day's reports; only THIS thread's message is amended here — sibling reports update on the next verdict recompute (pre-existing behavior for un-amended messages).
  - airborne axis: unchanged (`airborne_overrides` stays date-keyed/day-wide).
  - The ack text for day-scoped axes gains the day-wide note when the day is multi-report is NOT knowable here (entry has no reportCount) — skip; the existing wording already names the date.

- [ ] **Step 4: `lib/backfillPublished.ts`** — the verdict lookup `verdictByDate[entry.date]` must resolve per-report: build `const rowsByKey = new Map(report.days.map((d) => [reportKey(d.date, d.reportTs), d]))` plus `const rowsByDate = new Map<string, DayVerdict[]>()` grouping; lookup = `rowsByKey.get(reportKey(entry.date, entry.reportTs)) ?? (entry.reportTs === null && (rowsByDate.get(entry.date) ?? []).length === 1 ? rowsByDate.get(entry.date)![0] : undefined)`. A legacy entry on a multi-report day (the 07-01 conflict) gets `undefined` → the existing "no verdict for this entry" skip path. Add a test in `lib/backfillPublished.test.ts` for exactly that skip.

- [ ] **Step 5: Typecheck + targeted tests** — `npx tsc --noEmit && npx vitest run lib/backfillPublished.test.ts lib/applyInstruction.test.ts lib/instructionOutcome.test.ts`
Expected: PASS. Fix `PublishedEntry` fixtures (`reportTs: null`) wherever the compiler complains (includes `scripts/fieldApprovalsReport.test.ts`, `scripts/fieldInstructionsReport.test.ts`, `scripts/fieldBackfillReport.test.ts` fixtures and the webhook route's types — mechanical).

- [ ] **Step 6: Commit** — `feat(instructions): approver writes scope to the replied report's thread`.

---

### Task 10: Bonus pays per accepted report

**Files:**
- Modify: `lib/fieldBonus.ts`, `lib/computeBonuses.ts`, `lib/bonusNotified.ts`, `scripts/field-bonus.ts`, `scripts/fieldBonusReport.ts`
- Test: `lib/fieldBonus.test.ts`, `lib/computeBonuses.test.ts`

**Interfaces:**
- Consumes: per-report `VerdictReport.days` (Task 8), `correctionForReport` (Task 4), `reportKey` (Task 2), `bonusNotified` schema (Task 5).
- Produces:
  - `QualifiedDay` gains `reportTs: string | null; reportCount: number`.
  - `DayBonus`, `PendingDay`, and `voidedDays` entries gain `reportTs: string | null`.
  - `lib/bonusNotified.ts`: `NotifiedLog` keyed by `verdictKey`; `isThreadNotified/isDmSent/recordThread/recordDm` take `(log, key, ...)` where `key = reportKey(date, reportTs)` — callers build it; `NotifiedEntry` gains `reportTs: string | null`; read/write use the `verdictKey` column. Legacy bare-date rows read as-is (their key IS the bare date, which matches `reportKey(date, null)` — and June days are single-report, so the publisher-thread lookup by date#ts falls back like `isPublished`: add `isThreadNotifiedFor(log, target: { date; reportTs; reportCount })` mirroring Task 6's fallback, same for DMs).

- [ ] **Step 1: Write the failing tests**

`lib/fieldBonus.test.ts`:

```ts
it("pays a person once per ACCEPTED report — twice on a two-report day", () => {
  const day = (reportTs: string, status: VerdictStatus, roster: string[], deployMin: number): QualifiedDay =>
    ({ date: "2026-07-01", reportTs, reportCount: 2, status, roster, unknownInitials: [], deployMin, videoMin: 142, start: "12:30", reasons: [], flew: true });
  const r = computeBonuses({
    period: { start: "2026-07-01", end: "2026-07-31" },
    days: [day("1.0", "ACCEPTED", ["Андріан", "Надія"], 220), day("2.0", "ACCEPTED", ["Влад", "Надія"], 110)],
    losses: [],
  });
  expect(r.people.find((p) => p.name === "Надія")?.trips).toBe(2);
  expect(r.people.find((p) => p.name === "Андріан")?.trips).toBe(1);
});

it("a REJECTED second report voids only itself", () => {
  /* same fixture, second day REJECTED */
  expect(r.voidedDays).toEqual([{ date: "2026-07-01", reportTs: "2.0", roster: ["Влад", "Надія"], reason: expect.any(String) }]);
  expect(r.people.find((p) => p.name === "Надія")?.trips).toBe(1);
});
```

`lib/computeBonuses.test.ts`: update the verdict-days fixtures for the new fields; assert `start` (early bonus) is taken from the row's own Звіт (mock `parseMonth` output with two reports, different `start`).

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/fieldBonus.test.ts lib/computeBonuses.test.ts` → FAIL.

- [ ] **Step 3: Implement `lib/fieldBonus.ts`**
  - Add the interface fields (Interfaces block above).
  - Replace `const correctionFor = (date) => corrections.find((c) => c.date === date);` usages with `correctionForReport(corrections, q.date, q.reportTs, q.reportCount)` (import from `./rosterCorrection`); in the tally loop use `correctionForReport(corrections, d.date, d.reportTs, d.reportCount ?? 1)` — carry `reportCount` on `DayBonus` too if needed, or close over the `QualifiedDay` by index (`days` and `qualified` are parallel — prefer carrying `reportTs`/`reportCount` on `DayBonus`).
  - Trip keys: `groupKeyByDate` → `groupKeyByTrip = new Map<string, string>()` keyed by `reportKey(d.date, d.reportTs)`; `tripsByGroup` accumulates those keys (lexicographic sort still orders by date-first since the key starts with the date); the loss-window check becomes `window.filter((k) => lostDates.has(k.slice(0, 10))).length`.
  - `days.push`/`pendingDays.push`/`voidedDays` mapping: add `reportTs`.

- [ ] **Step 4: Implement `lib/computeBonuses.ts`**

```ts
  const reports = parseMonth(messages, aliases);
  const parsedByReportTs = new Map(reports.map((r) => [r.reportTs, r]));
  // losses loop unchanged (per report already — two same-date crashes dedup by date downstream)
  const days: QualifiedDay[] = verdicts.days.map((d) => {
    const parsed = d.reportTs ? parsedByReportTs.get(d.reportTs) : undefined;
    return {
      date: d.date,
      reportTs: d.reportTs,
      reportCount: d.reportCount,
      status: d.status,
      roster: d.roster,
      unknownInitials: d.unknownInitials,
      deployMin: d.deployMin ?? parsed?.deployMin ?? null,
      videoMin: roundVideoMin(d.videoMinutes),
      start: parsed?.start ?? null,
      reasons: d.reasons,
      flew: d.airborneMinutes > 0 || !d.airborneReported || (d.deployMin ?? parsed?.deployMin ?? null) != null,
    };
  });
```

- [ ] **Step 5: `lib/bonusNotified.ts` + `scripts/field-bonus.ts` + `scripts/fieldBonusReport.ts`** — re-key per the Interfaces block (mirror Task 6's pattern exactly: key = `reportKey`, legacy fallback helper takes `{date, reportTs, reportCount}`); the notify loop resolves each settled item's thread via the published entry for `reportKey(item.date, item.reportTs)` (fallback: bare date when `reportCount === 1`) and keys `bonusThreadKey(reportKey(item.date, item.reportTs))` / `bonusDmKey(reportKey(...), slackId)`. `toCsv` in `scripts/fieldBonusReport.ts` gains a `reportTs` column on the days rows.

- [ ] **Step 6: Run** — `npx vitest run lib/fieldBonus.test.ts lib/computeBonuses.test.ts scripts/fieldBonusReport.test.ts && npx tsc --noEmit` → PASS.
- [ ] **Step 7: Commit** — `feat(bonus): pay per accepted report; re-key notifications by verdictKey`.

---

### Task 11: Surface sweep (webhook, CLIs, web, nightly)

**Files:**
- Modify (compile-driven; expected set): `app/api/slack/events/route.ts`, `scripts/field-publish.ts`, `scripts/field-backfill.ts`, `scripts/field-instructions.ts`, `scripts/fieldInstructionsReport.ts`, `scripts/field-approvals.ts`, `scripts/field-roster.ts`, `lib/instructionsView.ts`, `app/api/instructions/route.ts`, `lib/runNightly.ts`, `lib/crewImport.ts`, any `app/(dashboard)` verdict/bonus render typed on `DayVerdict`.

- [ ] **Step 1: Full typecheck** — `npx tsc --noEmit`. Fix every error using ONLY these patterns (no new behavior):
  - `PublishedEntry` construction → add `reportTs: null` (legacy/manual paths) or thread the real value.
  - `isPublished(log, date)` call sites → `isPublished(log, { date: d.date, reportTs: d.reportTs, reportCount: d.reportCount })`.
  - Display code (instructions view, dashboards, `--list`) → render `reportTs`/`reportSeq/reportCount` where the row type surfaces them; a bare `d.date` label becomes `reportKey(d.date, d.reportTs)` in logs and `«виїзд N/M»` in human tables only when `reportCount > 1`.
  - `field-instructions` manual mode (`--date` without a report) → day-wide writes (`reportTs: ""` / `null` for published lookups with `reportCount` unknown → look up the day's published entries and refuse with a clear error if the date has MULTIPLE published reports and no `--report <ts>` was given; add the optional `--report <ts>` flag parse to target one).
  - `lib/crewImport.ts` (sheet + live crew) → writes stay day-wide (`reportTs` omitted); no change beyond types.
- [ ] **Step 2: Full suite + build** — `npm test && npm run build` → PASS/green.
- [ ] **Step 3: Dry-run the pipelines** —
  - `npm run field-publish -- --start 2026-06-01 --end 2026-06-30` → every June day `alreadyPublished` (legacy fallback works), nothing to post.
  - `npm run field-publish -- --start 2026-07-01 --end 2026-07-04` → exactly the two 07-01 per-report messages queued (dry-run prints, sends nothing); eyeball the «виїзд 1/2 (12:30–16:10)» / «виїзд 2/2 (18:20–20:10)» labels.
  - `npm run field-bonus -- --start 2026-07-01 --end 2026-07-04` → Надія appears with the report-1 trip; report 2 in `voidedDays`.
- [ ] **Step 4: Commit** — `feat(field): per-report surfaces — webhook, CLIs, web renders`.

---

### Task 12: Rollout (migration → deploy → 07-01 reconciliation)

This task is operational; do it with the operator awake, outside the 06:00–07:00 UTC cron window.

- [ ] **Step 0: Decide the stale day-wide exceptions (OPERATOR).** The resolutions store has `report_ts=''` (day-wide) `accepted_exception` rows for **2026-07-01 and 2026-07-02** (both by Oleksandr K, recorded 07-04 against the WRONG merged verdicts — the 07-01 one explicitly forgave "under 3 hours" while the bot was misreporting 110 min for a 3г40хв trip). Day-wide scope rescues the genuinely-short second reports (07-01 #2/2: 110 min → ACCEPTED_EXCEPTION → PAYS). Options per day: (a) delete the row → machine gate decides (report 2 auto-REJECTs); (b) re-scope `report_ts` to report 1's Звіт ts → report 1 keeps the exception, report 2 auto-REJECTs; (c) keep day-wide → both reports pay. Apply via SQL before Step 3's recompute.
- [ ] **Step 1: Apply the migration — as raw SQL, NOT `drizzle-kit migrate`.** The `__drizzle_migrations` journal has pre-existing drift (9 recorded vs 11 files), so the runner is unreliable here. Apply `drizzle/0011_new_blindfold.sql` statement-by-statement inside one transaction against the prod Neon DB (exactly as validated on the verification branch `br-spring-frost-aso8otra`). Verify: `select conname from pg_constraint where conrelid='published'::regclass and contype='p';` → `published_period_verdict_key_pk`; `select count(*) from published where verdict_key is null;` → 0.
- [ ] **Step 2: Push to main immediately** (Vercel auto-deploys). The window between migration and deploy is the only period where the OLD code's published/resolutions upserts can fail — minutes, acceptable; the nightly is hours away.
- [ ] **Step 3: Recompute + publish July** — `npm run slack-sync && npm run field-qa -- --start 2026-07-01 --end 2026-07-04 --write && npm run field-verdict -- --start 2026-07-01 --end 2026-07-04 --write`, then `npm run field-publish -- --start 2026-07-01 --end 2026-07-04` (dry-run), review, then `--publish --channel field-qa`. Expected posts: 07-01 report 1 (✅ прийнято, виїзд 1/2) and 07-01 report 2 (⛔ відхилено, виїзд 2/2) — plus any other settled July days.
- [ ] **Step 4: Strike the stale merged-day messages manually — 07-01 AND 07-02.** Both dates have legacy bare-date published entries pointing at wrong merged verdicts (07-02 also split into two reports). Edit each Slack message (one-off `updateMessage` or Slack UI) to `~<old text>~\nЗастаріле — актуальні вердикти за цей день нижче в каналі (по одному на виїзд).` Do NOT delete the DB rows (they anchor the old threads' `findPublishedByTs`).
- [ ] **Step 5: Verify the nightly is clean** — next morning check `/api/cron/field-nightly` output (or run `npm run field-nightly` locally, dry): no re-posts, no duplicate 07-01 entries.
- [ ] **Step 6: Update docs** — CLAUDE.md field-verdict/field-publish/field-bonus bullets gain one sentence each: verdicts/pay are per Звіт (multi-report days post one message per report, «виїзд N/M»); update the memory file `multi-report-flight-days.md` (impl shipped). Commit.

## Self-Review Notes

- Spec coverage: parser (T1), verdict model + key (T2/T3/T8), publishing + label + idempotency (T6/T7), instructions scoping incl. day-scoped axes and sheet-import skip (T4/T9/T11), bonus per report incl. Надія×2 and voided report entries (T10), migration/back-compat + 07-01 reconciliation (T5/T12), June regression guard (T8 Step 4, T11 Step 3).
- Type consistency: `reportKey` lives in `lib/fieldDayVerdict.ts`; `PublishTarget`-style lookups always `{date, reportTs, reportCount}`; store scope fields are `reportTs?: string` with `""` = day-wide on resolutions/corrections, `string | null` on verdict/published/bonus rows.
- Known limitation (accepted in spec): a dataset decline amends only the thread it was issued in; sibling report messages update on recompute. A day with only window-less Звіт and no airborne still vanishes (pre-existing, out of scope).
