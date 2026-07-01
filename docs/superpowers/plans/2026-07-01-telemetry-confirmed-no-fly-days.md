# Telemetry-Confirmed No-Fly Days Implementation Plan

> **Status: EXECUTED — commits `c35d487`..`bc3c8f8` on `main`.** Canonical plan for this
> feature; consolidates the parallel `no-fly-telemetry-days.md` plan (unimplemented). As-built
> deviations from the tasks below: (1) the extraction drop-guard removal landed in
> `lib/fieldQaExtract.ts` (a concurrent refactor `e04c8ac` moved extraction there from
> `scripts/fieldQa.ts`); (2) an extra commit `33426b8` drops contradictory `flew:true/0`
> reads (final-review finding); (3) an extra commit `bc3c8f8` normalizes no-fly `flights` to
> 0. See the design doc's "Alternatives considered & as-built" for the full rationale.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop discarding a telemetry-confirmed 0-airborne day so the field-verdict pipeline surfaces it as a NEEDS_REVIEW "no-fly" day with honest Ukrainian wording, instead of mislabeling it "час у повітрі не вказано".

**Architecture:** The stats-bot "Статистика польотів" card is already read (`flightTextParse` + vision fallback in `flightExtract`), but the field-qa extraction drops every `!flew || airborneSeconds <= 0` day. We stop dropping no-fly days: they land in `reports/field-qa/<period>.json` with `airborneMinutes: 0` (but stay OUT of the flight-hours inputs CSV). `computeVerdicts` — the sole reader of that report — then sees the day in `airborneByDate` with value 0, so `mergeFlightDays` marks it `airborneReported: true`, and `verdictForDay` (unchanged status logic) renders a truthful no-fly reason. `computeVerdicts.ts`/`mergeFlightDays` need **no** logic change. The live 06-21 message is corrected via the existing `field-backfill` machinery — no new code.

**Tech Stack:** TypeScript (strict), Node with `--conditions=react-server`, Vitest. Pure lib modules (`lib/fieldDayVerdict.ts`, `lib/verdictPublish.ts`) and pure CLI helpers (`scripts/fieldQaReport.ts`) stay side-effect-free and unit-tested.

## Global Constraints

- All team-facing Slack messages are in **Ukrainian**; the English `day.reasons` are internal (web/reports) and MUST NOT leak to the channel — messages are rebuilt in UA from structured fields at post time.
- Pure `lib/` and pure `scripts/*Report.ts` modules take no React/Next imports and stay unit-testable without the `server-only` guard.
- `reports/field-ops/inputs/<period>.csv` is the fieldops/reconcile flight-hours feed; it MUST contain only flown days (never a 0-hour row).
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit. One behavior per commit.
- Run a single test file with `npx vitest run <path>`; the full suite with `npm test`.

## File Structure

- `scripts/fieldQaReport.ts` — pure report shaping (`ExtractedDay`, `ReportDay`, `validateDays`, `toInputsCsv`, `buildReport`). Gains a `flew` marker; keeps no-fly days in the JSON, excludes them from the inputs CSV, counts only flown days in totals.
- `scripts/fieldQa.ts` — the CLI glue that reads each card and pushes days. One-line change: stop dropping no-fly days; carry `flew`.
- `lib/fieldDayVerdict.ts` — pure per-day verdict. One reason string changes (the `airborneReported && ratio===null` branch → "drones did not fly").
- `lib/verdictPublish.ts` — Ukrainian message builder. `ukrainianGaps` no-fly wording + the NEEDS_REVIEW tail condition.
- `lib/computeVerdicts.ts`, `scripts/fieldVerdictReport.ts` — **no change** (verified: once the day is in the report with airborne 0, existing logic handles it). The `FieldQaReport` read interface in `computeVerdicts.ts` reads `{date, airborneMinutes}` and ignores the extra `flew` field.

---

### Task 1: field-qa report keeps telemetry-confirmed no-fly days

**Files:**
- Modify: `scripts/fieldQaReport.ts` (`ExtractedDay`, `ReportDay`, `validateDays`, `toInputsCsv`, `buildReport`)
- Test: `scripts/fieldQaReport.test.ts`

