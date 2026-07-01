# Represent no-fly telemetry days in the verdict

**Date:** 2026-07-01
**Status:** Design (approved, pre-implementation)

## Problem

The Stats-bot daily telemetry PNG (`today_full_summary.png`, posted in #field-qa as
"Статистика польотів за <date>") is **already** vision-read by `lib/flightExtract.ts`
→ `{ flew, airborneSeconds, flights }`, and the field-qa report's `airborneMinutes`
comes from it (per `2026-06-19-field-qa-bot-image-flight-time-design.md`). Ingestion is
not the gap.

The gap: **no-fly days are discarded twice.**
- `scripts/fieldQa.ts:86` — `if (!a.flew || a.airborneSeconds <= 0) continue;`
- `scripts/fieldQaReport.ts:92` (`validateDays`) — drops rows with `airborneSeconds <= 0`.

So a telemetry card reading *flew=Ні, 0 airborne* (e.g. **2026-06-21**) is read, then
dropped → no field-qa row → no verdict day → silently missing ("пропущено"). A no-fly
day is a *known zero* (objective telemetry), not missing data, and it is exactly the case
worth surfacing for review.

This complements the already-shipped "surface deployment-window days with no airborne
figure" feature (commits 253f916→70a4419), which handles the *no-telemetry* case. This
spec handles the *telemetry-says-no-fly* case and the Звіт-vs-telemetry conflict.

## Decisions (confirmed with the user)

- A telemetry no-fly day → verdict **NEEDS_REVIEW** (never auto-reject; a human decides).
- **Telemetry is authoritative**; when the human Звіт conflicts (claims a flight the
  telemetry says did not happen), surface the conflict.
- Scope = field-qa retention + verdict representation. No new ingestion, no new data
  source, no field-bonus change.

## Design

### 1. Retain no-fly days in the field-qa report

`scripts/fieldQaReport.ts`:
- `ExtractedDay` gains `flew: boolean`. `ReportDay` gains `flew: boolean`.
- `validateDays`: keep a row when the date matches `DATE_RE` **and** `airborneSeconds`
  is finite and `>= 0` (was `> 0`). Still dedupe by date, keeping the first, smaller
  `sourceTs` on ties. (Every row originates from a "Статистика польотів" card, so a 0 is
  a genuine telemetry reading, not noise.)
- `buildReport`: carry `flew` onto each `ReportDay`. For a no-fly day
  `flightHours`/`airborneMinutes` compute to 0 naturally.
- `toInputsCsv`: **exclude no-fly days** — emit a row only when `d.airborneSeconds > 0`.
  The fieldops video-reconciliation inputs (`reports/field-ops/inputs/<period>.csv`) stay
  exactly as today; no-fly days live only in the report JSON that feeds the verdict.
- `totals.days`: count only days that flew (`airborneMinutes > 0`), preserving the
  field's current "flight days" meaning; `totals.flightHours` is unchanged (no-fly days
  add 0).

`scripts/fieldQa.ts`:
- Remove the `if (!a.flew || a.airborneSeconds <= 0) continue;` guard. Push every
  processed summary as `{ date, airborneSeconds: a.airborneSeconds, flights: a.flights,
  flew: a.flew, sourceTs: m.ts }`.

### 2. Thread `flew` into the verdict

`lib/computeVerdicts.ts`:
- Widen the local `FieldQaReport` read type (currently `days: { date; airborneMinutes }[]`)
  to also read `flew: boolean` and `flights: number`.
- Build `flewByDate: Map<string, boolean>` (and, if useful for the message, a flights
  lookup) from `fq.days`.
- When constructing each day, pass `flew` (and `flights`) into `verdictForDay`. The
  existing `airborneByDate` now includes no-fly dates with `airborneMinutes: 0`, so
  `mergeFlightDays` yields them as `airborneReported: true` — correct (telemetry reported
  it, the value is 0). `deployWindow` still comes from the parsed Звіт (enables the
  conflict clause).

`lib/fieldDayVerdict.ts`:
- `VerdictInput` + `DayVerdict` gain `flew?: boolean` and `flights?: number`.
- `verdictForDay`: status logic **unchanged** (a 0-airborne day is already NEEDS_REVIEW
  past grace / PENDING within). The airborne reason string, when `ratio === null`,
  becomes: `flew === false` → `"telemetry reports 0 flights for the day"`; else the
  existing `airborneReported ? "no airborne time recorded for the day" : "flight reported
  but airborne time not recorded"`. `flew`/`flights` echo onto the returned day.

