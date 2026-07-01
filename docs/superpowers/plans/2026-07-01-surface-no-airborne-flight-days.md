# Surface no-airborne flight days — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the field-verdict pipeline surface a flight day that has a `#field-qa` "Звіт" with a deployment window but no quantified airborne time (currently dropped silently) as a NEEDS_REVIEW day, with an honest Slack message.

**Architecture:** Add `airborneReported` + `deployWindow` to `DayVerdict`; a new pure `mergeFlightDays` helper unions airborne-report dates with parsed-`Звіт` dates that have a deployment window; `computeVerdicts` iterates that union; the Ukrainian message renders airborne-unknown days honestly. `verdictForDay`'s status logic is unchanged (airborne 0 ⇒ ratio null ⇒ NEEDS_REVIEW past grace).

**Tech Stack:** TypeScript (strict), Vitest, pure `lib/` + `scripts/` modules (no React/Next/fs imports in the touched logic).

## Global Constraints

- Pure logic modules (`lib/fieldDayVerdict.ts`, `scripts/fieldVerdictReport.ts`) must stay free of React/Next/`node:fs`/DB imports — they are unit-tested in isolation.
- TDD: write the failing test first, run it red, implement, run it green, commit.
- Verdict `reasons` stay **English** in the model (internal); Ukrainian is rebuilt at post time in `lib/verdictPublish.ts`. Do not put Ukrainian in the model.
- `airborneMinutes` is actual drone flight time, NOT the deployment window — never substitute one for the other.
- The deployment-window gate: a parsed report qualifies as a flight day only when `deployMin != null`.
- Airborne-report dates keep today's behavior exactly (`airborneReported: true`, real minutes, precedence over a parsed-only entry for the same date).
- Commit message body ends with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## File structure

- `lib/fieldDayVerdict.ts` — add model fields + reason branch (Task 1).
- `scripts/fieldVerdictReport.ts` — new pure `mergeFlightDays` helper (Task 2) + `n/a` in table/CSV (Task 4).
- `lib/verdictPublish.ts` — honest Ukrainian render (Task 3).
- `lib/computeVerdicts.ts` — wire the union in (Task 5, orchestrator — verified by a live run).

---

### Task 1: `DayVerdict` carries `airborneReported` + `deployWindow`

