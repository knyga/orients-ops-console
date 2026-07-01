# Autonomous nightly field pipeline

**Date:** 2026-07-01
**Status:** Design — approved for planning
**Author:** Oleksandr Knyga (with Claude)

## Problem

Field-day verdicts stopped appearing in #field-qa after **2026-06-23**, even though flights
continued and the data is present. Diagnosis:

- The **Slack sync** cron (`/api/cron/sync`, 06:00 UTC) and the **verdict compute** cron
  (`/api/cron/verdict`, 06:30 UTC) both run fine. The DB mirror is fresh and the
  `field-verdict` report already covers through 2026-06-30.
- But two stages of the pipeline are **manual, human-in-the-loop**, and no cron performs them:
  1. **field-qa extraction** (`npm run field-qa -- --write`) — the Claude step that turns
     #field-qa "Звіт" posts into the airborne-minutes source that `computeVerdicts` reads.
  2. **field-publish** (`npm run field-publish -- --publish`) — the console's only
     outward-facing Slack write, deliberately dry-run-by-default.

Result: verdicts are computed but never posted. As of this design, **2026-06-24, -25, -29, -30
are settled (ACCEPTED / NEEDS_REVIEW) but unpublished**, and 2026-06-27 is PENDING (correctly
not posted).

## Goal

Each morning-after run, with **zero human steps**, carry new flight days from raw Slack all the
way to a posted #field-qa verdict — and sweep up any settled day that was missed, including
across a month boundary.

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Publish autonomy | **Auto-publish for real** to #field-qa. PENDING days never post. |
| Substrate | **Extend Vercel crons** (in-repo, where SLACK/ANTHROPIC env already live). |
| Timing | **Morning-after, 06:30 UTC (09:30 Kyiv)** — most stable; full prior day is in. |
| Failure visibility | **Slack DM to Oleksandr** on any stage error/anomaly, plus HTTP 500. |
| Missing days | **Catch-up window** sweeps unpublished settled days across the month boundary. |

## Design

### 1. One consolidated nightly cron

Replace the two existing crons (`/api/cron/sync`, `/api/cron/verdict`) with a single sequential
route **`/api/cron/field-nightly`** scheduled at `30 6 * * *` (06:30 UTC / 09:30 Kyiv). It runs
the full chain in one invocation, in order:

```
incremental slack sync
  → field-qa extract (Claude, write report)
  → verdict compute (write report)
  → publish settled days to #field-qa
```

Sequential + in-process guarantees ordering and lets any stage failure **short-circuit** the
chain — a broken extract or verdict never reaches publish, so the bot never posts on stale or
bad data. (Time-staggered separate crons cannot promise this ordering or short-circuit.)

`vercel.json` keeps a single entry:

```json
{ "crons": [ { "path": "/api/cron/field-nightly", "schedule": "30 6 * * *" } ] }
```

**Plan constraint (confirmed 2026-07-01):** the project lives on the personal team
`knyga's projects` — a **Vercel Hobby** account. Hobby caps serverless functions at **60s**,
allows **at most 2 cron jobs**, and runs crons **once per day** (best-effort timing). Our
once-daily single-cron design fits all three, but the function must complete within **60s**, so
the route sets `export const maxDuration = 60` (not 300).

The full chain must therefore fit 60s: incremental sync (~5s) + field-qa extract (the one Claude
call — the risk) + verdict compute (Vimeo fetch, ~5s) + a handful of Slack posts. The extract
runs over the **whole window month** (§3), consistent with the CLI's period-based semantics —
`extractFieldQa` always writes a *complete* month report, so a partial-window extract that
clobbers earlier days is explicitly avoided. A month of #field-qa "Звіт" posts is a small,
short-message corpus (the same full-month extract the CLI ran on 2026-07-01 completed comfortably),
so one Claude call is expected to sit well under budget. During the first-5-days boundary the two
window months are extracted in **separate** calls (each writes its own month report).

**Fallback:** if the chain still risks exceeding 60s in practice, split into two of the two
allowed Hobby crons — `field-nightly-compute` (sync+extract+verdict) then
`field-nightly-publish` (publish) — accepting the weaker cross-route ordering guarantee. Prefer
the single consolidated route unless measurement forces the split.

Guarded by `CRON_SECRET` via the existing `isAuthorizedCron` helper.

### 2. Lift orchestration into shared lib functions

The cron must reuse the exact code paths the CLIs use (the two-interface / shared-`lib` rule).
Two orchestration bodies currently live inside their scripts' `main()` and must be lifted:

- **`lib/fieldQaExtract.ts`** — `extractFieldQa(period, { write }): Promise<FieldQaReport>`.
  Lifted from `scripts/fieldQa.ts` `main()`. Reads the Slack mirror, calls Claude, writes the
  `field-qa` report. `scripts/fieldQa.ts` becomes a thin CLI wrapper over it.
- **`lib/verdictPublish.ts`** — add `publishSettledDays(report, channel, { publish }): Promise<PublishResult>`.
  Lifted from `scripts/field-publish.ts` `main()`: filter via existing `publishableDays`, read
  the `published` log, post each unpublished settled day via `lib/slack.postMessage`, persist the
  log after each post. `scripts/field-publish.ts` becomes a thin wrapper. `PublishResult` reports
  `{ posted: string[], skipped: string[] }` so the cron can detect the anomaly in §4.

`syncAllChannels` (sync) and `computeVerdicts` (verdict) are already clean lib functions — reuse
as-is.

### 3. Publish with a catch-up window (compensate missing days)

The verdict cron today computes only the *current Kyiv month*. On 2026-07-01 that means it looks
at July and would **strand June's unpublished settled days forever**. The nightly cron instead
computes and publishes over a **catch-up window**:

- Always: the current Kyiv month.
- Additionally, when today is within the first **`CATCHUP_BOUNDARY_DAYS = 5`** days of a new
  month, also the **previous** month.

For each month in the window it runs extract → verdict → `publishSettledDays`. Publishing stays
idempotent via the `published` log, so re-runs and overlapping windows post nothing twice. This
compensates missing days generally and clears the June 24/25/29/30 backlog on the first run
(if not already cleared manually — see §6).

The channel is fixed to **`field-qa`** (a `TRACKED_CHANNELS` entry) for autonomous posts.

### 4. Failure visibility

The route wraps each stage. On any thrown error, or on the **anomaly** where extract found new
flight days for the window but `publishSettledDays` posted 0 (and skipped 0 for
already-published reasons), it:

1. Sends a Slack **DM to Oleksandr** (id from `lib/approvers.ts` / people registry) using the
   `lib/webhookNotice.ts` message pattern, stating which stage failed and the error/summary.
2. Returns HTTP **500** so Vercel's cron-failure alerting fires too.

A stage failure aborts before publish (fail-safe). The DM send itself is best-effort (a failed
DM must not mask the original 500).

### 5. Second interface (CLI)

Per the non-negotiable two-interface rule, the whole chain is also runnable locally:
**`npm run field-nightly -- [--start … --end …] [--publish]`** (`scripts/field-nightly.ts`),
**dry-run by default** — prints what each stage would do and the exact messages publish would
post, sends nothing without `--publish`. It calls the same lib orchestration the cron does, so
CLI and cron cannot diverge. Documented in `CLAUDE.md` alongside the other field commands.

### 6. One-time backlog

The June 24/25/29/30 backlog can be cleared immediately with a manual
`npm run field-publish -- --start 2026-06-01 --end 2026-06-30 --channel field-qa --publish`
(explicit, human-confirmed outward post) so the team isn't blocked on the deploy. If skipped, the
first nightly cron run sweeps it via the §3 catch-up window (July 1 is within the 5-day boundary,
so June is in the window). This is an operational step, not code.

## Out of scope (YAGNI)

`field-ask`, `field-remember`, `field-approvals`, `field-roster`, and `field-bonus --notify` stay
manual/explicit. This pipeline is strictly **sync → extract → verdict → publish**.

## Testing

- Unit-test the lifted `extractFieldQa` and `publishSettledDays` against the existing fixtures
  (behavior must be unchanged vs the current script `main()`s — characterization).
- Unit-test the catch-up window month selection: mid-month (current only) vs first-5-days
  (current + previous).
- Unit-test the anomaly detector (new flight days found, 0 posted → notify) and the fail-safe
  (extract/verdict throw → publish not called).
- The cron route's `isAuthorizedCron` gate mirrors the existing sync/verdict route tests.

## Files touched

- `app/api/cron/field-nightly/route.ts` — new consolidated cron (orchestration only).
- `app/api/cron/sync/route.ts`, `app/api/cron/verdict/route.ts` — removed (folded in).
- `lib/fieldQaExtract.ts` — new; extraction orchestration lifted from `scripts/fieldQa.ts`.
- `lib/verdictPublish.ts` — add `publishSettledDays`.
- `scripts/fieldQa.ts`, `scripts/field-publish.ts` — thinned to wrappers.
- `scripts/field-nightly.ts` — new CLI (dry-run default).
- `vercel.json` — single `field-nightly` cron entry.
- `CLAUDE.md` — document `npm run field-nightly` and the new cron.
