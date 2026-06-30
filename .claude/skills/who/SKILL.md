---
name: who
description: Use when asked what a specific person has been doing or saying for a period — assembles their Slack timeline plus Jira/GitHub/field-bonus summaries from the local mirror + committed reports.
---

# who — person-centric activity view

Answer "what has <person> been doing/saying this period?" in one command.

## Run it

```
npm run who -- --person <query> --start YYYY-MM-DD --end YYYY-MM-DD [--format table]
```

- `--person` matches a name in `lib/people.ts` (exact, then unique substring). Ambiguous or unknown queries print the candidates — pick a more specific query.
- Omit `--start`/`--end` for the current Kyiv month.
- `--format table` for a human view; default is JSON (same shape as `GET /api/who`).
- `--unlinked` lists identities present in the data but registered to no person — the to-do list for `lib/people.ts`.

## What it reads (all local, no live fetch)

- Slack timeline: the mirror DB (`schema.slackMessages`), filtered to the person's `slackId` across all tracked channels.
- Jira / GitHub / field summaries: the committed `jira` / `github` / `field-bonus` reports for the period. A summary block appears only when the person carries that identity AND the report is committed. Run the relevant `npm run <feature> -- --write` first if a block is missing.

## Identity

`lib/people.ts` is the hardcoded registry joining a human across Slack id / Jira account / GitHub login / roster initial. To add someone, run `npm run people:scaffold` (it proposes matches from live Slack + committed reports + roster) and paste the **reviewed** entry into `lib/people.ts` — name matches can mis-join, so a human confirms.