### 3. Three-case honest message

`lib/verdictPublish.ts` — extends the already-shipped `airborneReported`/`deployWindow`
handling. In `ukrainianGaps`, the `ratio === null` branch resolves in priority order:
- **`flew === false`** (telemetry no-fly): `за телеметрією 0 польотів за день`; if a
  `deployWindow` also exists (Звіт claims a flight — conflict): append
  ` (звіт повідомляє про виліт ${start}–${end} — розбіжність із телеметрією)`.
- **`airborneReported === false`** (no telemetry card, deployment-window only):
  `політ відбувся${window ? ` (${start}–${end})` : ""}, але час у повітрі не вказано`
  (already shipped).
- **else** (`airborneReported`, airborne genuinely 0 without a flew signal):
  `немає записаного часу в повітрі за день` (already shipped).

The NEEDS_REVIEW trailing parenthetical: when `flew === false` OR `!airborneReported`,
omit the `/ N хв у повітрі` clause (avoid the misleading `0 хв у повітрі`); keep
`(відео X хв, DS)`. ACCEPTED / ACCEPTED_EXCEPTION renders unchanged (a no-fly day is
never ACCEPTED). Crew suffix unchanged.

### 4. Report surfaces

`scripts/fieldVerdictReport.ts`: the verdict table/CSV already render `n/a` for
unreported airborne. A no-fly day has `airborneReported: true`, `airborneMinutes: 0`, so
it shows `0`. Add a `flew` signal to the human surfaces: a `flew` CSV column on the
field-qa report (Task 1's report), and in the verdict table/CSV surface the no-fly case
via the reason string (already carries "telemetry reports 0 flights"). No web change
(reads the same JSON; reasons carry the truth).

### 5. Testing

- `scripts/fieldQaReport.test.ts`: `validateDays` keeps a `flew:false, airborneSeconds:0`
  row and drops a genuinely-invalid date; `toInputsCsv` omits the no-fly day; `buildReport`
  carries `flew` and `totals.days` counts only flown days.
- `lib/fieldDayVerdict.test.ts`: `flew:false` → reason `"telemetry reports 0 flights for
  the day"`, status NEEDS_REVIEW past grace; `flew`/`flights` echoed; existing cases
  (default `flew` undefined) unaffected.
- `lib/verdictPublish.test.ts`: no-fly render shows `за телеметрією 0 польотів за день`;
  no-fly **with** a deployWindow shows the conflict clause; no `0 хв у повітрі`; the
  no-telemetry deployment-window case still renders its own wording; flew+airborne>0
  regression unchanged; crew suffix intact.

### 6. Downstream compile hygiene

Adding `flew` to `ReportDay` and `flew`/`flights` to `DayVerdict` (both optional on
`DayVerdict`, required-with-value on the field-qa `ReportDay`) — update any test mocks /
literals that construct these so `tsc --noEmit` stays clean (same discipline as the prior
`airborneReported` change, which broke several mocks).

## Rollout note — 06-21

06-21 has a telemetry card (flew=Ні) **and** a Звіт (deployment 17:00–20:00). After merge,
`npm run field-qa -- --write` re-extracts (now retaining 06-21 as flew=false, airborne 0),
`npm run field-verdict -- --write` produces the day, and `npm run field-backfill --publish
--channel field-qa` re-renders the live message from "no airborne data" to the accurate
`за телеметрією 0 польотів … (звіт повідомляє про виліт 17:00–20:00 — розбіжність)`.
Operator step, post-merge — not part of this code change.

## Files touched

- **Edit:** `scripts/fieldQaReport.ts` (ExtractedDay/ReportDay `flew`, `validateDays`,
  `toInputsCsv`, `buildReport`, `totals`), `scripts/fieldQa.ts` (drop the skip guard),
  `lib/fieldDayVerdict.ts` (`flew`/`flights` + reason), `lib/computeVerdicts.ts`
  (read `flew`, pass through), `lib/verdictPublish.ts` (three-case message).
- **Edit (tests):** `scripts/fieldQaReport.test.ts`, `lib/fieldDayVerdict.test.ts`,
  `lib/verdictPublish.test.ts`, plus any mock/literal fixups for the new fields.