**Interfaces:**
- Produces: `ExtractedDay { date: string; airborneSeconds: number; flights: number; flew: boolean; sourceTs: string }`; `ReportDay { date; flightHours; airborneMinutes; flights; flew: boolean; permalink }`. `validateDays(days: ExtractedDay[]): ExtractedDay[]` keeps `airborneSeconds >= 0`. `toInputsCsv(days: ExtractedDay[]): string` emits only `flew && airborneSeconds > 0` rows. `buildReport(...)` `totals.days` counts only `flew` days.
- Consumes: nothing new.

- [ ] **Step 1: Update the test helper to carry `flew`**

In `scripts/fieldQaReport.test.ts`, replace the `day` helper (currently line ~12):

```ts
function day(date: string, airborneSeconds: number, extra: Partial<ExtractedDay> = {}): ExtractedDay {
  return { date, airborneSeconds, flights: 1, flew: airborneSeconds > 0, sourceTs: "1.0", ...extra };
}
```

- [ ] **Step 2: Write/adjust the failing tests**

Replace the existing `validateDays` test (the "drops zero/negative/invalid…" block) with:

```ts
describe("validateDays", () => {
  it("keeps telemetry-confirmed no-fly (0) days, drops negative/NaN/bad-date, dedupes, sorts", () => {
    const r = validateDays([
      day("2026-06-02", 1200),
      day("2026-06-01", 1110, { sourceTs: "100.1" }),
      day("2026-06-01", 999, { sourceTs: "100.9" }),
      day("2026-06-03", 0),      // no-fly: KEPT now
      day("2026-06-05", -5),     // negative: dropped
      day("bad-date", 600),
      day("2026-06-04", Number.NaN),
    ]);
    expect(r.map((d) => d.date)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
    expect(r[0].airborneSeconds).toBe(1110); // first/kept for the date
    expect(r[0].sourceTs).toBe("100.1");
    expect(r.find((d) => d.date === "2026-06-03")!.flew).toBe(false);
  });
});
```

Add, after the existing `toInputsCsv` test:

```ts
it("excludes no-fly (0) days from the flight-hours feed", () => {
  const csv = toInputsCsv(validateDays([day("2026-06-13", 1217), day("2026-06-14", 0)]));
  expect(csv).toBe("date,flight_hours\n2026-06-13,0.34\n");
});
```

Add, after the existing `buildReport` test:

```ts
it("includes no-fly days in report.days but counts only flown days in totals", () => {
  const days = validateDays([day("2026-06-18", 1110), day("2026-06-19", 0)]);
  const report = buildReport(days, { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" }, new Map());
  expect(report.days.map((d) => d.date)).toEqual(["2026-06-18", "2026-06-19"]);
  const noFly = report.days.find((d) => d.date === "2026-06-19")!;
  expect(noFly.flew).toBe(false);
  expect(noFly.airborneMinutes).toBe(0);
  expect(report.totals.days).toBe(1); // only the flown day counts
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run scripts/fieldQaReport.test.ts`
Expected: FAIL — `flew` is not a property of `ExtractedDay`/`ReportDay` (type error), `2026-06-03` currently dropped, no-fly still in CSV.

- [ ] **Step 4: Implement the changes in `scripts/fieldQaReport.ts`**

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

Change the `validateDays` filter (keep 0, drop only negative/non-finite/bad-date) — update the doc comment's "non-positive" to "negative":

