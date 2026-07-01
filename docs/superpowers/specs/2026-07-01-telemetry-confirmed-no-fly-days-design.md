# Read telemetry to distinguish a confirmed no-fly day from missing airborne time

**Date:** 2026-07-01
**Status:** Design (approved, pre-implementation)

## Problem

The predecessor spec (`2026-07-01-surface-no-airborne-flight-days-design.md`) made the
verdict pipeline surface a day that has a parsed "Звіт" deployment window but no airborne
figure — as `NEEDS_REVIEW` with the honest gap `політ відбувся (HH:MM–HH:MM), але час у
повітрі не вказано`. That fix **trusts the human "Звіт"** and does not read telemetry.

But there is a second, authoritative source the pipeline ignores: the stats bot's own
daily **"Статистика польотів за &lt;date&gt;"** card in `#field-qa`, which reports
`Сьогодні літали` (Так/Ні), `Час в повітрі (сек)`, and `Кількість польотів`. For
**2026-06-21** that card says `Ні / 0 / 0` — the drones **did not fly**. The airborne
figure is a *known zero*, not missing data. The human "Звіт" for the same day
(`17:00-20:00`, "облітали 4 дрони") **conflicts** with the telemetry.

The infrastructure to read the card already exists and works:

- `lib/flightTextParse.parseAirborneFromText` — deterministic read when the bot posts the
  card as a text body (`{ flew, airborneSeconds, flights }`).
- `lib/flightExtract` + `lib/flightExtractPrompt` — Claude-vision read of the card image
  (`today_full_summary.png`) as a fallback for image-only days (06-21 is image-only).

The gap is downstream of the read: `scripts/fieldQa.ts:86` and `fieldQaReport.validateDays`
both **discard** any `!flew || airborneSeconds <= 0` day, because the field-qa report was
designed as a flight-*hours* input where zero-hour days are noise. So a telemetry-confirmed
`0` never lands in `reports/field-qa`. `mergeFlightDays` then re-derives 06-21 from the
"Звіт" alone, sees `airborneByDate.has("2026-06-21") === false`, and sets
`airborneReported: false` → the "не вказано" wording. **A known zero is presented as
missing, and the pipeline sides with the human report over contradicting telemetry.**

This is a `distrust-human-written-content` case: the telemetry stat is the objective
airborne source; the Claude-extracted "Звіт" is a claim.

## Decisions (locked with the user)

1. **Correct the live 06-21 message** to reflect the real telemetry (0 flights / 0 min
   airborne / did-not-fly), keeping `NEEDS_REVIEW`.
2. **A deployment-window day with telemetry-confirmed 0 airborne → `NEEDS_REVIEW`** with
   honest no-fly wording. Whether a deployment with 0 airborne earns a bonus is a human
   decision made per day (exception / approver override), not an automatic verdict.
3. **Fix shape = minimal: extend the field-qa report.** Keep no-fly days *out* of the
   flight-hours inputs CSV, but *include* them in `reports/field-qa/<period>.json` with a
   `flew` marker, so the existing `computeVerdicts` read path picks them up. (Rejected: a
   new first-class telemetry report, and having `computeVerdicts` read telemetry itself —
   both larger, and YAGNI given the existing `readReportJson("field-qa")` wiring.)

## Scope

- **In scope:** the field-qa extraction (`scripts/fieldQa.ts`, `lib/fieldQaReport.ts`),
  `mergeFlightDays` + the `FieldQaReport` read type (`scripts/fieldVerdictReport.ts`,
  `lib/computeVerdicts.ts`), the no-fly verdict reason (`lib/fieldDayVerdict.ts`), the
  Ukrainian wording (`lib/verdictPublish.ts`), and correcting the live 06-21 message via
  the existing `field-backfill` machinery.
- **Out of scope (YAGNI):** `field-bonus` (separate model + gate — untouched; a no-fly day
  is handled per-day by a human via `NEEDS_REVIEW`/exception); the fieldops **inputs CSV**
  contract (still excludes zero-hour days); the nightly pipeline; a standalone telemetry
  report.

## Design

### 1. field-qa extraction keeps no-fly days — `scripts/fieldQa.ts`, `lib/fieldQaReport.ts`

`ExtractedDay` gains `flew: boolean`. The extraction still reads every "Статистика
польотів" card (text parse, vision fallback), but:

- **Keep** a day the telemetry *successfully read as no-fly* (`flew: false,
  airborneSeconds: 0`). **Skip** only days we could not read at all (no text match and no
  image / vision failure) — i.e. remove the blanket `if (!a.flew || a.airborneSeconds <= 0)
  continue;` and skip only on a genuinely absent read.
- `validateDays` drops the `airborneSeconds <= 0` rejection (it still validates the date
  shape, finiteness, and dedupes by date). A read `0` for a `flew: false` day is valid.
- The **report JSON** `days[]` entries carry `airborneMinutes: 0, flights: 0, flew: false`
  for no-fly days (and `flew: true` for flown days).
- `toInputsCsv` (the `reports/field-ops/inputs/<period>.csv` fieldops feed) **filters to
  flown days** (`flew && airborneSeconds > 0`) — the reconcile input must not gain 0-hour
  rows.
