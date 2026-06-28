---
name: field-bonus
description: Use when answering questions about per-person field bonuses — "what did X earn in May?", "how many qualifying trips". Computes bonuses from #field-qa flight hours + Vimeo video data. Gate: 3h deployment + 2 min video per trip.
---

# Field Bonus

Answer per-person bonus questions using this repo's CLI. Recomputes bonuses from #field-qa flight hours and live Vimeo video data.

## Domain (must-know)

- A **trip counts** iff deployment ≥ **3 hours** AND recorded video ≥ **2 minutes** (the gate — differs from field-ops 50%-of-airborne reconcile). This is the real bonus gate.
- Bonuses are: **700** per qualifying trip + **200** early (arrival ≤12:30 Kyiv) + **300** weekend (Sat/Sun) — apply early/weekend stacking per deployment.
- There is a **drone-loss multiplier** for deployments where the drone was lost; the classifier runs via Claude and scans the #field-qa thread + Vimeo video names for loss evidence.
- Days are grouped by video **upload date** (`created_time`), not flight date — uploads can lag up to a working day. Day boundaries use **Europe/Kyiv**, not UTC.
- **Team cutoff**: only count people with ≥ 3 qualifying trips in the period (house policy to avoid low-sample noise in bonuses).

## When to use

Any question like: "what did person X earn in May?", "how many trips qualified last month?", "which people hit the team cutoff?", "what's the raw bonus report?".

## How to use

Run the CLI (defaults to the current Kyiv month if you omit the dates):

```bash
npm run field-bonus -- --start 2026-05-01 --end 2026-05-31
```

It prints JSON:

- `period` — `{ start, end, timezone }`
- `personBonuses[]` — `{ person, trips, early, weekend, loss, subtotal, multiplier, total }` (only persons with ≥ 3 trips)
- `summary` — `{ personCount, totalTrips, totalBase, totalEarly, totalWeekend, totalLoss, totalBonus }`
- (internal) `allPersons[]` — same structure, including sub-3-trip people (for debugging)

Answer totals from `summary`; per-person from `personBonuses`. Add `--format table` for a human-readable view.

To persist a period as a committed artifact, add `--write`: it writes the lossless stats to `reports/field-bonus/<period>.json` (the web's render source — same shape as above) and a flat `reports/field-bonus/<period>.csv` (`person,trips,early,weekend,loss,subtotal,multiplier,total`), printing both paths to stderr. The web renders the committed JSON via `GET /api/field-bonus?period=<key>` (and lists committed periods via `?periods=1`); the live `?start=&end=` path still recomputes fresh from #field-qa + Vimeo.

Dates are inclusive and must be `YYYY-MM-DD`.

## Prerequisites

- Run `npm run slack-sync` first — the CLI reads the **#field-qa** Slack mirror for flight-hour reports (`data/slack/field-qa/<YYYY-MM>.json`).
- Set `VIMEO_TOKEN` in `.env` — the CLI fetches live videos from Vimeo to count recorded minutes per person per day.
- Set `ANTHROPIC_API_KEY` in `.env` — Claude classifies drone-loss records from #field-qa threads and video names.
- Set `POSTGRES_URL` in `.env` — the CLI reads the roster aliases DB table (`roster_aliases`) to normalize person names.

Missing any of these makes the CLI exit non-zero with a clear message — tell the user to set them in `.env`.

## Out of scope

The assemblers' "Бонус за готові дрони" (ready-drone) fund is **not** computed here — it is a separate in-house fund for ready/delivered drone units, not deployment bonuses. This CLI covers only deployment-based field bonuses.

The in-thread unknown-initial flow (`--ask`/`--publish`) is **planned but not yet implemented** — the skeleton exists, but the bot does not proactively ask about missing trip data or unclassified drones during normal runs.