```ts
export function validateDays(days: ExtractedDay[]): ExtractedDay[] {
  const byDate = new Map<string, ExtractedDay>();
  for (const d of days) {
    // Keep telemetry-confirmed no-fly days (airborneSeconds 0 is data, not absence).
    // Drop only rows with a bad date or a non-finite/negative airborne reading.
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

Filter the inputs CSV to flown days:

```ts
export function toInputsCsv(days: ExtractedDay[]): string {
  const lines = ["date,flight_hours"];
  for (const d of days) {
    if (!d.flew || d.airborneSeconds <= 0) continue; // flight-hours feed: flown days only
    lines.push(`${d.date},${round2(d.airborneSeconds / 3600)}`);
  }
  return `${lines.join("\n")}\n`;
}
```

Carry `flew` into `ReportDay` and count only flown days in totals:

```ts
export function buildReport(
  days: ExtractedDay[],
  period: Period,
  permalinkByTs: Map<string, string>,
): FieldQaReport {
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
    totals: { days: reportDays.filter((d) => d.flew).length, flightHours },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run scripts/fieldQaReport.test.ts`
Expected: PASS (all, including the pre-existing `buildReport`/`formatTable` tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/fieldQaReport.ts scripts/fieldQaReport.test.ts
git commit -m "feat(field-qa): keep telemetry-confirmed no-fly days in the report

Carry a flew marker; validateDays keeps airborne 0, toInputsCsv still
emits flown days only, totals count flown days.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: field-qa extraction stops dropping no-fly days

**Files:**
- Modify: `scripts/fieldQa.ts:86-87`

**Interfaces:**
- Consumes: `ExtractedDay` with `flew` (Task 1); `AirborneExtract { flew, airborneSeconds, flights }` from `lib/flightExtractPrompt`.
- Produces: nothing new (CLI glue).

Note: `scripts/fieldQa.ts` `main()` does live Slack + Claude-vision I/O and is not unit-tested; its behavior is covered by the pure Task 1 tests. This task is verified by `tsc` + lint and the Task 5 end-to-end run.

- [ ] **Step 1: Remove the no-fly drop and carry `flew`**

Replace lines 86-87:

```ts
    if (!a.flew || a.airborneSeconds <= 0) continue;
    days.push({ date, airborneSeconds: a.airborneSeconds, flights: a.flights, sourceTs: m.ts });
```

with:

```ts
    // Keep telemetry-confirmed no-fly days (flew:false / 0 sec) — a known zero is
    // data, not absence. validateDays/buildReport keep them; toInputsCsv still
    // excludes them from the flight-hours feed.
    days.push({ date, airborneSeconds: a.airborneSeconds, flights: a.flights, flew: a.flew, sourceTs: m.ts });
```

- [ ] **Step 2: Verify it type-checks and lints**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors (the `flew` field now satisfies `ExtractedDay`).

- [ ] **Step 3: Commit**

```bash
git add scripts/fieldQa.ts
git commit -m "feat(field-qa): stop dropping no-fly days at extraction

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: verdict labels a reported-0 day as did-not-fly

**Files:**
- Modify: `lib/fieldDayVerdict.ts:64-67` (reason string)
- Test: `lib/fieldDayVerdict.test.ts`

**Interfaces:**
- Consumes: `verdictForDay(input: VerdictInput): DayVerdict` (unchanged signature). Relies on the existing invariant `ratio === null ⟺ airborneMinutes === 0`, and `airborneReported && ratio === null` ⟺ a telemetry-confirmed no-fly day.
- Produces: verdict `reasons` containing `"drones did not fly (0 flights, 0 min airborne)"` for a reported-0 day.

- [ ] **Step 1: Update the failing test**

In `lib/fieldDayVerdict.test.ts`, replace the test named `"keeps the plain no-airborne reason when airborne is genuinely absent from the report"` (lines ~86-89) with:

```ts
  it("labels a telemetry-confirmed no-fly day (airborne reported as 0) as did-not-fly", () => {
    const v = verdictForDay({ ...base, airborneMinutes: 0, videoMinutes: 0, today: "2026-06-30" });
    expect(v.status).toBe("NEEDS_REVIEW");
    expect(v.airborneReported).toBe(true); // defaulted true → reported 0
    expect(v.reasons).toContain("drones did not fly (0 flights, 0 min airborne)");
    expect(v.reasons).not.toContain("no airborne time recorded for the day");
  });
```

(Leave the test at lines ~69-84 — `airborneReported: false` → "flight reported but airborne time not recorded" — unchanged.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/fieldDayVerdict.test.ts -t "did-not-fly"`
Expected: FAIL — reason is still "no airborne time recorded for the day".

- [ ] **Step 3: Change the reason string in `lib/fieldDayVerdict.ts`**

In the `if (!videoOk)` block (lines ~61-68), change only the `airborneReported` branch:

```ts
  if (!videoOk) {
    reasons.push(
      ratio === null
        ? airborneReported
          ? "drones did not fly (0 flights, 0 min airborne)"
          : "flight reported but airborne time not recorded"
        : `video ${videoMinutes.toFixed(0)}m is ${(ratio * 100).toFixed(0)}% of airborne ${airborneMinutes.toFixed(0)}m (< 50%)`,
    );
  }
```

- [ ] **Step 4: Run the whole verdict test file**

Run: `npx vitest run lib/fieldDayVerdict.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add lib/fieldDayVerdict.ts lib/fieldDayVerdict.test.ts
git commit -m "feat(verdict): reported-0 airborne day reads as did-not-fly, not missing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Ukrainian no-fly wording

**Files:**
- Modify: `lib/verdictPublish.ts` (`formatDayMessage` tail ~115-117; `ukrainianGaps` ~133-138)
- Test: `lib/verdictPublish.test.ts`

**Interfaces:**
- Consumes: `DayVerdict` fields `airborneReported`, `airborneMinutes`, `ratio`, `deployWindow`, `datasetStatus`, `videoMinutes`.
- Produces: for a telemetry no-fly day the gap `за телеметрією польотів не було (0 хв у повітрі)` (plus `, хоча у звіті — виїзд {start}–{end}` when `deployWindow` is set), and a short NEEDS_REVIEW tail `(відео {vid} хв, {ds})` when `airborneMinutes === 0`.

- [ ] **Step 1: Update / add the failing tests**

In `lib/verdictPublish.test.ts`, replace the test `"rebuilds the no-airborne gap in Ukrainian when ratio is null"` (lines ~57-62) with:

```ts
  it("rebuilds a telemetry no-fly gap in Ukrainian when airborne is a reported 0", () => {
    const msg = formatDayMessage(
      day({ date: "2026-06-13", status: "NEEDS_REVIEW", airborneMinutes: 0, videoMinutes: 5, ratio: null, datasetStatus: "POSTED", reasons: ["drones did not fly (0 flights, 0 min airborne)"] }),
    );
    expect(msg).toContain("за телеметрією польотів не було (0 хв у повітрі)");
    expect(msg).not.toContain("немає записаного часу");
  });

  it("adds the Звіт-conflict clause + short tail when a no-fly day has a deploy window", () => {
    const msg = formatDayMessage(day({
      date: "2026-06-21", status: "NEEDS_REVIEW", airborneMinutes: 0, videoMinutes: 0, ratio: null,
      datasetStatus: "MISSING", airborneReported: true, deployWindow: { start: "17:00", end: "20:00" },
      roster: ["Андріан", "Сергій"],
    }));
    expect(msg).toContain("за телеметрією польотів не було (0 хв у повітрі), хоча у звіті — виїзд 17:00–20:00");
    expect(msg).toContain("немає повідомлення про датасет");
    expect(msg).not.toContain("/ 0 хв у повітрі"); // short tail — no redundant airborne clause
    expect(msg).toContain("👥 У полі: Андріан, Сергій.");
  });
```

(Leave the test `"NEEDS_REVIEW airborne-unknown day: honest wording + deploy window…"` at lines ~64-79 — `airborneReported: false` — unchanged; it guards the no-telemetry branch.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/verdictPublish.test.ts -t "no-fly"`
Expected: FAIL — gap still reads "немає записаного часу в повітрі за день"; tail still shows "/ 0 хв у повітрі".

- [ ] **Step 3: Change the tail condition in `formatDayMessage`**

Replace lines ~115-117:

```ts
  const tail = day.airborneReported
    ? `(відео ${vid} хв / ${air} хв у повітрі, ${ds})`
    : `(відео ${vid} хв, ${ds})`;
```

with:

```ts
  const tail = day.airborneReported && day.airborneMinutes > 0
    ? `(відео ${vid} хв / ${air} хв у повітрі, ${ds})`
    : `(відео ${vid} хв, ${ds})`;
```

- [ ] **Step 4: Change the no-fly gap wording in `ukrainianGaps`**

Replace the `if (day.ratio === null) { … }` block (lines ~133-138):

```ts
    if (day.ratio === null) {
      gaps.push(
        day.airborneReported
          ? `за телеметрією польотів не було (0 хв у повітрі)${day.deployWindow ? `, хоча у звіті — виїзд ${day.deployWindow.start}–${day.deployWindow.end}` : ""}`
          : `політ відбувся${day.deployWindow ? ` (${day.deployWindow.start}–${day.deployWindow.end})` : ""}, але час у повітрі не вказано`,
      );
    }
```

- [ ] **Step 5: Run the whole publish test file**

Run: `npx vitest run lib/verdictPublish.test.ts`
Expected: PASS (all, including the unchanged `airborneReported: false` test).

- [ ] **Step 6: Commit**

```bash
git add lib/verdictPublish.ts lib/verdictPublish.test.ts
git commit -m "feat(verdict): honest UA no-fly wording for telemetry-confirmed 0-airborne days

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Full-suite verification + correct the live 06-21 message

**Files:** none (verification + operational).

**Interfaces:**
- Consumes: the shipped changes (Tasks 1-4); `npm run slack-sync`, `npm run field-qa`, `npm run field-verdict`, `npm run field-backfill`.

- [ ] **Step 1: Full test suite, lint, types**

Run: `npm test && npm run lint && npx tsc --noEmit`
Expected: all pass. In particular confirm `lib/computeVerdicts` / `scripts/fieldVerdictReport` tests still pass **unchanged** (proves the report-only change needs no verdict-pipeline edit).

- [ ] **Step 2: Sync the mirror and re-extract June**

```bash
npm run slack-sync -- --channel field-qa
npm run field-qa -- --start 2026-06-01 --end 2026-06-30 --write
```
Expected: the field-qa report now includes `2026-06-21` with `flew:false, airborneMinutes:0`. Verify:
`node -e "const j=require('./reports/field-qa/2026-06.json'); console.log(j.days.find(d=>d.date==='2026-06-21'))"`
Expected: an object with `flew:false, airborneMinutes:0`.

  **Caveat (from the spec):** in the working sandbox the Slack mirror is frozen at 06-20 and `slack-sync` did not advance it; `field-qa` reads live Slack (`lib/slack.fetchMessages`) so it should still see 06-21's card (image-only → Claude vision; needs `ANTHROPIC_API_KEY` + `files:read`). If 06-21 does NOT appear, STOP and report — do not hand-edit the report JSON. The mirror must also carry the 06-21 "Звіт" for the deployment-window clause and crew; if it doesn't, the message will correctly omit the `, хоча у звіті — виїзд …` clause and the crew suffix.

- [ ] **Step 3: Recompute the verdict and inspect 06-21 (no writes to Slack)**

```bash
npm run field-verdict -- --start 2026-06-01 --end 2026-06-30 --format table
```
Expected: a `2026-06-21` row with status `NEEDS_REVIEW` and reason "drones did not fly …". Then persist:
```bash
npm run field-verdict -- --start 2026-06-01 --end 2026-06-30 --write
```

- [ ] **Step 4: Dry-run the live message correction**

```bash
npm run field-backfill -- --start 2026-06-01 --end 2026-06-30 --channel field-qa
```
Expected (DRY-RUN): prints the `old → new` for 06-21, rewriting the manual message to
`⚠️ 2026-06-21 (неділя) — потрібна перевірка: за телеметрією польотів не було (0 хв у повітрі)…`. Confirm it targets `#field-qa` and is not marked overridden.

  If `field-backfill` does NOT pick up 06-21 (it was originally posted manually — confirm a `reports/published/2026-06.json` entry with its `ts` exists), STOP and report; the correction path may need a one-off `chat.update`. Do not post blind.

- [ ] **Step 5: Publish the correction (only after the dry-run looks right)**

```bash
npm run field-backfill -- --start 2026-06-01 --end 2026-06-30 --channel field-qa --publish
```
Expected: the live 06-21 message is rewritten in place; re-running is idempotent (skips already-rewritten).

- [ ] **Step 6: Update memory**

Edit `~/.claude/projects/-workspaces-orients-ops-console/memory/verdict-drops-no-airborne-days.md`: mark the telemetry durable fix as SHIPPED (commits on `feat/telemetry-no-fly-days`), note 06-21 corrected in place (don't re-post), and that field-qa now keeps no-fly days.

---

## Self-Review

**Spec coverage:**
- Spec §1 (extraction keeps no-fly, inputs CSV excludes, totals flown-only) → Task 1 + Task 2. ✓
- Spec §2 (read type + merge; no new `DayVerdict` field; no logic change) → covered by "no change" note + Task 5 Step 1 regression check. ✓
- Spec §3 (verdict no-fly reason) → Task 3. ✓
- Spec §4 (UA wording + tail) → Task 4. ✓
- Spec §5 (correct live 06-21 via field-backfill) → Task 5 Steps 2-5. ✓
- Spec "verification caveat" (frozen mirror) → Task 5 Step 2 caveat. ✓
- Out-of-scope items (field-bonus, inputs-CSV contract, nightly pipeline) → untouched; the only field-qa report reader is `computeVerdicts` (verified). ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows the full code. ✓

**Type consistency:** `flew: boolean` added identically to `ExtractedDay` and `ReportDay` (Task 1) and set in `scripts/fieldQa.ts` push (Task 2). `verdictForDay` signature unchanged. `formatDayMessage`/`ukrainianGaps` use existing `DayVerdict` fields only. Reason string "drones did not fly (0 flights, 0 min airborne)" is identical in Task 3 (implementation) and Tasks 3-4 (test assertions). ✓
