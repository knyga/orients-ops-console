---
name: bonus-report
description: Use when asked to generate or read the field-bonus payout report for a whole period — the settled per-person totals, who gets paid, the period total, and which flight days were voided (and why). For per-person "what did X earn" questions use the field-bonus skill instead.
---

# Bonus Report (per period)

Produce and read the period field-bonus payout: the number to actually pay each
person, plus a void audit of days that earned nothing.

## Gate (must-know)

A flight day pays only if its field-verdict status is ACCEPTED or
ACCEPTED_EXCEPTION — the **unified qualification gate**, computed once by
`field-verdict` and consumed as-is here (not re-derived). All four axes must
hold:

1. deployment ≥ **3 hours**, and
2. recorded video ≥ **max(2 minutes, 50% of airborne)**, and
3. a **drone-count / production report was posted in #field-qa that day**
   (e.g. `R&D - 1шт вартовий`, `Демонстраційні - 8шт`, `Перевірені`, `15ка - 1шт`), and
4. a **#datasets notice** for the day.

A sub-3h deployment, a missing drone-count report, or an admin-declined
dataset is a **hard machine REJECT** — no-pay for the whole crew, with no
automatic rescue. Only an explicit approver instruction (a confirmed reply in
the verdict thread, or `field-instructions`) can override a REJECT into
ACCEPTED_EXCEPTION; do not propose any other rescue path. Days that haven't
settled yet (PENDING/NEEDS_REVIEW) are listed unpaid in `pendingDays`, not
`voidedDays` — this is separate from the monthly `>3 drones lost` team
cutoff, which zeroes the whole period.

The drone-count classifier returns structured per-person entries
(`classifyDroneCount → { present, entries, forDate }`), also used to render the
verdict message's `🛸 Дрони:` line. The drone-count check itself now flows
through the verdict — it's computed once by `field-verdict`
(`droneReportPresent`, from `days[].droneReport`) and consumed as-is here; the
duplicate live `classifyDroneCount` call that used to run inside
`computeBonuses` has been deleted.

## How to generate the report

Run these in order (all default to the current Kyiv month if dates are omitted):

```bash
npm run slack-sync                                   # mirror #field-qa (Звіт reports + drone-count posts)
npm run field-bonus -- --start 2026-06-01 --end 2026-06-30 --write # compute + commit the report
```

`--write` persists `reports/field-bonus/<period>.{json,csv}`. The JSON is the
payout report and the web render source.

## How to read it

From `reports/field-bonus/<period>.json` (or `npm run field-bonus -- … --format table`):

- `total` — the summed net payout (0 if `teamZeroed`).
- `people[]` — per person: `{ name, trips, early, weekend, gross, penaltyPct, net }`. **`net` is the amount to pay.**
- `teamZeroed` — true iff >3 drones lost in the period (whole period zeroed).
- `voidedDays[]` — `{ date, roster, reason }` for every REJECTED day with its
  verdict reason (any axis: deploy < 3h, missing drone-count report,
  admin-declined dataset, or an approver rejection).
- `pendingDays[]` — unsettled days with the amount at stake — chase these before month-end payout.
- `flags[]` — includes `no_drone_count` entries and `counted_no_video` warnings.

## Prerequisites

- `VIMEO_TOKEN`, `ANTHROPIC_API_KEY`, `POSTGRES_URL` in `.env` (video minutes,
  the drone-loss + drone-count classifiers, and roster aliases). Missing any →
  the CLI exits non-zero with a clear message.
- Run `npm run slack-sync` first — the CLI reads the #field-qa mirror.

## Related

- `field-bonus` skill — per-person questions ("what did X earn in May?").
