---
name: field-qa-flight-hours
description: Use when answering questions about field drone flight hours, or when asked to extract/refresh flight hours from the #field-qa Slack channel for a date range (e.g. "how many flight hours in June?", "pull May's flight hours from field-qa", "update the flight-hours input for last month"). Reads airborne time from the stats-bot daily summary (text when posted, else the image via Claude vision) and writes the input the field-ops reconciliation consumes.
---

# Field-QA flight hours

Extract per-day drone flight hours from the #field-qa Slack stats-bot daily
summaries and feed the field-ops reconciliation.

## Domain (must-know)

- Flight hours come from the stats-bot's daily `Статистика польотів за <date>`
  summary posted in #field-qa. The relevant field is `Час в повітрі` (airborne
  time). The bot posts the card **both as text and as an image**.
- The CLI parses the **text** body deterministically (`lib/flightTextParse.ts`,
  no LLM, no download) when present, and only falls back to **Claude vision**
  (claude-sonnet-4-6) on the image for older/image-only days. The Slack
  `files:read` scope is therefore needed only for that vision fallback.
- The vision fallback is LLM-based and non-deterministic — always review before
  the numbers feed the gate. (Text-parsed days are deterministic.)
- The flight day is the date stated in the bot caption, not the Slack post time.

## When to use

"How many flight hours did the field team log in <month>?", "extract/refresh
flight hours for <period> from field-qa", "update the reconciliation input".

## How to use

```bash
# Inspect (no write):
npm run field-qa -- --start 2026-06-01 --end 2026-06-18            # JSON
npm run field-qa -- --start 2026-06-01 --end 2026-06-18 --format table

# Persist (writes the reconciliation input + provenance):
npm run field-qa -- --start 2026-06-01 --end 2026-06-18 --write
```

`--write` produces:
- `reports/field-ops/inputs/<period>.csv` — `date,flight_hours`, consumed by
  `npm run fieldops`.
- `reports/field-qa/<period>.json` — provenance: per-day hours, airborne minutes,
  flight count, and a permalink back to the source Slack message (also shown on
  the Field QA web tab). Shape: `{ period, sourceChannel, days: [{ date,
  flightHours, airborneMinutes, flights, permalink }], totals: { days,
  flightHours } }`.

Workflow: `field-qa --write` → review the git diff / web tab → `npm run fieldops
-- … --write` to reconcile against Vimeo.

## Out of scope

- Do not hand-fabricate hours; if `SLACK_TOKEN` is missing the CLI exits 1 with a
  clear message — surface that. `ANTHROPIC_API_KEY` is needed only when the vision
  fallback fires (an image-only day); text-only periods extract without it.
- The web tab is read-only and committed-only; it never triggers extraction.
- This feature only produces the flight-hours input — the 50% video gate itself
  is `scripts/fieldops.ts`.
