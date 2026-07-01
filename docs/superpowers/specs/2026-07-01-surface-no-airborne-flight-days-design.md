# Surface flight days that report a deployment but no airborne time

**Date:** 2026-07-01
**Status:** Design (approved, pre-implementation)

## Problem

`lib/computeVerdicts.ts` derives the set of flight days **only** from the committed
field-qa airborne report (`flightDates = [...airborneByDate.keys()]`). The airborne
figure is Claude-extracted from the `#field-qa` "Звіт" reports. When a report states a
deployment window and drone count but **no quantified airborne/flight time** (e.g.
`Звіт 21.06.2026 А+Серж 17:00-20:00 … Знімали датасети, але вони не записались`), the
extractor produces no airborne value, so that date never enters `airborneByDate` → no
`DayVerdict` is created → no verdict, no Slack message. The day is silently dropped
("пропущено") — even though a flight with a failed/absent recording is exactly the case
that most needs a human review.

Concrete instance: **2026-06-21** (see `verdict-drops-no-airborne-days` memory). It was
posted manually as a one-off; this spec makes such days surface natively.

`airborneMinutes` is the *actual drone flight time* (~30–45 min/day), **not** the
deployment window (~3–4 h). They are different quantities; a deployment window cannot
substitute for airborne minutes.

## Scope

- **In scope:** the field-verdict pipeline (`computeVerdicts`) and the published Slack
  message (`verdictPublish`), plus the report's table/CSV surfaces.
- **Out of scope (YAGNI):** `field-bonus` (separate model + gate — untouched); the
  Claude field-qa extractor (unchanged — we do not try to make it invent airborne time).

## Design

### 1. Model — `lib/fieldDayVerdict.ts`

Extend the day with two fields:

```ts
export interface DayVerdict {
  // … existing fields …
  /** false when the day was surfaced from a "Звіт" that reported no airborne time. */
  airborneReported: boolean;
  /** Reported deployment window, when known (for the honest message). */
  deployWindow?: { start: string; end: string };
}
```

`VerdictInput` gains `airborneReported?: boolean` (defaults to `true`) and
`deployWindow?: { start: string; end: string }`.

`verdictForDay`'s **status logic is unchanged**: an airborne-unknown day passes
`airborneMinutes: 0`, so `ratio` is `null`, `videoOk` is `false`, and the existing branch
yields `PENDING` within grace / `NEEDS_REVIEW` after — which is exactly right (the ratio
gate cannot be evaluated, so a human decides). The only behavioral change: when
`airborneReported === false`, the airborne reason string becomes
`"flight reported but airborne time not recorded"` instead of
`"no airborne time recorded for the day"`, and `deployWindow` is echoed onto the returned
day. `verdictForDay` continues to return `roster: []` (the orchestrator fills crew).

Reasons stay **English** in the model (internal); Ukrainian is rebuilt at post time
(existing convention).

### 2. Pure flight-day union — new helper (testable)

