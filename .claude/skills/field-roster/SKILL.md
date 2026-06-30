---
name: field-roster
description: Use when answering "who was in the field on day X" or correcting a flight day's crew / per-person bonus eligibility from an approver's verdict-thread reply.
---

# Field roster (crew display + approver corrections)

The crew per flight day comes from the #field-qa "Звіт" reports (`lib/fieldReports.ts`),
shown on each published verdict line as `👥 У полі: …` and in `npm run field-verdict`.

To correct a day's crew or who counts for the bonus, an **authorized approver**
(`lib/approvers.ts`) replies in the verdict thread; ingest it with:

- `npm run field-roster -- --start YYYY-MM-DD --end YYYY-MM-DD` — DRY-RUN (prints what it would change)
- add `--write` to record the correction, edit the crew suffix, and post a Ukrainian ack

Corrections live in the `roster_corrections` table and flow into both
`npm run field-verdict` (display) and `npm run field-bonus` (the per-person tally).
Run `npm run slack-sync` first; classification needs `ANTHROPIC_API_KEY`.
