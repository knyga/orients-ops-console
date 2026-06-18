---
name: field-qa-flight-hours
description: Use when answering questions about field drone flight hours, or when asked to extract/refresh flight hours from the #field-qa Slack channel for a date range (e.g. "how many flight hours in June?", "pull May's flight hours from field-qa", "update the flight-hours input for last month"). Extracts hours from Ukrainian "Звіт" reports via Claude and writes the input the field-ops reconciliation consumes.
---

# Field-QA flight hours

Extract per-day drone flight hours from #field-qa Slack reports and feed the
field-ops reconciliation.

## Domain (must-know)

- Flight hours live in #field-qa daily reports that begin with `Звіт <DD.MM.YYYY>`
  (Ukrainian). Hours = the sum of the `HH:MM-HH:MM` window(s) on the crew line
  (e.g. `А+Д 15:20-18:30` = 3.17h). Multiple windows in a day are summed.
- Extraction is **LLM-based** (claude-sonnet-4-6), so it is non-deterministic —
  always review before the numbers feed the gate.
- The flight day is the report's stated date, not the Slack post time.

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
- `reports/field-qa/<period>.json` — provenance: per-day hours, windows, crew,
  and a permalink back to the source Slack message (also shown on the Field QA
  web tab).

Workflow: `field-qa --write` → review the git diff / web tab → `npm run fieldops
-- … --write` to reconcile against Vimeo.

## Out of scope

- Do not hand-fabricate hours; if `SLACK_TOKEN` or `ANTHROPIC_API_KEY` is missing
  the CLI exits 1 with a clear message — surface that.
- The web tab is read-only and committed-only; it never triggers extraction.
- This feature only produces the flight-hours input — the 50% video gate itself
  is `scripts/fieldops.ts`.