`computeVerdicts` is a DB/Vimeo-backed orchestrator with no unit test, so the new
date-merging logic lives in a **pure, unit-tested helper** (added to
`scripts/fieldVerdictReport.ts`, which already houses the pure verdict helpers, or a small
sibling pure module — implementer's call, but it MUST be pure and tested):

```ts
export interface FlightDayInput {
  date: string;
  airborneMinutes: number;
  airborneReported: boolean;
  deployWindow?: { start: string; end: string };
}

/**
 * Ordered flight days = union of dates with a committed airborne figure and dates
 * with a parsed "Звіт" that has a deployment window (deployMin != null). A date in
 * the airborne report keeps airborneReported=true and its real minutes (precedence);
 * a parsed-only date gets airborneMinutes=0, airborneReported=false, and its window.
 */
export function mergeFlightDays(
  airborneByDate: Map<string, number>,
  parsed: { flightDate: string; deployMin: number | null; start: string | null; end: string | null }[],
): FlightDayInput[]
```

Rules:
- Include every key of `airborneByDate` (airborneReported = true, minutes = its value,
  deployWindow from the parsed report for that date if start+end present).
- Additionally include each parsed report whose `deployMin != null` and whose
  `flightDate` is **not** already in `airborneByDate` (airborneReported = false,
  minutes = 0, deployWindow = {start, end} when both present).
- Parsed reports with `deployMin == null` are ignored (the deployment-window gate).
- Sorted ascending by date.

### 3. Orchestrator — `lib/computeVerdicts.ts`

Replace `const flightDates = [...airborneByDate.keys()].sort()` and the subsequent
`.map` with iteration over `mergeFlightDays(airborneByDate, parseMonth(...))`. Per
`FlightDayInput`, pass `airborneReported` + `deployWindow` into `verdictForDay`, and keep
the existing dataset-status / resolution / roster-correction steps unchanged. Crew still
comes from `parsedByDate` + corrections exactly as today (a parsed-only day already has a
parsed report, so its crew resolves normally).

### 4. Message — `lib/verdictPublish.ts`

- `ukrainianGaps(day)`: when `!day.airborneReported`, the airborne gap becomes
  `політ відбувся${win ? ` (${start}–${end})` : ""}, але час у повітрі не вказано`
  (instead of `немає записаного часу в повітрі за день`).
- The NEEDS_REVIEW render's trailing parenthetical currently is
  `(відео ${vid} хв / ${air} хв у повітрі, ${ds})`. When `!day.airborneReported`, drop the
  `/ ${air} хв у повітрі` segment → `(відео ${vid} хв, ${ds})`, so no misleading
  `0 хв у повітрі` appears. The crew suffix (`withRosterSuffix`) is unchanged.
- ACCEPTED / ACCEPTED_EXCEPTION renders need no change (an airborne-unknown day can never
  be ACCEPTED — no ratio; and PENDING is never published). Only the NEEDS_REVIEW render
  branches on `airborneReported`.

### 5. Report surfaces — `scripts/fieldVerdictReport.ts`

The new fields serialize into the report JSON automatically (`VerdictReport.days` is
`DayVerdict[]`). For the human surfaces, show `n/a` instead of `0` when
`!airborneReported`:
- Table (`toTable`): the `Air(m)` column renders `n/a`.
- CSV (`toCsv`): the `airborneMinutes` column renders `n/a`. (CSV is intentionally lossy;
  `airborneReported` itself is not added as a column.)

The web verdict view reads the same JSON; it needs no change to remain correct (it renders
reasons; airborne shows 0 — acceptable, out of scope to prettify here).

### 6. Testing

- `lib/fieldDayVerdict.test.ts`: `airborneReported: false` → reason
  `"flight reported but airborne time not recorded"`, `ratio` null, status `PENDING`
  within grace and `NEEDS_REVIEW` after; `deployWindow` echoed onto the day; default
  `airborneReported` is `true` (existing cases unaffected).
- `mergeFlightDays` unit tests: airborne-only date; parsed-only date **with** a window
  (included, airborneReported false); parsed-only date **without** a window (excluded);
  a date in both (airborne precedence, airborneReported true, minutes preserved); sort
  order.
- `lib/verdictPublish.test.ts`: NEEDS_REVIEW render for an `airborneReported: false` day
  shows `політ відбувся (17:00–20:00), але час у повітрі не вказано`, contains no
  `хв у повітрі` in the trailing parenthetical, and still appends the crew suffix.
- `scripts/fieldVerdictReport.test.ts`: table/CSV show `n/a` for an unreported-airborne
  day.

## Rollout note — the manual 06-21

06-21 was posted manually and recorded in the published log (`verdict:2026-06:2026-06-21`).
After this ships and `npm run field-verdict -- --write` runs for June, 06-21 becomes a
native verdict day (airborneReported false, window 17:00–20:00, crew Андріан+Сергій from
the parser). A subsequent `npm run field-backfill -- --publish --channel field-qa` will
re-render that one message to the canonical auto format and edit it in place (same
published-log entry — no duplicate; idempotent thereafter). Running the backfill after
merge is a manual operator step, not part of this code change.

## Files touched

- **Edit:** `lib/fieldDayVerdict.ts` (model + reason), `lib/computeVerdicts.ts` (use
  `mergeFlightDays`), `lib/verdictPublish.ts` (honest render), `scripts/fieldVerdictReport.ts`
  (`mergeFlightDays` helper + `n/a` in table/CSV).
- **Edit (tests):** `lib/fieldDayVerdict.test.ts`, `lib/verdictPublish.test.ts`,
  `scripts/fieldVerdictReport.test.ts` (+ new `mergeFlightDays` cases, colocated with the
  helper's file).
