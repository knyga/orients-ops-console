---
name: policy-tracking
description: Use when answering whether operational policies are being executed in Slack — did the weekly/monthly budget status, the Tuesday stats publication, or another required post actually happen on time, by the right person, over a date range. Pulls live data from the tracked Slack channels via the repo's CLI, and persists a period as a committed JSON+CSV report with per-occurrence verdicts.
---

# Policy Execution Tracking

Answer "is this policy actually being followed?" using live Slack data through this repo's CLI, then commit a reviewed monthly report.

## Domain (must-know)

- An **obligation** (lib/policyRegistry.ts) is a recurring requirement: who must post what, in which channel, on what cadence, with how many working days of grace, effective over a date range. Policies evolve, so each obligation has `effectiveFrom`/`effectiveTo` and only contributes occurrences while effective.
- The deterministic CLI assigns each occurrence a **status**: `MISSING` (past due + grace, zero candidate posts), `PENDING` (not yet due / still within grace), `NEEDS_REVIEW` (a candidate post exists — needs a judgement). Calendar math is UTC; working days are Mon–Fri (holidays not modeled).
- The **verdict** (`DONE`/`LATE`/`PARTIAL`/`MISSING`) is a human/AI judgement layered on the `NEEDS_REVIEW` occurrences. It is NOT computed — it comes only from a committed report. The web's live Refresh shows status only, never verdicts.
- **Per-event** obligations (drone-remainder report, unrecorded-video/-dataset explanations) are not scheduled in v1 — they appear in `skipped`, not as occurrences.

## When to use

Questions like: "did Maryna post the weekly budget status every Monday in May?", "was the Tuesday stats publication missed last month?", "show this month's policy compliance so far", "which required reports are missing?".

## How to use

Run the CLI (defaults to the current month, UTC, if you omit the dates):

```bash
npm run policy -- --start 2026-05-01 --end 2026-05-31 --format table
```

It prints the report (same shape as `GET /api/policy?period=<key>`): `period`, `runDate`, `occurrences[]` (`{ id, obligationId, title, channel, dueDate, windowStart, windowEnd, status, candidates[], verdict?, rationale? }`), and `skipped[]`. Answer compliance questions from `occurrences` (status, and verdict when present).

To persist a period as a committed report, add `--write` — it writes two sidecars under `reports/policy/` keyed by period (`2026-05` for a single month): a lossless `<period>.json` (the web's render source) and a flat `<period>.csv` (`obligation,channel,dueDate,status,verdict,rationale,evidenceCount`; the evidence detail lives only in the JSON). The web renders the committed JSON via `GET /api/policy?period=<key>` (period list at `?periods=1`); the current month can be refreshed against live Slack (`?refresh=1&start=&end=`), showing deterministic status without verdicts.

### Monthly compliance requests → classify NEEDS_REVIEW via sonnet subagents, then commit

When asked to produce a month's compliance record, classify the `NEEDS_REVIEW` occurrences with **Claude Code sonnet subagents** (one per month), then feed the verdicts back through the CLI so the committed report carries them:

1. `npm run policy -- --start <YYYY-MM-01> --end <YYYY-MM-DD> --dump-occurrences` → the `NEEDS_REVIEW` occurrences as JSON, each with its `id`, obligation `title`/`description`, the candidate Slack posts (author, time, excerpt, permalink), and the `windowStart`/`windowEnd`/`dueDate`. Save one file per month.
2. Dispatch one **sonnet** subagent per month (`Agent` tool, `model: sonnet`). It reads that file and, for each occurrence, decides a verdict against the obligation:
   - `DONE` — a candidate from a responsible person fulfils the obligation on time (within the window).
   - `LATE` — fulfilled, but the qualifying post lands after the due date (still within the window the scheduler allowed).
   - `PARTIAL` — partially fulfilled (e.g. some but not all required content), or fulfilled by a non-responsible person.
   - `MISSING` — the candidates do not actually fulfil the obligation (off-topic chatter).
   It writes a JSON object `{ "<occurrenceId>": { "verdict": "...", "rationale": "<one line>" } }` to a file. Use the obligation `description` + `keywords` as the rubric; keep Ukrainian proper nouns; rationale is one short English line.
3. `npm run policy -- --start … --end … --verdicts-file <path> --format table` → the CLI merges the verdicts (no Claude call), prints the table, and writes `reports/policy/<period>.{json,csv}` with verdicts filled. `--verdicts-file` implies `--write`.

Then present each obligation's occurrences with their verdict + rationale. Review the verdicts before committing the artifacts — the committed report is the auditable record.

Dates are inclusive and must be `YYYY-MM-DD`. A missing `SLACK_TOKEN` makes the CLI exit non-zero — tell the user to set it (and the tracked channel ids in `lib/slackChannels.ts`) in `.env` (see `.env.example`).

## Out of scope

This reports whether required posts happened, on the deterministic schedule + a reviewed verdict. It does not judge the *quality* of the work described, enforce penalties, or schedule per-event obligations (drone-remainder, unrecorded-video explanations) — those are surfaced in `skipped`. Report the facts.
