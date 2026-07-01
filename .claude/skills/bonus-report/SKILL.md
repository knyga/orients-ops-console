---
name: bonus-report
description: Use when asked to generate or read the field-bonus payout report for a whole period — the settled per-person totals, who gets paid, the period total, and which flight days were voided (and why). For per-person "what did X earn" questions use the field-bonus skill instead.
---

# Bonus Report (per period)

Produce and read the period field-bonus payout: the number to actually pay each
person, plus a void audit of days that earned nothing.

## Gate (must-know)

A flight day counts toward bonuses only if **all three** hold:

1. deployment ≥ **3 hours**, and
2. recorded video ≥ **2 minutes**, and
3. a **drone-count / production report was posted in #field-qa that day**
   (e.g. `R&D - 1шт вартовий`, `Демонстраційні - 8шт`, `Перевірені`, `15ка - 1шт`).

A missing drone-count report **voids that day for the whole crew** (reason
`no-drone-count`; surfaced as a `no_drone_count` flag and in `voidedDays`). This
is separate from the monthly `>3 drones lost` team cutoff, which zeroes the
whole period.

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
- `voidedDays[]` — `{ date, roster, reason }` for days voided by the drone-count gate.
- `flags[]` — includes `no_drone_count` entries and `counted_no_video` warnings.

## Prerequisites

- `VIMEO_TOKEN`, `ANTHROPIC_API_KEY`, `POSTGRES_URL` in `.env` (video minutes,
  the drone-loss + drone-count classifiers, and roster aliases). Missing any →
  the CLI exits non-zero with a clear message.
- Run `npm run slack-sync` first — the CLI reads the #field-qa mirror.

## Related

- `field-bonus` skill — per-person questions ("what did X earn in May?").
