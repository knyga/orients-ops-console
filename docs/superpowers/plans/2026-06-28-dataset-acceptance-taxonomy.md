# Dataset Acceptance Taxonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the boolean `datasetPosted` on a field-day verdict with a first-class `DatasetStatus` (`POSTED | WAIVED | MISSING | DECLINED`), so a stated no-dataset reason auto-validates a day and admins can veto a weak reason.

**Architecture:** The dataset axis becomes its own status, derived in `computeVerdicts` from the live `#datasets` notice plus axis-scoped resolutions, then composed by the pure `verdictForDay`. Resolutions gain an `axis` (`dataset | video | day`) so a dataset waiver and a video exception no longer collide; `field-remember` tags the axis from the ask's gap type, `field-approvals` writes whole-day overrides. Surfaces (CLI table/CSV, Slack post, web view) render the new status.

**Tech Stack:** TypeScript (strict), Next.js 16 App Router, Drizzle ORM + Neon Postgres, Vitest. Pure logic lives in `lib/`; server-only modules import `server-only`; CLIs run under `--conditions=react-server`.

**Spec:** `docs/superpowers/specs/2026-06-28-dataset-acceptance-taxonomy-design.md`

## Global Constraints

- TypeScript `strict` is on; keep `lib/fieldDayVerdict.ts`, `lib/resolutions.ts` (apply/derive logic), `lib/askGaps.ts`, and `scripts/fieldVerdictReport.ts` **pure** (no React/Next/fs/server-only imports) — they are unit-tested.
- `lib/computeVerdicts.ts`, `lib/applyAnswer.ts`, `lib/applyApproval.ts` are `server-only` — do not import them from client code; verify them via `npx tsc --noEmit` + a CLI run, not unit tests.
- `DatasetStatus` values are exactly `"POSTED" | "WAIVED" | "MISSING" | "DECLINED"` (uppercase).
- `ResolutionAxis` values are exactly `"dataset" | "video" | "day"` (lowercase); legacy rows backfill to `"day"`.
- Slack markers (Ukrainian — `lib/verdictPublish.ts` is team-facing) verbatim: `POSTED → "датасет ✓"`, `WAIVED → "датасет 📝 виняток"`, `MISSING → "без датасету"`, `DECLINED → "датасет ⛔ відхилено"`. The CLI table/CSV and web view stay English/internal (icons only).
- Run a single test file with `npx vitest run <path>`; the whole suite with `npm test`; type-check with `npx tsc --noEmit`.
- Commit after each task.

## File Structure

- `lib/fieldDayVerdict.ts` — **modify**: add `DatasetStatus`; swap `datasetPosted: boolean` → `datasetStatus: DatasetStatus` on `VerdictInput` + `DayVerdict`; rewrite the status decision.
- `lib/resolutions.ts` — **modify**: add `ResolutionAxis` + `axis` field; axis-aware `upsertResolution` + `applyResolution`; new `deriveDatasetStatus`.
- `lib/schema.ts` + `drizzle/` — **modify/create**: add `axis` column, composite PK `(date, axis)`, backfill migration.
- `lib/computeVerdicts.ts` — **modify**: derive `datasetStatus`, pass it to `verdictForDay`, append the verbatim reason.
- `lib/askGaps.ts` — **modify**: gate the `no_dataset` question on `datasetStatus === "MISSING"`.
- `scripts/fieldVerdictReport.ts` — **modify**: CSV column `datasetPosted` → `datasetStatus`; table DS icon.
- `lib/verdictPublish.ts` — **modify**: dataset marker in `formatDayMessage`.
- `app/(dashboard)/field-verdict/page.tsx` — **modify**: dataset-status cell.
- `lib/applyAnswer.ts` — **modify**: set resolution `axis` from `record.gapType`.
- `lib/applyApproval.ts` — **modify**: set resolution `axis: "day"`.

---

## Task 1: `DatasetStatus` enum + pure verdict logic

**Files:**
- Modify: `lib/fieldDayVerdict.ts`
- Test: `lib/fieldDayVerdict.test.ts`

