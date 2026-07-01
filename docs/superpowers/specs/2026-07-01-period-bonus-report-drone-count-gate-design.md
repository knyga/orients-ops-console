# Period Bonus Report + drone-count gate — design

Date: 2026-07-01
Status: proposed

## Problem

We want to "generate a report per period on bonuses" — the settled, per-person
field-bonus payout for a month (or arbitrary window), trustworthy enough to pay
from. Two gaps stand between us and that today:

1. **A missing daily drone-count report is not enforced.** In #field-qa the team
   posts a daily production/drone-count tally, e.g.:

   ```
   Андріан R&D - 1шт вартовий+ 1 шт азимут (3ремонт : термалка азимут вартовий)
   Любомир R&D -1шт вартовий 1шт азимут 1шт термалка
   Демонстраційні - 8 шт (Перевірені - 8шт ( 2 шт азимут)
   15ка - 1шт
   ```

   Policy: **if a day has no drone-count report, nobody earns a bonus that day.**
   The current `field-bonus` computation ignores this entirely, so it can
   over-pay days that were never properly reported.

2. **No skill frames the period payout.** `field-bonus` today answers per-person
   Q&A ("what did X earn"). There is no documented flow for *generating and
   reading the period bonus report* as a payroll deliverable, including which
   days were voided and why.

The earlier "consolidated across bonus types" framing collapsed during
brainstorming: the assemblers' "Бонус за готові дрони" is **not a payout** — it
is exactly this drone-count *gate*. There is only one bonus stream (deployment).

## Decisions (from brainstorming)

- **Void scope**: a missing drone-count report voids **that day, for everyone**
  (the whole crew of that day). Other days are unaffected. Not a period-wide
  zeroing (that remains reserved for the >3-drones-lost team cutoff).
- **Detection**: a **Claude classifier** decides whether a given day's #field-qa
  messages contain a genuine drone-count/production report (vs a flight-hours
  Звіт or chatter), mirroring the existing `lib/lossExtract.ts` drone-loss
  classifier.
- **Where the gate lives**: **inside the pure `computeBonuses` calculator** and
  the `computeBonusReport` orchestration — the one source of truth. That way
  `field-bonus`, `who`, and the `--notify` DMs all reflect the gate
  automatically. No parallel bonus CLI/report is built.
- **Deliverable shape**: extend the **existing** `field-bonus` artifact (JSON +
  CSV + web tab) with a void audit, and add a **new `bonus-report` skill** for
  generating/reading the period payout. No new `reports/bonus/` feature.
- **Attribution**: a drone-count post is attributed to its **own Kyiv post-day**
  (same-day), *not* lagged like Vimeo uploads — these are same-day production
  tallies. (Open point flagged for review; see Risks.)

## Architecture

Three layers, smallest blast radius first.

### 1. Pure calculator — `lib/fieldBonus.ts`

`computeBonuses(...)` gains one input and one condition.

- New field on the input object:
  `droneCountByDate?: Record<string, boolean>` — for each flight date, `true` iff
  a drone-count report was found that day. **Optional**, with a deliberate
  two-level semantics:
  - **Field absent** (`input.droneCountByDate === undefined`) ⇒ the gate is a
    **no-op** (every day treated as reported). Preserves existing callers/tests.
  - **Field present** ⇒ the gate is active; a date **missing from the map** is
    treated as `false` (voided). Production always supplies it, populated for
    every otherwise-counted day.
- New gate term:
  `const droneCountReported = input.droneCountByDate == null || input.droneCountByDate[r.flightDate] === true;`
  and `const counted = hoursOk && videoOk && droneCountReported;`
- **Reason precedence** (unchanged order, one new terminal reason):
  `counted` → else `deploy<3h` → else `video<2min` → else **`no-drone-count`**.
  The new reason therefore surfaces *only* on days that pass hours+video but lack
  the report — precisely the auditable "would have counted but for the missing
  report" case.
- **New flag kind** `"no_drone_count"`: pushed for every day where
  `hoursOk && videoOk && !droneCountReported`, with detail
  `"deploy Xmin + video Ymin OK but no drone-count report in #field-qa"`. This is
  the high-signal audit entry finance/ops needs.
- Everything downstream (per-person tally, flight groups, penalties) already keys
  off `d.counted`, so voided days drop out of trips, early/weekend, and the
  loss-window sequence with no further change.

**Safety invariant**: the pure function treats *missing* map entries as `false`
(voided). This is safe because the orchestration (below) classifies **every
otherwise-counted day**, so an otherwise-counted day always has an explicit
entry; only already-non-counted days fall through to the `false` default, where
the gate is moot. The classifier throws on misconfiguration (see below) rather
than silently returning `false`, so we never silently void a whole period.

### 2. Classifier — `lib/droneCountReport.ts` (+ `lib/droneCountReportPrompt.ts`)

Mirrors `lib/lossExtract.ts` / `lib/lossExtractPrompt.ts` exactly.

- `lib/droneCountReportPrompt.ts` (pure, unit-tested): exports
  `DRONE_COUNT_TOOL` (an `Anthropic.Tool` named `record_drone_count_report` with
  `{ present: boolean, note: string }`) and
  `buildDroneCountPrompt(dayText: string): string`. The prompt explains what a
  drone-count/production tally looks like (per-unit counts like `R&D - 1шт
  вартовий`, `Демонстраційні - 8шт`, `Перевірені`, `15ка - 1шт`) and that a
  flight-hours "Звіт" or general chatter is **not** a drone-count report.
