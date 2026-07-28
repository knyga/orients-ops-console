---
name: vimeo-stats
description: Use when answering questions about field-ops video recordings — how many videos, total recorded minutes, or per-day uploads over a date range. Pulls live data from the account's Vimeo via the repo's CLI. Does NOT do reconciliation / the 50% flight-bonus gate (no flight-hours source yet).
---

# Vimeo Stats

Answer field-ops video questions using live Vimeo data through this repo's CLI.

## Domain (must-know)

- Videos are grouped by **upload date** (`created_time`), not flight date — uploads can lag up to a working day.
- Day boundaries use **Europe/Kyiv**, not UTC.
- Video is **not** paid per minute. These are recording stats only.

## When to use

Any question like: "how many videos were uploaded in May?", "total recorded minutes last week?", "which day had the most uploads?", "longest video this month?".

## How to use

Run the CLI (defaults to the current Kyiv month if you omit the dates):

```bash
npm run vimeo -- --start 2026-05-01 --end 2026-05-31
```

It prints JSON:

- `period` — `{ start, end, timezone }`
- `totals` — `{ videoCount, recordedMinutes }`
- `byDay[]` — `{ date, videoCount, recordedMinutes }` (ascending)
- `videos[]` — `{ date, minutes, name, link }` (ascending by date)

Answer counts/sums from `totals`/`byDay`; derive anything else (busiest day, longest clip) from `videos`. Add `--format table` for a human-readable view.

To persist a period as a committed artifact, add `--write`: it writes the lossless stats to `reports/vimeo/<period>.json` (the web's render source — same shape as above) and a flat `reports/vimeo/<period>.csv` (`date,videoCount,recordedMinutes`), printing both paths to stderr. The web renders the committed JSON via `GET /api/vimeo?period=<key>` (and lists committed periods via `?periods=1`); the live `?start=&end=` path still fetches fresh from Vimeo.

Dates are inclusive and must be `YYYY-MM-DD`. A missing `VIMEO_TOKEN` makes the CLI exit non-zero with a clear message — tell the user to set it in `.env`.

## Out of scope

Reconciliation and the 50% video-completeness gate need flight-hours data, which is not available to this CLI yet. Do **not** infer pass/fail or "flagged" status from these stats — report only the recording facts.