**Interfaces:**
- Produces: `export type DatasetStatus = "POSTED" | "WAIVED" | "MISSING" | "DECLINED"`; `VerdictInput.datasetStatus: DatasetStatus` (replaces `datasetPosted`); `DayVerdict.datasetStatus: DatasetStatus` (replaces `datasetPosted`); `verdictForDay(input: VerdictInput): DayVerdict`.

- [ ] **Step 1: Update the existing tests to the new field, and add the new cases**

Open `lib/fieldDayVerdict.test.ts`. Every fixture/assertion that passes `datasetPosted: true/false` to `verdictForDay` or reads it off the result must change to `datasetStatus`. The mapping for existing tests: `datasetPosted: true` → `datasetStatus: "POSTED"`; `datasetPosted: false` → `datasetStatus: "MISSING"`. Then append these new cases (adjust the imported helper/fixture names to match the file's existing style):

```ts
import { verdictForDay } from "./fieldDayVerdict";

const base = {
  flightDate: "2026-06-10",
  airborneMinutes: 100,
  videoMinutes: 60, // 60% ≥ 50% → videoOk
  today: "2026-06-30", // well after grace
  graceWorkingDays: 3,
};

it("WAIVED + video OK → ACCEPTED (a stated reason validates the dataset axis)", () => {
  const v = verdictForDay({ ...base, datasetStatus: "WAIVED" });
  expect(v.status).toBe("ACCEPTED");
  expect(v.datasetStatus).toBe("WAIVED");
});

it("DECLINED → REJECTED regardless of video", () => {
  const v = verdictForDay({ ...base, datasetStatus: "DECLINED" });
  expect(v.status).toBe("REJECTED");
  expect(v.reasons.some((r) => /declined/i.test(r))).toBe(true);
});

it("MISSING after grace → NEEDS_REVIEW", () => {
  const v = verdictForDay({ ...base, datasetStatus: "MISSING" });
  expect(v.status).toBe("NEEDS_REVIEW");
});

it("MISSING within grace → PENDING", () => {
  const v = verdictForDay({ ...base, datasetStatus: "MISSING", today: "2026-06-10" });
  expect(v.status).toBe("PENDING");
});

it("WAIVED but video short, after grace → NEEDS_REVIEW (dataset OK, video axis fails)", () => {
  const v = verdictForDay({ ...base, datasetStatus: "WAIVED", videoMinutes: 10 });
  expect(v.status).toBe("NEEDS_REVIEW");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/fieldDayVerdict.test.ts`
Expected: FAIL — `datasetStatus` is not on the type yet / `verdictForDay` still keys off `datasetPosted`.

- [ ] **Step 3: Implement the new types and decision**

In `lib/fieldDayVerdict.ts` replace the `VerdictStatus` type line through the end of `verdictForDay` with:

```ts
export type VerdictStatus = "ACCEPTED" | "PENDING" | "NEEDS_REVIEW" | "ACCEPTED_EXCEPTION" | "REJECTED";

/** The dataset axis outcome for a flight day (see the dataset-acceptance spec). */
export type DatasetStatus = "POSTED" | "WAIVED" | "MISSING" | "DECLINED";

export interface VerdictInput {
  flightDate: string;        // YYYY-MM-DD
  airborneMinutes: number;
  videoMinutes: number;
  datasetStatus: DatasetStatus;
  today: string;             // YYYY-MM-DD
  graceWorkingDays: number;
}

export interface DayVerdict {
  date: string;
  status: VerdictStatus;
  airborneMinutes: number;
  videoMinutes: number;
  ratio: number | null;
  datasetStatus: DatasetStatus;
  withinGrace: boolean;
  reasons: string[];
}

export function verdictForDay(input: VerdictInput): DayVerdict {
  const { flightDate, airborneMinutes, videoMinutes, datasetStatus, today, graceWorkingDays } = input;
  const ratio = airborneMinutes > 0 ? videoMinutes / airborneMinutes : null;
  const videoOk = ratio !== null && ratio >= MIN_RATIO;
  const datasetOk = datasetStatus === "POSTED" || datasetStatus === "WAIVED";
  const windowEnd = addWorkingDays(flightDate, graceWorkingDays);
  const withinGrace = today <= windowEnd;

  const reasons: string[] = [];
  if (!videoOk) {
    reasons.push(
      ratio === null
        ? "no airborne time recorded for the day"
        : `video ${videoMinutes.toFixed(0)}m is ${(ratio * 100).toFixed(0)}% of airborne ${airborneMinutes.toFixed(0)}m (< 50%)`,
    );
  }
  if (datasetStatus === "MISSING") reasons.push("no #datasets notice for the day");
  if (datasetStatus === "WAIVED") reasons.push("no dataset — reason accepted (waived)");
  if (datasetStatus === "DECLINED") reasons.push("dataset reason declined by an admin");

  let status: VerdictStatus;
  if (datasetStatus === "DECLINED") {
    status = "REJECTED";
  } else if (videoOk && datasetOk) {
    status = "ACCEPTED";
  } else if (withinGrace) {
    status = "PENDING";
  } else {
    status = "NEEDS_REVIEW";
  }

  return { date: flightDate, status, airborneMinutes, videoMinutes, ratio, datasetStatus, withinGrace, reasons };
}
```

Leave the file's top doc comment and the `MIN_RATIO` / `addWorkingDays` imports as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/fieldDayVerdict.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/fieldDayVerdict.ts lib/fieldDayVerdict.test.ts
git commit -m "feat(field-verdict): DatasetStatus enum + dataset-aware verdict logic"
```

---

## Task 2: Axis-scoped resolutions + `deriveDatasetStatus`

**Files:**
- Modify: `lib/resolutions.ts`
- Test: `lib/resolutions.test.ts`

**Interfaces:**
- Consumes: `DatasetStatus`, `DayVerdict` from `./fieldDayVerdict`.
- Produces:
  - `export type ResolutionAxis = "dataset" | "video" | "day"`
  - `Resolution.axis: ResolutionAxis` (new required field)
  - `deriveDatasetStatus(datasetPosted: boolean, date: string, resolutions: Resolution[]): { status: DatasetStatus; note?: string }`
  - `applyResolution(verdict: DayVerdict, resolutions: Resolution[]): DayVerdict` (now only the `video`/`day` axes)
  - `upsertResolution(resolution: Resolution): Promise<void>` (conflict target `(date, axis)`)

- [ ] **Step 1: Write/extend the failing tests**

In `lib/resolutions.test.ts`, update any existing `Resolution` fixtures to include `axis` (existing day-level cases → `axis: "day"`). Then add:

```ts
import { deriveDatasetStatus, applyResolution, type Resolution } from "./resolutions";

const R = (over: Partial<Resolution>): Resolution => ({
  date: "2026-06-10",
  axis: "dataset",
  decision: "accepted_exception",
  note: "fog, no flight worth a dataset",
  source: "slack",
  recordedAt: "2026-06-12T00:00:00.000Z",
  ...over,
});

describe("deriveDatasetStatus", () => {
  it("posted notice → POSTED", () => {
    expect(deriveDatasetStatus(true, "2026-06-10", []).status).toBe("POSTED");
  });
  it("no notice, dataset-axis exception → WAIVED with the verbatim note", () => {
    const d = deriveDatasetStatus(false, "2026-06-10", [R({})]);
    expect(d.status).toBe("WAIVED");
    expect(d.note).toContain("fog");
  });
  it("no notice, dataset-axis rejection → DECLINED", () => {
    expect(deriveDatasetStatus(false, "2026-06-10", [R({ decision: "rejected" })]).status).toBe("DECLINED");
  });
  it("no notice, nothing recorded → MISSING", () => {
    expect(deriveDatasetStatus(false, "2026-06-10", []).status).toBe("MISSING");
  });
  it("a video-axis exception does NOT waive the dataset", () => {
    expect(deriveDatasetStatus(false, "2026-06-10", [R({ axis: "video" })]).status).toBe("MISSING");
  });
  it("a day-axis exception waives the dataset (whole-day forgiveness)", () => {
    expect(deriveDatasetStatus(false, "2026-06-10", [R({ axis: "day" })]).status).toBe("WAIVED");
  });
  it("posted but day-axis rejected → still POSTED here (day veto handled by applyResolution)", () => {
    expect(deriveDatasetStatus(true, "2026-06-10", [R({ axis: "day", decision: "rejected" })]).status).toBe("POSTED");
  });
});

describe("applyResolution (video/day axes only)", () => {
  const verdict = {
    date: "2026-06-10", status: "NEEDS_REVIEW" as const, airborneMinutes: 100,
    videoMinutes: 10, ratio: 0.1, datasetStatus: "WAIVED" as const, withinGrace: false, reasons: [],
  };
  it("video-axis exception flips NEEDS_REVIEW → ACCEPTED_EXCEPTION", () => {
    const out = applyResolution(verdict, [R({ axis: "video" })]);
    expect(out.status).toBe("ACCEPTED_EXCEPTION");
  });
  it("day-axis rejection vetoes to REJECTED", () => {
    const out = applyResolution(verdict, [R({ axis: "day", decision: "rejected" })]);
    expect(out.status).toBe("REJECTED");
  });
  it("a dataset-axis resolution is ignored here (it drives the dataset status, not the overlay)", () => {
    const out = applyResolution({ ...verdict, status: "ACCEPTED" }, [R({ axis: "dataset" })]);
    expect(out.status).toBe("ACCEPTED");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/resolutions.test.ts`
Expected: FAIL — `deriveDatasetStatus` undefined; `axis` not on `Resolution`.

- [ ] **Step 3: Implement axis support**

In `lib/resolutions.ts`:

(a) Add the type + extend the interface (after the existing `ResolutionDecision` line):

```ts
export type ResolutionDecision = "accepted_exception" | "rejected";
export type ResolutionAxis = "dataset" | "video" | "day";

export interface Resolution {
  date: string;                     // YYYY-MM-DD flight day
  axis: ResolutionAxis;             // what the decision is about (dataset | video | whole day)
  decision: ResolutionDecision;     // accepted_exception (forgive) | rejected (veto)
  note: string;
  source: string;                   // permalink or "manual"
  recordedAt: string;               // ISO
  /** Who decided (e.g. an approver's name), when applicable. */
  by?: string;
}
```

(b) Map the column in `toResolution` (legacy rows have null `axis` → `"day"`):

```ts
function toResolution(r: typeof schema.resolutions.$inferSelect): Resolution {
  return {
    date: r.date,
    axis: (r.axis as ResolutionAxis | null) ?? "day",
    decision: r.decision as ResolutionDecision,
    note: r.note,
    source: r.source,
    recordedAt: r.recordedAt,
    ...(r.by != null ? { by: r.by } : {}),
  };
}
```

(c) Persist `axis` and key the upsert on `(date, axis)`:

```ts
export async function upsertResolution(resolution: Resolution): Promise<void> {
  const values = {
    date: resolution.date,
    axis: resolution.axis,
    decision: resolution.decision,
    note: resolution.note,
    source: resolution.source,
    by: resolution.by ?? null,
    recordedAt: resolution.recordedAt,
  };
  await db
    .insert(schema.resolutions)
    .values(values)
    .onConflictDoUpdate({ target: [schema.resolutions.date, schema.resolutions.axis], set: values });
}
```

(d) Add `deriveDatasetStatus` and rewrite `applyResolution`. Add the `DatasetStatus` import to the existing type import:

```ts
import type { DatasetStatus, DayVerdict } from "./fieldDayVerdict";
```

```ts
/**
 * Derive the dataset axis status from the live #datasets signal + the dataset-
 * scoped (or whole-day) resolutions. A stated reason WAIVES; an admin veto on a
 * day with no posting DECLINES. A genuine posting wins (a posted-but-rejected day
 * stays POSTED here — the day-level veto is applied separately). Pure.
 */
export function deriveDatasetStatus(
  datasetPosted: boolean,
  date: string,
  resolutions: Resolution[],
): { status: DatasetStatus; note?: string } {
  const forDate = resolutions.filter(
    (r) => r.date === date && (r.axis === "dataset" || r.axis === "day"),
  );
  const rejected = forDate.find((r) => r.decision === "rejected");
  const exception = forDate.find((r) => r.decision === "accepted_exception");

  if (!datasetPosted && rejected) {
    const who = rejected.by ? ` (${rejected.by})` : "";
    return { status: "DECLINED", note: `dataset reason declined${who}: ${rejected.note}` };
  }
  if (datasetPosted) return { status: "POSTED" };
  if (exception) {
    const who = exception.by ? ` (${exception.by})` : "";
    return { status: "WAIVED", note: `dataset waived${who}: ${exception.note}` };
  }
  return { status: "MISSING" };
}

/**
 * Apply the VIDEO/DAY-axis overlay to a verdict (pure). The dataset axis is
 * handled by deriveDatasetStatus + verdictForDay; here we only honour exceptions
 * and vetoes that target the video gate or the whole day:
 *  - a `rejected` (video|day) is an authoritative veto → REJECTED from ANY status.
 *  - an `accepted_exception` (video|day) forgives a flagged miss → ACCEPTED_EXCEPTION,
 *    but only from NEEDS_REVIEW (never upgrades an already-good day).
 */
export function applyResolution(verdict: DayVerdict, resolutions: Resolution[]): DayVerdict {
  const forDate = resolutions.filter(
    (r) => r.date === verdict.date && (r.axis === "video" || r.axis === "day"),
  );
  const rejected = forDate.find((r) => r.decision === "rejected");
  if (rejected) {
    const who = rejected.by ? ` (${rejected.by})` : "";
    return { ...verdict, status: "REJECTED", reasons: [...verdict.reasons, `rejected${who}: ${rejected.note}`] };
  }
  const exception = forDate.find((r) => r.decision === "accepted_exception");
  if (exception && verdict.status === "NEEDS_REVIEW") {
    const who = exception.by ? ` (${exception.by})` : "";
    return { ...verdict, status: "ACCEPTED_EXCEPTION", reasons: [...verdict.reasons, `exception${who}: ${exception.note}`] };
  }
  return verdict;
}
```

Delete the now-unused `resolutionFor` export if nothing else imports it (`grep -rn "resolutionFor" lib scripts app` — at plan time only `applyResolution` used it). If something does import it, leave it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/resolutions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/resolutions.ts lib/resolutions.test.ts
git commit -m "feat(field-verdict): axis-scoped resolutions + deriveDatasetStatus"
```

---

## Task 3: DB migration — `axis` column + composite PK

**Files:**
- Modify: `lib/schema.ts`
- Create: a generated migration under `drizzle/` (via `npm run db:generate`)

**Interfaces:**
- Consumes: the `schema.resolutions` table referenced by `lib/resolutions.ts`.
- Produces: `resolutions(date, axis, decision, note, source, by, recorded_at)` with PK `(date, axis)`.

- [ ] **Step 1: Update the Drizzle schema**

In `lib/schema.ts`, replace the `resolutions` table definition with:

```ts
/** Durable human resolutions (exceptions / vetoes), keyed by (flight date, axis). */
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
  },
  (t) => [primaryKey({ columns: [t.date, t.axis] })],
);
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new file `drizzle/0001_*.sql` is created. Open it and confirm it (a) adds the `axis` column with default `'day'`, and (b) recreates the primary key as `(date, axis)`. If drizzle-kit emits an interactive prompt about the PK change, the generated SQL must end up adding the column then redefining the PK; a hand-correct version is:

```sql
ALTER TABLE "resolutions" ADD COLUMN "axis" text DEFAULT 'day' NOT NULL;
ALTER TABLE "resolutions" DROP CONSTRAINT "resolutions_pkey";
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_date_axis_pk" PRIMARY KEY("date","axis");
```

Existing rows take the column default `'day'`, preserving today's whole-day semantics — no data backfill step needed.

- [ ] **Step 3: Apply the migration**

Run: `npm run db:migrate`
Expected: applies cleanly (needs `POSTGRES_URL_NON_POOLING`/`POSTGRES_URL` in `.env`/`.env.local`). If no DB is reachable in this environment, skip the apply and note it — the SQL is committed for the deploy to run.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (the `axis` column now exists for `lib/resolutions.ts`).

- [ ] **Step 5: Commit**

```bash
git add lib/schema.ts drizzle/
git commit -m "feat(db): resolutions.axis column + composite (date,axis) primary key"
```

---

## Task 4: Wire `datasetStatus` through `computeVerdicts`

**Files:**
- Modify: `lib/computeVerdicts.ts`

**Interfaces:**
- Consumes: `deriveDatasetStatus`, `applyResolution`, `readResolutions` from `./resolutions`; `verdictForDay` from `./fieldDayVerdict`; `hasDatasetNotice` from `./datasetNotice`.

- [ ] **Step 1: Update the per-day loop**

In `lib/computeVerdicts.ts`, change the import on the resolutions line to include `deriveDatasetStatus`:

```ts
import { applyResolution, deriveDatasetStatus, readResolutions } from "./resolutions";
```

Replace the `flightDates.map(...)` body (the block that computes `datasetPosted` and calls `verdictForDay`) with:

```ts
  const days: DayVerdict[] = flightDates.map((date) => {
    const airborneMinutes = airborneByDate.get(date) ?? 0;
    const videoMinutes = Math.round((videoMinutesByDate.get(date) ?? 0) * 10) / 10;
    const windowEnd = addWorkingDays(date, GRACE_WORKING_DAYS);
    const datasetPosted = hasDatasetNotice(datasetMessages, date, windowEnd);
    const { status: datasetStatus, note: datasetNote } = deriveDatasetStatus(datasetPosted, date, resolutions);
    const base = verdictForDay({
      flightDate: date,
      airborneMinutes,
      videoMinutes,
      datasetStatus,
      today,
      graceWorkingDays: GRACE_WORKING_DAYS,
    });
    // Surface the verbatim waiver/decline reason in the verdict reasons.
    const withNote = datasetNote ? { ...base, reasons: [...base.reasons, datasetNote] } : base;
    return applyResolution(withNote, resolutions);
  });
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Smoke-test the CLI (dry, no write)**

Run: `npm run field-verdict -- --start 2026-06-01 --end 2026-06-28 --format table`
Expected: the table prints; days with a recorded dataset reason now show as accepted/waived rather than parked in needs-review. (If no committed `field-qa` report exists for the period the command logs that and prints an empty table — acceptable for this smoke test.)

- [ ] **Step 4: Commit**

```bash
git add lib/computeVerdicts.ts
git commit -m "feat(field-verdict): derive DatasetStatus in computeVerdicts"
```

---

## Task 5: Gate the `no_dataset` question on `MISSING`

**Files:**
- Modify: `lib/askGaps.ts`
- Test: `lib/askGaps.test.ts`

**Interfaces:**
- Consumes: `DayVerdict.datasetStatus`.

- [ ] **Step 1: Update the tests**

In `lib/askGaps.test.ts`, change any `DayVerdict` fixtures from `datasetPosted: false/true` to `datasetStatus: "MISSING"`/`"POSTED"`. Add a case asserting a WAIVED day produces NO `no_dataset` gap:

```ts
it("does not ask about a waived dataset", () => {
  const gaps = gapsForDay({ ...needsReviewDay, datasetStatus: "WAIVED" });
  expect(gaps.some((g) => g.gapType === "no_dataset")).toBe(false);
});
```

(Use the file's existing helper/fixture name in place of `gapsForDay`/`needsReviewDay`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/askGaps.test.ts`
Expected: FAIL — fixtures still use `datasetPosted`.

- [ ] **Step 3: Update the gate**

In `lib/askGaps.ts`, replace the dataset condition (around line 50):

```ts
  if (day.datasetStatus === "MISSING") {
```

(formerly `if (!day.datasetPosted) {`). Leave the rest of the gap construction unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/askGaps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/askGaps.ts lib/askGaps.test.ts
git commit -m "feat(field-ask): only ask about a MISSING dataset, never a waived one"
```

---

## Task 6: Surfaces — CLI table/CSV, Slack marker, web cell

**Files:**
- Modify: `scripts/fieldVerdictReport.ts`
- Modify: `lib/verdictPublish.ts`
- Modify: `app/(dashboard)/field-verdict/page.tsx`
- Test: `scripts/fieldVerdictReport.test.ts`, `lib/verdictPublish.test.ts`

**Interfaces:**
- Consumes: `DayVerdict.datasetStatus`.

- [ ] **Step 1: Update the report + publish tests**

In `scripts/fieldVerdictReport.test.ts` and `lib/verdictPublish.test.ts`, update `DayVerdict` fixtures from `datasetPosted` to `datasetStatus`. Add assertions:

In `scripts/fieldVerdictReport.test.ts`:

```ts
it("CSV header carries datasetStatus and the row prints the status", () => {
  const report = buildReport(
    [{ date: "2026-06-10", status: "ACCEPTED", airborneMinutes: 100, videoMinutes: 60, ratio: 0.6, datasetStatus: "WAIVED", withinGrace: false, reasons: [] }],
    { start: "2026-06-01", end: "2026-06-30" }, "2026-06-30", 3,
  );
  const csv = toCsv(report);
  expect(csv.split("\n")[0]).toContain("datasetStatus");
  expect(csv).toContain("WAIVED");
});
```

In `lib/verdictPublish.test.ts` (this file's messages are **Ukrainian**):

```ts
it("renders the waived dataset marker (Ukrainian)", () => {
  const msg = formatDayMessage({ date: "2026-06-10", status: "ACCEPTED", airborneMinutes: 100, videoMinutes: 60, ratio: 0.6, datasetStatus: "WAIVED", withinGrace: false, reasons: [] });
  expect(msg).toContain("датасет 📝 виняток");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/fieldVerdictReport.test.ts lib/verdictPublish.test.ts`
Expected: FAIL.

- [ ] **Step 3a: Update `scripts/fieldVerdictReport.ts`**

Change the CSV header + row (lines ~88 and ~96):

```ts
  const lines = ["date,status,airborneMinutes,videoMinutes,ratio,datasetStatus,reasons"];
```
```ts
      d.datasetStatus,
```

(replace `String(d.datasetPosted)` with `d.datasetStatus`).

Add a dataset icon map next to `STATUS_ICON`:

```ts
const DATASET_ICON: Record<string, string> = {
  POSTED: "✓",
  WAIVED: "📝",
  MISSING: "✗",
  DECLINED: "⛔",
};
```

In `formatTable`, replace the `${d.datasetPosted ? "✓ " : "✗ "}` cell with:

```ts
        `${((DATASET_ICON[d.datasetStatus] ?? "?") + " ").padEnd(2)}`
```

(keep it in the same template-literal position; the column header `DS` stays.)

- [ ] **Step 3b: Update `lib/verdictPublish.ts` (Ukrainian — team-facing)**

This module renders **Ukrainian** team posts. Two spots reference the old boolean and must move to `datasetStatus`:

(i) Replace the marker line in `formatDayMessage` — currently
`const ds = day.datasetPosted ? "датасет ✓" : "без датасету";` — with a helper call:

```ts
  const ds = datasetMarker(day.datasetStatus);
```

and add this helper above `formatDayMessage` (markers verbatim per Global Constraints):

```ts
function datasetMarker(status: DayVerdict["datasetStatus"]): string {
  switch (status) {
    case "POSTED": return "датасет ✓";
    case "WAIVED": return "датасет 📝 виняток";
    case "DECLINED": return "датасет ⛔ відхилено";
    default: return "без датасету"; // MISSING
  }
}
```

(ii) In the `ukrainianGaps(day)` helper, the dataset gap is gated on the boolean — change
`if (!day.datasetPosted) gaps.push("немає повідомлення про датасет за цей день");` to:

```ts
  if (day.datasetStatus === "MISSING") gaps.push("немає повідомлення про датасет за цей день");
```

The `${ds}` interpolations in the ACCEPTED / NEEDS_REVIEW / ACCEPTED_EXCEPTION messages stay as-is. The English `day.reasons` remain internal (web/reports) and must NOT leak into these posts — unchanged behavior.

- [ ] **Step 3c: Update `app/(dashboard)/field-verdict/page.tsx`**

Replace the dataset cell (line ~181):

```tsx
                      <td className="px-3 py-2 text-center">
                        {{ POSTED: "✓", WAIVED: "📝", MISSING: "✗", DECLINED: "⛔" }[d.datasetStatus]}
                      </td>
```

- [ ] **Step 4: Run tests + type-check**

Run: `npx vitest run scripts/fieldVerdictReport.test.ts lib/verdictPublish.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/fieldVerdictReport.ts scripts/fieldVerdictReport.test.ts lib/verdictPublish.ts lib/verdictPublish.test.ts "app/(dashboard)/field-verdict/page.tsx"
git commit -m "feat(field-verdict): render DatasetStatus in CLI table/CSV, Slack post, web view"
```

---

## Task 7: Ingestion — tag the resolution axis

**Files:**
- Modify: `lib/applyAnswer.ts`
- Modify: `lib/applyApproval.ts`

**Interfaces:**
- Consumes: `AskRecord.gapType` (`"no_dataset" | "low_video"`); `upsertResolution` (now requires `axis`).

- [ ] **Step 1: `lib/applyAnswer.ts` — derive the axis from the gap type**

In `applyAnswerDecision`, replace the `upsertResolution({...})` call inside the `if (outcome.writeException)` block with:

```ts
  if (outcome.writeException) {
    // A no-dataset reason waives the dataset axis; a low-video reason forgives the video axis.
    const axis = record.gapType === "no_dataset" ? "dataset" : "video";
    await upsertResolution({
      date: record.date,
      axis,
      decision: "accepted_exception",
      note: outcome.note,
      source: outcome.evidencePermalink || "slack",
      recordedAt: new Date().toISOString(),
    });
  }
```

- [ ] **Step 2: `lib/applyApproval.ts` — approver overrides are whole-day**

In `applyApproverDecision`, add `axis: "day"` to the `upsertResolution` call:

```ts
  await upsertResolution({
    date: entry.date,
    axis: "day",
    decision,
    note: reason,
    source: evidence || "slack",
    recordedAt: new Date().toISOString(),
    by,
  });
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (every `upsertResolution` caller now passes `axis`).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. Fix any remaining fixtures that still use `datasetPosted` or a `Resolution` without `axis` (search: `grep -rn "datasetPosted" lib scripts app` should return nothing outside comments).

- [ ] **Step 5: Commit**

```bash
git add lib/applyAnswer.ts lib/applyApproval.ts
git commit -m "feat(field-verdict): tag resolution axis (dataset/video from gap, day from approver)"
```

---

## Final verification

- [ ] `npm test` — whole suite green.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] `grep -rn "datasetPosted" lib scripts app` — only comments/none remain.
- [ ] `npm run field-verdict -- --start 2026-06-01 --end 2026-06-28 --format table` — renders the DS column with the new icons.

## Self-review notes (coverage vs spec)

- Taxonomy `POSTED|WAIVED|MISSING|DECLINED` → Task 1 (type + logic), Task 2 (derivation).
- Stated reason auto-validates → Task 2 `deriveDatasetStatus` WAIVED + Task 7 `field-remember` axis=`dataset`.
- Admin bs-filter veto → Task 2 DECLINED + Task 7 `field-approvals` (day veto → REJECTED).
- Axis-scoped resolutions + migration → Task 2 + Task 3.
- Independent video axis preserved → Task 2 `applyResolution` (video/day) + Task 5 (ask gating).
- Surfaces (CLI/CSV/Slack/web) → Task 6.
- Verbatim reason in `reasons[]` → Task 2 (`note`) + Task 4 (append).
- Developer-acceptance axis deferred → `ResolutionAxis` is open for a `"developer"` member with no further schema change (spec non-goal).