- `lib/droneCountReport.ts` (`server-only`): `classifyDroneCount(dayText:
  string): Promise<{ present: boolean; note: string }>`. Empty text →
  `{ present: false, note: "" }`. Throws if `ANTHROPIC_API_KEY` is unset (same
  wording pattern as `extractLoss`). Uses the same model constant as the other
  field classifiers.

### 3. Orchestration — `lib/computeBonuses.ts`

`computeBonusReport(period, opts)` gains a classification pass before calling the
pure calculator:

1. It already loads `messages` (the #field-qa mirror) and `reports` (parsed
   Звіт). Group `messages` by **Kyiv post-date** using the existing field-tz
   date helper (the same one behind `videoUploadDate` / `todayInFieldTz`).
2. Compute the set of **otherwise-counted** dates: report days where
   `deployMin >= 180` and `videoMinutesByDate[date] >= 2`. (Bounds Claude calls
   to days that could actually be voided.)
3. For each such date, concatenate that day's messages' text and call
   `classifyDroneCount`. Build `droneCountByDate[date] = present`.
4. Pass `droneCountByDate` into `computeBonuses(...)`.
5. `log(...)` a one-line summary: `field-bonus: N/M reported days have a
   drone-count report` and list voided dates.

No change to the `--write` path: the same extended `BonusReport` JSON is written
to `reports/field-bonus/<period>.json` and the CSV is unchanged (per-person).

### Report shape (`BonusReport`)

The JSON is the web render source and the shape `GET /api/field-bonus` returns.
Changes are **additive** (backward compatible):

- `DayBonus.reason` may now be `"no-drone-count"`.
- `Flag.kind` union gains `"no_drone_count"`.
- Optional convenience top-level field `voidedDays?: { date: string; roster:
  string[]; reason: string }[]` — days that would have counted but were voided by
  the drone-count gate, extracted for easy audit rendering. (Derivable from
  `days` + `flags`; provided to keep the web/CLI/skill from re-deriving it.)

The flat CSV (`person,trips,early,weekend,gross,penaltyPct,net`) is **unchanged**
— the void audit is per-day, not per-person, and CSV is intentionally lossy.

### Web — `app/(dashboard)/field-bonus/page.tsx`

The page already renders `report.people` / `report.total` / `report.teamZeroed`
/ `report.flags`. Add a **"Voided days" audit section** that lists
`report.voidedDays` (or filters `days` by `reason === "no-drone-count"`), showing
date, crew, and "no drone-count report". Also render the new `no_drone_count`
flags in the existing flags area. No new route — `GET /api/field-bonus` already
serves the (now extended) JSON verbatim through the hybrid path.

### Skill — `.claude/skills/bonus-report/SKILL.md`

New skill, scope crisply distinct from `field-bonus` (which stays per-person
Q&A):

- **Description / when to use**: "generate and read the *period* bonus payout
  report — totals, who gets paid, and which days were voided and why."
- **How**: the full period workflow —
  `npm run slack-sync` → `npm run field-qa -- --write` →
  `npm run field-bonus -- --start … --end … --write`, then read the artifact
  (`reports/field-bonus/<period>.json`): `total`, `people[].net`, `teamZeroed`,
  and the **void audit** (`voidedDays` / `no_drone_count` flags).
- **Explain the gate** in the domain section: a day counts only if
  `deploy ≥ 3h AND video ≥ 2min AND a drone-count report was posted in #field-qa`
  that day; a missing drone-count report voids that day for the whole crew.
- Cross-link to the `field-bonus` skill for per-person questions.

## Testing

- `lib/fieldBonus.test.ts`: add cases — (a) otherwise-counted day with
  `droneCountByDate[date] = false` ⇒ `counted === false`, `reason ===
  "no-drone-count"`, a `no_drone_count` flag, and that day's crew earns nothing;
  (b) `= true` ⇒ unchanged behavior; (c) a `deploy<3h` day with no report ⇒
  reason stays `deploy<3h` (gate precedence), no `no_drone_count` flag; (d)
  `voidedDays` is populated correctly.
- `lib/droneCountReportPrompt.test.ts`: prompt/tool schema shape; empty text
  handling contract.
- Existing `lib/fieldBonus.test.ts` cases keep passing because
  `droneCountByDate` is optional and, when omitted, the default must **not**
  retroactively void — see Risks: for backward-compatible tests that omit the
  map, treat `undefined` map as "gate disabled" (all reported), whereas an
  explicitly-supplied map with a missing key is `false`. Concretely:
  `computeBonuses` gates only when `input.droneCountByDate` is provided; when the
  field is absent the gate is a no-op. Production always provides it.

## Risks / open points (for spec review)

1. **Attribution lag.** We assume the drone-count post lands on the flight's Kyiv
   day. If production tallies sometimes post the next morning, otherwise-counted
   days could be wrongly voided. Mitigation option if this bites: widen the
   lookup to `flightDate` **or** the next working day, mirroring the video-upload
   lag rule. Defaulting to same-day for v1 — **confirm.**
2. **Classifier cost.** Bounded to otherwise-counted days only; typically a
   handful per month. Acceptable.
3. **Two bonus skills.** `field-bonus` (per-person) vs `bonus-report` (period
   payout). Kept distinct by description; alternative is folding into
   `field-bonus`. Chosen: separate skill, per the brainstorming decision to "add
   a new skill."
4. **Backward-compat of the gate default** (see Testing) — the no-op-when-absent
   rule must be implemented deliberately so existing tests and any other
   `computeBonuses` caller are unaffected.