**Files:**
- Modify: `lib/fieldDayVerdict.ts`
- Test: `lib/fieldDayVerdict.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `DayVerdict` gains `airborneReported: boolean` and `deployWindow?: { start: string; end: string }`. `VerdictInput` gains optional `airborneReported?: boolean` (default `true`) and `deployWindow?: { start: string; end: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/fieldDayVerdict.test.ts` inside the `describe("verdictForDay", …)` block:

```ts
  it("defaults airborneReported to true (existing days unchanged)", () => {
    const v = verdictForDay(base);
    expect(v.airborneReported).toBe(true);
    expect(v.deployWindow).toBeUndefined();
  });

  it("flags a flight reported with no airborne time and echoes the deploy window", () => {
    const v = verdictForDay({
      ...base,
      airborneMinutes: 0,
      videoMinutes: 0,
      datasetStatus: "MISSING",
      airborneReported: false,
      deployWindow: { start: "17:00", end: "20:00" },
      today: "2026-06-30", // past grace
    });
    expect(v.status).toBe("NEEDS_REVIEW");
    expect(v.ratio).toBeNull();
    expect(v.airborneReported).toBe(false);
    expect(v.deployWindow).toEqual({ start: "17:00", end: "20:00" });
    expect(v.reasons).toContain("flight reported but airborne time not recorded");
  });

  it("keeps the plain no-airborne reason when airborne is genuinely absent from the report", () => {
    const v = verdictForDay({ ...base, airborneMinutes: 0, videoMinutes: 0, today: "2026-06-30" });
    expect(v.reasons).toContain("no airborne time recorded for the day");
  });
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run lib/fieldDayVerdict.test.ts`
Expected: FAIL — `airborneReported` is not on the returned object (undefined), and the "flight reported…" reason is absent.

- [ ] **Step 3: Implement**

In `lib/fieldDayVerdict.ts`, extend `VerdictInput` (after `graceWorkingDays: number;`):

```ts
  /** false when the day was surfaced from a "Звіт" that reported no airborne time. Defaults true. */
  airborneReported?: boolean;
  /** Reported deployment window, when known (for the honest message). */
  deployWindow?: { start: string; end: string };
```

Extend `DayVerdict` (after `unknownInitials: string[];`):

```ts
  /** false when the day was surfaced from a "Звіт" with no airborne figure. */
  airborneReported: boolean;
  /** Reported deployment window, when known. */
  deployWindow?: { start: string; end: string };
```

In `verdictForDay`, add after the destructuring line (`const { … } = input;`):

```ts
  const airborneReported = input.airborneReported ?? true;
```

Replace the airborne reason push (the `ratio === null ? … : …` inside `if (!videoOk)`) with:

```ts
  if (!videoOk) {
    reasons.push(
      ratio === null
        ? airborneReported
          ? "no airborne time recorded for the day"
          : "flight reported but airborne time not recorded"
        : `video ${videoMinutes.toFixed(0)}m is ${(ratio * 100).toFixed(0)}% of airborne ${airborneMinutes.toFixed(0)}m (< 50%)`,
    );
  }
```

Replace the `return { … }` line to include the new fields:

```ts
  return { date: flightDate, status, airborneMinutes, videoMinutes, ratio, datasetStatus, withinGrace, reasons, roster: [], unknownInitials: [], airborneReported, deployWindow: input.deployWindow };
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run lib/fieldDayVerdict.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add lib/fieldDayVerdict.ts lib/fieldDayVerdict.test.ts
git commit -m "feat(verdict): DayVerdict carries airborneReported + deployWindow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: pure `mergeFlightDays` helper

**Files:**
- Modify: `scripts/fieldVerdictReport.ts` (add the helper + its type)
- Test: `scripts/fieldVerdictReport.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (structurally typed).
- Produces:
  - `interface FlightDayInput { date: string; airborneMinutes: number; airborneReported: boolean; deployWindow?: { start: string; end: string } }`
  - `mergeFlightDays(airborneByDate: Map<string, number>, parsed: { flightDate: string; deployMin: number | null; start: string | null; end: string | null }[]): FlightDayInput[]`

- [ ] **Step 1: Write the failing test**

Append to `scripts/fieldVerdictReport.test.ts` (add `mergeFlightDays`, `type FlightDayInput` to the existing import from `./fieldVerdictReport`):

```ts
describe("mergeFlightDays", () => {
  const p = (flightDate: string, deployMin: number | null, start: string | null = null, end: string | null = null) =>
    ({ flightDate, deployMin, start, end });

  it("includes airborne-report dates as reported, preserving minutes", () => {
    const out = mergeFlightDays(new Map([["2026-06-01", 36.8]]), []);
    expect(out).toEqual([{ date: "2026-06-01", airborneMinutes: 36.8, airborneReported: true, deployWindow: undefined }]);
  });

  it("adds a parsed-only date WITH a deployment window as not-reported (airborne 0) + its window", () => {
    const out = mergeFlightDays(new Map(), [p("2026-06-21", 180, "17:00", "20:00")]);
    expect(out).toEqual([{ date: "2026-06-21", airborneMinutes: 0, airborneReported: false, deployWindow: { start: "17:00", end: "20:00" } }]);
  });

  it("excludes a parsed date with no deployment window (deployMin null)", () => {
    const out = mergeFlightDays(new Map(), [p("2026-06-21", null)]);
    expect(out).toEqual([]);
  });

  it("gives the airborne report precedence for a date present in both", () => {
    const out = mergeFlightDays(new Map([["2026-06-21", 40]]), [p("2026-06-21", 180, "17:00", "20:00")]);
    expect(out).toEqual([{ date: "2026-06-21", airborneMinutes: 40, airborneReported: true, deployWindow: { start: "17:00", end: "20:00" } }]);
  });

  it("sorts the union ascending by date", () => {
    const out = mergeFlightDays(new Map([["2026-06-05", 30]]), [p("2026-06-02", 120, "10:00", "12:00")]);
    expect(out.map((d) => d.date)).toEqual(["2026-06-02", "2026-06-05"]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run scripts/fieldVerdictReport.test.ts`
Expected: FAIL — `mergeFlightDays` is not exported.

- [ ] **Step 3: Implement**

In `scripts/fieldVerdictReport.ts`, add (near the other exported helpers):

```ts
export interface FlightDayInput {
  date: string;
  airborneMinutes: number;
  airborneReported: boolean;
  deployWindow?: { start: string; end: string };
}

/**
 * Ordered flight days = union of dates with a committed airborne figure and dates
 * with a parsed "Звіт" that has a deployment window (deployMin != null). An
 * airborne-report date keeps airborneReported=true and its real minutes (precedence);
 * a parsed-only date gets airborneMinutes=0, airborneReported=false. deployWindow is
 * attached whenever the parsed report for that date has both start and end.
 */
export function mergeFlightDays(
  airborneByDate: Map<string, number>,
  parsed: { flightDate: string; deployMin: number | null; start: string | null; end: string | null }[],
): FlightDayInput[] {
  const windowByDate = new Map<string, { start: string; end: string }>();
  for (const r of parsed) {
    if (r.start && r.end) windowByDate.set(r.flightDate, { start: r.start, end: r.end });
  }
  const dates = new Set<string>(airborneByDate.keys());
  for (const r of parsed) {
    if (r.deployMin != null) dates.add(r.flightDate);
  }
  return [...dates]
    .sort((a, b) => a.localeCompare(b))
    .map((date) => ({
      date,
      airborneMinutes: airborneByDate.get(date) ?? 0,
      airborneReported: airborneByDate.has(date),
      deployWindow: windowByDate.get(date),
    }));
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run scripts/fieldVerdictReport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/fieldVerdictReport.ts scripts/fieldVerdictReport.test.ts
git commit -m "feat(verdict): pure mergeFlightDays — union airborne + deployment-window dates

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: honest Ukrainian render for airborne-unknown days

**Files:**
- Modify: `lib/verdictPublish.ts`
- Test: `lib/verdictPublish.test.ts`

**Interfaces:**
- Consumes: `DayVerdict.airborneReported` + `DayVerdict.deployWindow` (Task 1).
- Produces: message text changes only.

- [ ] **Step 1: Write the failing tests**

Append to `lib/verdictPublish.test.ts` (reuse the file's existing `day(...)` fixture helper; it spreads overrides onto a `DayVerdict`):

```ts
  it("NEEDS_REVIEW airborne-unknown day: honest wording + deploy window, no '0 хв у повітрі'", () => {
    const msg = formatDayMessage(day({
      status: "NEEDS_REVIEW",
      airborneMinutes: 0,
      videoMinutes: 0,
      ratio: null,
      datasetStatus: "MISSING",
      airborneReported: false,
      deployWindow: { start: "17:00", end: "20:00" },
      roster: ["Андріан", "Сергій"],
    }));
    expect(msg).toContain("політ відбувся (17:00–20:00), але час у повітрі не вказано");
    expect(msg).not.toContain("хв у повітрі,"); // trailing parenthetical dropped the airborne clause
    expect(msg).not.toContain("0 хв у повітрі");
    expect(msg).toContain("👥 У полі: Андріан, Сергій.");
  });

  it("NEEDS_REVIEW with a real airborne figure still shows the airborne clause", () => {
    const msg = formatDayMessage(day({
      status: "NEEDS_REVIEW",
      airborneMinutes: 85,
      videoMinutes: 0,
      ratio: 0,
      datasetStatus: "MISSING",
      airborneReported: true,
    }));
    expect(msg).toContain("85 хв у повітрі");
  });
```

Note: if the existing `day(...)` fixture predates Task 1's fields, add `airborneReported: true` to its defaults so unrelated cases keep passing.

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run lib/verdictPublish.test.ts`
Expected: FAIL — the airborne-unknown message still says `немає записаного часу в повітрі за день` and includes `0 хв у повітрі`.

- [ ] **Step 3: Implement**

In `lib/verdictPublish.ts`, in `ukrainianGaps`, replace the `ratio === null` reason branch:

```ts
  if (!videoOk) {
    if (day.ratio === null) {
      gaps.push(
        day.airborneReported
          ? "немає записаного часу в повітрі за день"
          : `політ відбувся${day.deployWindow ? ` (${day.deployWindow.start}–${day.deployWindow.end})` : ""}, але час у повітрі не вказано`,
      );
    } else {
      gaps.push(`відео ${vid} хв — лише ${pct} від ${air} хв у повітрі (< 50%)`);
    }
  }
```

In `formatDayMessage`, replace the NEEDS_REVIEW return (last line) so the trailing parenthetical omits the airborne clause when unreported:

```ts
  // NEEDS_REVIEW — rebuild the gaps in Ukrainian from the structured fields.
  const tail = day.airborneReported
    ? `(відео ${vid} хв / ${air} хв у повітрі, ${ds})`
    : `(відео ${vid} хв, ${ds})`;
  return withRosterSuffix(`${icon} ${date} — потрібна перевірка: ${ukrainianGaps(day).join("; ")} ${tail}.`, day.roster);
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run lib/verdictPublish.test.ts`
Expected: PASS (all existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add lib/verdictPublish.ts lib/verdictPublish.test.ts
git commit -m "feat(verdict): honest UA message for airborne-unknown days (deploy window, no 0 хв)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: table/CSV show `n/a` for unreported airborne

**Files:**
- Modify: `scripts/fieldVerdictReport.ts`
- Test: `scripts/fieldVerdictReport.test.ts`

**Interfaces:**
- Consumes: `DayVerdict.airborneReported` (Task 1).
- Produces: table/CSV rendering change only.

- [ ] **Step 1: Write the failing test**

Append to `scripts/fieldVerdictReport.test.ts` (using the file's existing table/CSV helpers `toTable`/`toCsv` and its `DayVerdict` fixture pattern — construct a minimal day with `airborneReported: false`):

```ts
describe("airborne n/a rendering", () => {
  const mkDay = (over: Partial<import("../lib/fieldDayVerdict").DayVerdict> = {}) => ({
    date: "2026-06-21", status: "NEEDS_REVIEW" as const, airborneMinutes: 0, videoMinutes: 0,
    ratio: null, datasetStatus: "MISSING" as const, withinGrace: false, reasons: [],
    roster: [], unknownInitials: [], airborneReported: false, ...over,
  });

  it("CSV shows n/a when airborne was not reported", () => {
    const csv = toCsv({ period: { start: "2026-06-01", end: "2026-06-30" }, runDate: "2026-06-30", graceWorkingDays: 3, days: [mkDay()], summary: summarize([mkDay()]) });
    const row = csv.split("\n").find((l) => l.startsWith("2026-06-21"))!;
    expect(row.split(",")[2]).toBe("n/a"); // airborneMinutes column
  });

  it("CSV shows the number when airborne was reported", () => {
    const d = mkDay({ airborneMinutes: 42, airborneReported: true });
    const csv = toCsv({ period: { start: "2026-06-01", end: "2026-06-30" }, runDate: "2026-06-30", graceWorkingDays: 3, days: [d], summary: summarize([d]) });
    const row = csv.split("\n").find((l) => l.startsWith("2026-06-21"))!;
    expect(row.split(",")[2]).toBe("42");
  });
});
```

(Confirm the exact `toCsv`/`summarize`/`VerdictReport` argument shape against the file — mirror how the existing tests in this file call them; adjust the wrapper object to match if it differs.)

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run scripts/fieldVerdictReport.test.ts`
Expected: FAIL — CSV shows `0`, not `n/a`.

- [ ] **Step 3: Implement**

In `scripts/fieldVerdictReport.ts`, in `toCsv`, replace `String(d.airborneMinutes)` in the row mapping with:

```ts
      d.airborneReported ? String(d.airborneMinutes) : "n/a",
```

In `toTable`, replace `String(d.airborneMinutes).padStart(6)` with:

```ts
        (d.airborneReported ? String(d.airborneMinutes) : "n/a").padStart(6)
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run scripts/fieldVerdictReport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/fieldVerdictReport.ts scripts/fieldVerdictReport.test.ts
git commit -m "feat(verdict): render airborne as n/a (not 0) when not reported

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: wire the union into `computeVerdicts` (orchestrator)

**Files:**
- Modify: `lib/computeVerdicts.ts`

**Interfaces:**
- Consumes: `mergeFlightDays` (Task 2), `verdictForDay`'s new `airborneReported`/`deployWindow` inputs (Task 1).
- Produces: the verdict report now includes deployment-window-only days.

This orchestrator reads the DB + live Vimeo and has no unit test; verify it by typecheck + a live run.

- [ ] **Step 1: Add the import**

In `lib/computeVerdicts.ts`, add `mergeFlightDays` to the existing import from `../scripts/fieldVerdictReport` (which already imports `buildReport, toCsv, type Period, type VerdictReport`):

```ts
import { buildReport, mergeFlightDays, toCsv, type Period, type VerdictReport } from "../scripts/fieldVerdictReport";
```

- [ ] **Step 2: Replace the flight-day derivation**

Find the block that builds `parsedByDate` and `flightDates`:

```ts
  const parsedByDate = new Map(parseMonth(fieldQaMessages, aliases).map((r) => [r.flightDate, r]));
  const corrections = await readRosterCorrections();

  // Flight days = days the bot reported airborne time (the field-qa report).
  const flightDates = [...airborneByDate.keys()].sort();
  const days: DayVerdict[] = flightDates.map((date) => {
    const airborneMinutes = airborneByDate.get(date) ?? 0;
    const videoMinutes = Math.round((videoMinutesByDate.get(date) ?? 0) * 10) / 10;
```

Replace it with (compute `parsedReports` once, feed `mergeFlightDays`, iterate `FlightDayInput`s):

```ts
  const parsedReports = parseMonth(fieldQaMessages, aliases);
  const parsedByDate = new Map(parsedReports.map((r) => [r.flightDate, r]));
  const corrections = await readRosterCorrections();

  // Flight days = union of days the bot reported airborne time AND days with a
  // parsed "Звіт" that has a deployment window (deployMin != null). The latter
  // surface as NEEDS_REVIEW ("flight reported but airborne time not recorded")
  // instead of vanishing.
  const flightDays = mergeFlightDays(airborneByDate, parsedReports);
  const days: DayVerdict[] = flightDays.map((fd) => {
    const date = fd.date;
    const airborneMinutes = fd.airborneMinutes;
    const videoMinutes = Math.round((videoMinutesByDate.get(date) ?? 0) * 10) / 10;
```

Then, in the same `.map` body, pass the new fields into `verdictForDay`. Find:

```ts
    const base = verdictForDay({
      flightDate: date,
      airborneMinutes,
      videoMinutes,
      datasetStatus,
      today,
      graceWorkingDays: GRACE_WORKING_DAYS,
    });
```

and add the two fields:

```ts
    const base = verdictForDay({
      flightDate: date,
      airborneMinutes,
      videoMinutes,
      datasetStatus,
      today,
      graceWorkingDays: GRACE_WORKING_DAYS,
      airborneReported: fd.airborneReported,
      deployWindow: fd.deployWindow,
    });
```

The rest of the `.map` body (datasetStatus derivation, `applyResolution`, roster correction, return) is unchanged — `verdictForDay` already carries `airborneReported`/`deployWindow` onto `base`, and they survive the `{ ...resolved, roster, unknownInitials }` spread since `resolved` derives from `base`.

- [ ] **Step 3: Typecheck + full suite**

Run: `npx tsc --noEmit`
Expected: 0 errors.
Run: `npm test`
Expected: full suite passes (the new tests from Tasks 1–4 included).

- [ ] **Step 4: Live verification — 06-21 now surfaces**

Run: `npm run field-verdict -- --start 2026-06-01 --end 2026-06-30 --format table`
Expected: a `2026-06-21` row now appears with `Air(m) = n/a`, `⚠️ NEEDS_REVIEW`, crew `Андріан, Сергій`, and a reason mentioning airborne not recorded. (Do NOT `--write` or publish here — that is a separate operator step.)

- [ ] **Step 5: Commit**

```bash
git add lib/computeVerdicts.ts
git commit -m "feat(verdict): surface deployment-window days with no airborne figure

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §1 model (`airborneReported` + `deployWindow`, reason branch, status unchanged) → Task 1. ✓
- §2 pure `mergeFlightDays` union + deployment-window gate + precedence → Task 2. ✓
- §3 orchestrator wiring → Task 5. ✓
- §4 honest message (deploy window, drop `0 хв у повітрі`) → Task 3. ✓
- §5 report table/CSV `n/a` → Task 4. ✓
- §6 tests → Tasks 1–4 (pure); Task 5 verified by run (orchestrator, no unit test — matches "no computeVerdicts.test.ts"). ✓
- Rollout note (06-21) → not code; Task 5 Step 4 confirms it surfaces, actual publish is a separate operator step (called out). ✓

**Placeholder scan:** No TBD/TODO. Task 4's test wrapper is flagged "confirm exact shape against the file" — that's a real instruction to match existing call sites, with complete code given, not a placeholder.

**Type consistency:** `airborneReported: boolean` / `deployWindow?: { start: string; end: string }` identical across Task 1 (model), Task 2 (`FlightDayInput`), Task 3 (message reads them), Task 5 (passes them). `mergeFlightDays(Map<string,number>, {flightDate,deployMin,start,end}[]) → FlightDayInput[]` consistent between Task 2 (def) and Task 5 (call — `parseMonth` returns `FieldReport[]` which structurally satisfies the param). ✓