- `report.totals` (`days`, `flightHours`) count **flown days only**, unchanged in meaning.

### 2. Read type + merge — `lib/computeVerdicts.ts`, `scripts/fieldVerdictReport.ts`

- The `FieldQaReport` interface in `computeVerdicts.ts` gains `flew` on its day shape
  (read-only use). No-fly days are now present in `airborneByDate` with value `0`.
- `mergeFlightDays` is **unchanged in logic**: because 06-21 is now in `airborneByDate`,
  `airborneReported = airborneByDate.has(date)` correctly becomes `true`, and
  `airborneMinutes = 0`. Its `!airborneReported` branch stays meaningful for the residual
  case — a "Звіт" deployment window with **no telemetry card at all**.

No new `DayVerdict` field is needed: `airborneReported && ratio === null` already ⟺
`airborneMinutes === 0` ⟺ a telemetry-confirmed no-fly day, because
`ratio = airborneMinutes > 0 ? … : null`. After this change, an `airborne 0` in the
field-qa report only originates from a telemetry-read no-fly day.

### 3. Verdict reason — `lib/fieldDayVerdict.ts`

Status logic is unchanged (still `NEEDS_REVIEW` after grace when the video/dataset gate is
unmet). Only the English reason for the `airborneReported && ratio === null` branch changes
(internal web/report text):

- from `"no airborne time recorded for the day"`
- to `"drones did not fly (0 flights, 0 min airborne)"`

The `!airborneReported` branch (`"flight reported but airborne time not recorded"`) is
unchanged.

### 4. Ukrainian wording — `lib/verdictPublish.ts`

In `ukrainianGaps`, the `ratio === null` block splits by `airborneReported`:

- `airborneReported` (telemetry no-fly) → reword from
  `"немає записаного часу в повітрі за день"` to a truthful no-fly line that also flags the
  "Звіт" conflict when a deployment window is present:
  > `за телеметрією польотів не було (0 хв у повітрі)` + (if `deployWindow`) `, хоча у звіті — виїзд {start}–{end}`
- `!airborneReported` (no telemetry) → **unchanged**:
  `політ відбувся ({window}), але час у повітрі не вказано`.

Resulting 06-21 message:

> ⚠️ 2026-06-21 (неділя) — потрібна перевірка: за телеметрією польотів не було (0 хв у повітрі), хоча у звіті — виїзд 17:00–20:00; немає повідомлення про датасет за цей день. 👥 У полі: Андріан, Сергій.

(The NEEDS_REVIEW `tail` at `verdictPublish.ts:115-116` already renders `0 хв у повітрі`
truthfully for `airborneReported` days; leave it, or drop the redundant airborne clause
from the tail on no-fly days — a wording nicety decided during implementation.)

### 5. Correct the live 06-21 message (no new code)

Reuse the existing `field-backfill` path (re-render via `formatDayMessage` + `chat.update`).
Operational sequence:

1. `npm run slack-sync -- --channel field-qa` — pull the 06-21 card into the mirror.
2. `npm run field-qa -- --start 2026-06-01 --end 2026-06-30 --write` — re-read 06-21's card
   (image-only → Claude vision), now keeping the `0`; commits the field-qa report.
3. `npm run field-verdict -- --start … --end … --write` — 06-21 becomes a real
   `NEEDS_REVIEW` row with no-fly wording.
4. `npm run field-backfill -- --start … --end … --channel field-qa --publish` — re-renders
   the live 06-21 message. It is in the published log and not overridden, so backfill
   targets it. (Dry-run first.)

## Testing (TDD)

- `lib/fieldQaReport` (or `scripts/fieldQaReport`): a no-fly card → day present in the
  report JSON with `flew: false, airborneMinutes: 0`; **absent** from `toInputsCsv`;
  `totals` count flown days only; a flown card still behaves as before.
- `mergeFlightDays`: a date present in `airborneByDate` with value `0` →
  `airborneReported: true, airborneMinutes: 0`; a "Звіт"-only date with no airborne entry
  still → `airborneReported: false`.
- `verdictForDay`: `airborneReported && airborneMinutes === 0` → `NEEDS_REVIEW`, reason
  "drones did not fly …" (not the `< 50%` reason, not the `!airborneReported` reason).
- `formatDayMessage` / `ukrainianGaps`: telemetry no-fly → no-fly UA wording (with the
  deployment-conflict clause when `deployWindow` is set); the `!airborneReported`
  no-telemetry branch preserved verbatim.

## Verification caveat

The local Slack mirror is frozen at 06-20 in the working environment, and a `slack-sync`
run did not advance it. Re-verifying step 5's live re-read and backfill (that 06-21's card
is fetched and the live message is actually rewritten) must be an **explicit verification
step in the plan**, not assumed. In production the mirror/live fetch will contain 06-21.

## References

- Memory: `verdict-drops-no-airborne-days`, `distrust-human-written-content`,
  `field-bonus-model-and-gap`, `video-name-carries-flight-date`.
- Predecessor spec: `2026-07-01-surface-no-airborne-flight-days-design.md`.
- Ukrainian bot messages: `2026-06-28-ukrainian-bot-messages-design.md`.
- Backfill: `2026-06-29-backfill-ukrainian-published-design.md`.
