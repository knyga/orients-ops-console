# Represent no-fly telemetry days — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop discarding Stats-bot telemetry days that report no flight (flew=Ні / 0 airborne), and represent them in the field-verdict as a distinct NEEDS_REVIEW ("за телеметрією 0 польотів"), including a Звіт-vs-telemetry conflict note.

**Architecture:** The telemetry PNG is already vision-read into `{flew, airborneSeconds, flights}`; the fix keeps no-fly days (currently filtered out) in the field-qa report JSON, threads `flew` through `computeVerdicts` → `verdictForDay`, and renders an honest three-case Ukrainian message. Builds on the already-shipped `airborneReported`/`deployWindow` fields.

**Tech Stack:** TypeScript (strict), Vitest, pure `lib/`+`scripts/` modules (no React/Next/fs/DB in the touched logic).

## Global Constraints

- TDD: failing test first → red → implement → green → commit.
- Verdict `reasons` stay ENGLISH in the model; Ukrainian is rebuilt in `lib/verdictPublish.ts`.
- The fieldops inputs / field-qa report **CSV** stays the exact `date,flight_hours` contract — no-fly days are EXCLUDED from it (they'd pollute the video-gate). No-fly days live only in the report **JSON** (verdict source). Do NOT add columns to that CSV.
- A no-fly day is NEEDS_REVIEW (never auto-reject). `verdictForDay` STATUS logic stays unchanged (airborne 0 ⇒ ratio null ⇒ NEEDS_REVIEW past grace / PENDING within).
- Telemetry is authoritative; when a Звіт deployment window conflicts with telemetry no-fly, surface the conflict.
- After adding required `flew` to the field-qa `ExtractedDay`/`ReportDay`, keep `tsc --noEmit` clean (update any mock/literal that builds them). `DayVerdict.flew` is OPTIONAL (no mock breakage).
- Only thread `flew` into the verdict (not `flights` — YAGNI; the reason is a generic "0 польотів").
- Commit message body ends with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## File structure

- `scripts/fieldQaReport.ts` + `scripts/fieldQa.ts` — retain no-fly days (Task 1).
- `lib/fieldDayVerdict.ts` — `flew` field + reason (Task 2).
- `lib/verdictPublish.ts` — three-case message (Task 3).
- `lib/computeVerdicts.ts` — read `flew`, pass through (Task 4, orchestrator, run-verified).

---

### Task 1: retain no-fly days in the field-qa report

**Files:**
- Modify: `scripts/fieldQaReport.ts`, `scripts/fieldQa.ts`
- Test: `scripts/fieldQaReport.test.ts`

**Interfaces:**
- Produces: `ExtractedDay` + `ReportDay` gain `flew: boolean`; `validateDays` keeps `airborneSeconds >= 0`; `toInputsCsv` emits only `airborneSeconds > 0` rows; `buildReport` carries `flew`, `totals.days` counts flown days.

- [ ] **Step 1: Write the failing tests**

Update the `day(...)` helper in `scripts/fieldQaReport.test.ts` to default `flew` (a flown day), then append tests. Change the helper:

```ts
function day(date: string, airborneSeconds: number, extra: Partial<ExtractedDay> = {}): ExtractedDay {
  return { date, airborneSeconds, flights: 1, sourceTs: "1.0", flew: airborneSeconds > 0, ...extra };
}
```

Append:

```ts
describe("no-fly telemetry days", () => {
  it("validateDays keeps a flew=false / 0-airborne day", () => {
    const out = validateDays([day("2026-06-21", 0, { flew: false, flights: 0 })]);
    expect(out.map((d) => d.date)).toEqual(["2026-06-21"]);
    expect(out[0]).toMatchObject({ airborneSeconds: 0, flew: false });
  });

  it("validateDays still drops an invalid date", () => {
    expect(validateDays([day("nope", 0, { flew: false })])).toEqual([]);
  });

  it("toInputsCsv excludes no-fly days (keeps the date,flight_hours contract)", () => {
    const csv = toInputsCsv([day("2026-06-20", 1800), day("2026-06-21", 0, { flew: false, flights: 0 })]);
    expect(csv).toBe("date,flight_hours\n2026-06-20,0.5\n");
  });

  it("buildReport carries flew and totals.days counts only flown days", () => {
    const report = buildReport(
      [day("2026-06-20", 1800), day("2026-06-21", 0, { flew: false, flights: 0 })],
      { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" },
      new Map(),
    );
    expect(report.days.map((d) => ({ date: d.date, flew: d.flew, air: d.airborneMinutes }))).toEqual([
      { date: "2026-06-20", flew: true, air: 30 },
      { date: "2026-06-21", flew: false, air: 0 },
    ]);
    expect(report.totals.days).toBe(1); // only the flown day
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run scripts/fieldQaReport.test.ts`
Expected: FAIL — `flew` not on `ExtractedDay`/`ReportDay`; `validateDays` drops the 0 day; `toInputsCsv` includes it; `totals.days` is 2.

- [ ] **Step 3: Implement**

In `scripts/fieldQaReport.ts`:

Add `flew` to both interfaces:

```ts
export interface ExtractedDay {
  date: string;
  airborneSeconds: number;
  flights: number;
  flew: boolean;
  sourceTs: string;
}

export interface ReportDay {
  date: string;
  flightHours: number;
  airborneMinutes: number;
  flights: number;
  flew: boolean;
  permalink: string;
}
```

`validateDays` — change the drop condition from `<= 0` to `< 0` (keep a genuine 0), and preserve `flew` (the spread already carries it):

```ts
export function validateDays(days: ExtractedDay[]): ExtractedDay[] {
  const byDate = new Map<string, ExtractedDay>();
  for (const d of days) {
    if (!DATE_RE.test(d.date) || !Number.isFinite(d.airborneSeconds) || d.airborneSeconds < 0) continue;
    const existing = byDate.get(d.date);
    if (!existing) {
      byDate.set(d.date, { ...d });
    } else {
      if (d.sourceTs < existing.sourceTs) existing.sourceTs = d.sourceTs;
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
```

`toInputsCsv` — emit only flown rows:

```ts
export function toInputsCsv(days: ExtractedDay[]): string {
  const lines = ["date,flight_hours"];
  for (const d of days) {
    if (d.airborneSeconds <= 0) continue;
    lines.push(`${d.date},${round2(d.airborneSeconds / 3600)}`);
  }
  return `${lines.join("\n")}\n`;
}
```

`buildReport` — carry `flew`; count flown days in totals:

```ts
  const reportDays: ReportDay[] = days.map((d) => ({
    date: d.date,
    flightHours: round2(d.airborneSeconds / 3600),
    airborneMinutes: round2(d.airborneSeconds / 60),
    flights: d.flights,
    flew: d.flew,
    permalink: permalinkByTs.get(d.sourceTs) ?? "",
  }));
  const flightHours = round2(reportDays.reduce((sum, d) => sum + d.flightHours, 0));
  return {
    period,
    sourceChannel: "field-qa",
    days: reportDays,
    totals: { days: reportDays.filter((d) => d.airborneMinutes > 0).length, flightHours },
  };
```

In `scripts/fieldQa.ts` — drop the skip guard and carry `flew`. Replace:

```ts
    if (!a.flew || a.airborneSeconds <= 0) continue;
    days.push({ date, airborneSeconds: a.airborneSeconds, flights: a.flights, sourceTs: m.ts });
```

with:

```ts
    days.push({ date, airborneSeconds: a.airborneSeconds, flights: a.flights, flew: a.flew, sourceTs: m.ts });
```

- [ ] **Step 4: Run — expect PASS + tsc**

Run: `npx vitest run scripts/fieldQaReport.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: 0 errors. (If `formatTable` or another spot constructs a `ReportDay`/`ExtractedDay` literal, add `flew`.)

- [ ] **Step 5: Commit**

```bash
git add scripts/fieldQaReport.ts scripts/fieldQa.ts scripts/fieldQaReport.test.ts
git commit -m "feat(field-qa): retain no-fly telemetry days (flew flag; kept out of inputs CSV)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `flew` on the verdict model

**Files:**
- Modify: `lib/fieldDayVerdict.ts`
- Test: `lib/fieldDayVerdict.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `VerdictInput` + `DayVerdict` gain optional `flew?: boolean`. When `flew === false` and `ratio === null`, the airborne reason is `"telemetry reports 0 flights for the day"`; `flew` echoes onto the day.

- [ ] **Step 1: Write the failing tests**

Append to `lib/fieldDayVerdict.test.ts` inside the `describe("verdictForDay", …)`:

```ts
  it("telemetry no-fly day: 0-flights reason + NEEDS_REVIEW past grace", () => {
    const v = verdictForDay({
      ...base, airborneMinutes: 0, videoMinutes: 0, datasetStatus: "MISSING",
      airborneReported: true, flew: false, today: "2026-06-30",
    });
    expect(v.status).toBe("NEEDS_REVIEW");
    expect(v.ratio).toBeNull();
    expect(v.flew).toBe(false);
    expect(v.reasons).toContain("telemetry reports 0 flights for the day");
    expect(v.reasons).not.toContain("no airborne time recorded for the day");
  });

  it("flew defaults undefined and does not alter existing reasons", () => {
    const v = verdictForDay({ ...base, airborneMinutes: 0, videoMinutes: 0, today: "2026-06-30" });
    expect(v.flew).toBeUndefined();
    expect(v.reasons).toContain("no airborne time recorded for the day");
  });
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run lib/fieldDayVerdict.test.ts`
Expected: FAIL — `flew` undefined on the result; "telemetry reports 0 flights…" reason absent.

- [ ] **Step 3: Implement**

In `lib/fieldDayVerdict.ts`, add to `VerdictInput` (after `deployWindow?`):

```ts
  /** Telemetry "Сьогодні літали" — false when the stats card reports no flight. */
  flew?: boolean;
```

Add to `DayVerdict` (after `deployWindow?`):

```ts
  /** Telemetry flew flag when known. */
  flew?: boolean;
```

In `verdictForDay`, after `const airborneReported = input.airborneReported ?? true;` add:

```ts
  const flew = input.flew;
```

Replace the `if (!videoOk) { reasons.push( … ) }` block with an explicit branch:

```ts
  if (!videoOk) {
    if (ratio === null) {
      reasons.push(
        flew === false
          ? "telemetry reports 0 flights for the day"
          : airborneReported
            ? "no airborne time recorded for the day"
            : "flight reported but airborne time not recorded",
      );
    } else {
      reasons.push(`video ${videoMinutes.toFixed(0)}m is ${(ratio * 100).toFixed(0)}% of airborne ${airborneMinutes.toFixed(0)}m (< 50%)`);
    }
  }
```

Add `flew` to the return object (after `deployWindow: input.deployWindow`):

```ts
  return { date: flightDate, status, airborneMinutes, videoMinutes, ratio, datasetStatus, withinGrace, reasons, roster: [], unknownInitials: [], airborneReported, deployWindow: input.deployWindow, flew };
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run lib/fieldDayVerdict.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add lib/fieldDayVerdict.ts lib/fieldDayVerdict.test.ts
git commit -m "feat(verdict): DayVerdict carries flew; 0-flights telemetry reason

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: three-case honest message + conflict clause

**Files:**
- Modify: `lib/verdictPublish.ts`
- Test: `lib/verdictPublish.test.ts`

**Interfaces:**
- Consumes: `DayVerdict.flew`, `.airborneReported`, `.deployWindow` (Tasks 1–2 + prior feature).

- [ ] **Step 1: Write the failing tests**

Append to `lib/verdictPublish.test.ts` (the `day(...)` helper already defaults `airborneReported: true`; pass `flew`/`deployWindow` per case):

```ts
  it("telemetry no-fly day renders '0 польотів' and no '0 хв у повітрі'", () => {
    const msg = formatDayMessage(day({
      status: "NEEDS_REVIEW", airborneMinutes: 0, videoMinutes: 0, ratio: null,
      datasetStatus: "MISSING", airborneReported: true, flew: false, roster: ["Андріан", "Сергій"],
    }));
    expect(msg).toContain("за телеметрією 0 польотів за день");
    expect(msg).not.toContain("0 хв у повітрі");
    expect(msg).toContain("👥 У полі: Андріан, Сергій.");
  });

  it("no-fly day WITH a Звіт deployment window flags the conflict", () => {
    const msg = formatDayMessage(day({
      status: "NEEDS_REVIEW", airborneMinutes: 0, videoMinutes: 0, ratio: null,
      datasetStatus: "POSTED", airborneReported: true, flew: false,
      deployWindow: { start: "17:00", end: "20:00" },
    }));
    expect(msg).toContain("за телеметрією 0 польотів за день");
    expect(msg).toContain("звіт повідомляє про виліт 17:00–20:00 — розбіжність із телеметрією");
  });
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run lib/verdictPublish.test.ts`
Expected: FAIL — the no-fly wording / conflict clause is absent.

- [ ] **Step 3: Implement**

In `lib/verdictPublish.ts`, replace the `ratio === null` branch inside `ukrainianGaps` with a three-way priority (flew=false → no-telemetry → plain-zero):

```ts
  if (!videoOk) {
    if (day.ratio === null) {
      if (day.flew === false) {
        gaps.push(
          `за телеметрією 0 польотів за день${
            day.deployWindow
              ? ` (звіт повідомляє про виліт ${day.deployWindow.start}–${day.deployWindow.end} — розбіжність із телеметрією)`
              : ""
          }`,
        );
      } else if (!day.airborneReported) {
        gaps.push(
          `політ відбувся${day.deployWindow ? ` (${day.deployWindow.start}–${day.deployWindow.end})` : ""}, але час у повітрі не вказано`,
        );
      } else {
        gaps.push("немає записаного часу в повітрі за день");
      }
    } else {
      gaps.push(`відео ${vid} хв — лише ${pct} від ${air} хв у повітрі (< 50%)`);
    }
  }
```

In `formatDayMessage`, the NEEDS_REVIEW `tail` must also drop the airborne clause for a no-fly day. Replace the `tail` computation:

```ts
  const tail = day.airborneReported && day.flew !== false
    ? `(відео ${vid} хв / ${air} хв у повітрі, ${ds})`
    : `(відео ${vid} хв, ${ds})`;
  return withRosterSuffix(`${icon} ${date} — потрібна перевірка: ${ukrainianGaps(day).join("; ")} ${tail}.`, day.roster);
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run lib/verdictPublish.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add lib/verdictPublish.ts lib/verdictPublish.test.ts
git commit -m "feat(verdict): UA message for telemetry no-fly days + Звіт conflict clause

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: wire `flew` through `computeVerdicts` (orchestrator)

**Files:**
- Modify: `lib/computeVerdicts.ts`

**Interfaces:**
- Consumes: field-qa report `flew` (Task 1); `verdictForDay`'s `flew` input (Task 2).

Orchestrator (DB + live Vimeo), no unit test — verified by tsc + full suite + a live run.

- [ ] **Step 1: Widen the read type**

In `lib/computeVerdicts.ts`, extend the local `FieldQaReport`:

```ts
interface FieldQaReport {
  days: { date: string; airborneMinutes: number; flew?: boolean }[];
}
```

- [ ] **Step 2: Build a flew lookup**

After the `airborneByDate` line, add:

```ts
  const flewByDate = new Map<string, boolean>();
  for (const d of fq?.days ?? []) {
    if (typeof d.flew === "boolean") flewByDate.set(d.date, d.flew);
  }
```

- [ ] **Step 3: Pass `flew` into `verdictForDay`**

In the `flightDays.map(...)` body, add `flew` to the `verdictForDay({...})` call (alongside `airborneReported`/`deployWindow` from the prior feature):

```ts
      airborneReported: fd.airborneReported,
      deployWindow: fd.deployWindow,
      flew: flewByDate.get(fd.date),
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npx tsc --noEmit`
Expected: 0 errors.
Run: `npm test`
Expected: full suite passes.

- [ ] **Step 5: Live verification — 06-21 reads as a no-fly day**

Run: `npm run field-qa -- --start 2026-06-01 --end 2026-06-30 --write` (re-extract so the report retains 06-21 as flew=false; needs ANTHROPIC_API_KEY — this MAY take >2 min, run patiently). Then:
Run: `npm run field-verdict -- --start 2026-06-01 --end 2026-06-30 --format table`
Expected: the `2026-06-21` row shows `Air(m)=0` / `⚠️ NEEDS_REVIEW` with a reason "telemetry reports 0 flights for the day". (Do NOT `--write`/publish — read-only verification; the manual 06-21 Slack message is reconciled by a separate operator backfill later.)

If the re-extract is impractical in this environment, note that in the report and rely on tsc + `npm test` + the pure-unit coverage from Tasks 1–3 as the gate; the wiring is a 3-line pass-through.

- [ ] **Step 6: Commit**

```bash
git add lib/computeVerdicts.ts
git commit -m "feat(verdict): thread telemetry flew into the verdict

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §1 retain no-fly days (ExtractedDay/ReportDay flew, validateDays >=0, toInputsCsv excludes, buildReport + totals, fieldQa.ts guard) → Task 1. ✓
- §2 thread flew into verdict → Tasks 2 (model) + 4 (orchestrator). ✓
- §3 three-case message + conflict clause → Task 3. ✓
- §4 surfaces — corrected: there is NO separate field-qa report CSV (`toInputsCsv` is the only CSV), so the flew signal lives in JSON; verdict table already renders `0`/reasons. No CSV column added (would break the `date,flight_hours` contract). Noted in Global Constraints. ✓
- §5 tests → Tasks 1–3 (pure); Task 4 run-verified. ✓
- §6 compile hygiene → Task 1 Step 4 tsc gate; `DayVerdict.flew` optional (no mock breakage). ✓
- Rollout note (06-21) → Task 4 Step 5 confirms it reads no-fly; publish is a separate operator step. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code.

**Type consistency:** `flew: boolean` (required) on `ExtractedDay`/`ReportDay` (Task 1) vs `flew?: boolean` (optional) on `VerdictInput`/`DayVerdict` (Task 2) — deliberate and consistent (the field-qa report always knows flew; the verdict input is optional so unrelated callers/mocks are unaffected). `flewByDate: Map<string, boolean>` (Task 4) reads the report's `flew` and feeds `verdictForDay`'s `flew?: boolean` — types line up. Message reads `day.flew === false` (Task 3), matching the optional field. `flights` intentionally not threaded (YAGNI). ✓
