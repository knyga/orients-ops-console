---
name: jira-dev-reporting
description: Use when answering questions about dev throughput from Jira — how many issues each person resolved, story points delivered, or which issues churned between sprints over a date range. Pulls live data from the team's Jira via the repo's CLI, and can persist a period as a committed CSV report.
---

# Jira Dev Reporting

Answer dev-throughput questions using live Jira data through this repo's CLI.

## Domain (must-know)

- An issue counts for a period when its **resolution date** falls in `[start, end]` (inclusive). Grouping is by **assignee**; issues with no assignee land in a single **Unassigned** row.
- **Story points** come from the configured custom field (`JIRA_STORY_POINTS_FIELD`); unset points count as 0.
- **Sprint churn** is the issue's *entire* changelog of Sprint-field changes — so an issue resolved in May can show sprint moves from weeks earlier. The period filters the resolution date, **not** each move's timestamp. Sprint names are surfaced verbatim (e.g. `ATP 5 → ATP 6`); a blank side (`—`) means added-to / removed-from all sprints.

## When to use

Any question like: "how many issues did each person resolve in May?", "total story points last sprint?", "who delivered the most points this month?", "which issues bounced between sprints?".

## How to use

Run the CLI (defaults to the current month, UTC, if you omit the dates):

```bash
npm run jira -- --start 2025-05-01 --end 2025-05-31
```

It prints JSON (same shape as `GET /api/jira`):

- `rows[]` — `{ accountId, displayName, resolvedCount, storyPoints, issueKeys }`, sorted by resolvedCount desc; `issueKeys` lists that user's resolved issues in resolution order
- `totals` — `{ totalResolved, totalStoryPoints }`
- `sprintChurn[]` — `{ issueKey, summary, changes[] }`, each change `{ from, to, when }`

Answer counts/points from `rows`/`totals`; answer churn questions from `sprintChurn`. Add `--format table` for a human-readable view.

To persist a period as a committed CSV report, add `--write` — it writes the per-user table to `reports/jira/<period>.csv` (e.g. `reports/jira/2025-05.csv` for a single month, `start_end.csv` otherwise) and prints the path to stderr. The CSV holds the per-user rows only (`user,resolvedCount,storyPoints,issues`, where `issues` is a space-separated key list); sprint churn is hierarchical, so use the JSON/table views for it.

Dates are inclusive and must be `YYYY-MM-DD`. Missing `JIRA_*` env vars make the CLI exit non-zero with a clear message — tell the user to set them in `.env` (see `.env.example`).

## Out of scope

This reports resolved-issue throughput and sprint churn only. It does not judge whether work was "good" or estimate velocity targets — report the facts.
