# Nightly published-verdict refresh — design

**Date:** 2026-07-04
**Status:** approved

## Problem

A published verdict message is edited only by the axes that own a message
region: a day-axis (or dataset-decline) approver amendment strikes the body,
a crew correction edits the `👥 У полі:` suffix. Every other verdict change —
a dataset **waive**, a **video** exception, an **airborne** override, a late
dataset notice, a drone-report correction, or a format change — flips the
recomputed verdict but never touches the already-published Slack message:
`publishSettledDays` deliberately skips published days, and no other stage
re-edits them. Messages go stale forever (class of bug behind the 2026-06-09
report; the decline case was fixed point-wise in `9d54d20`).

## Decision

Add a **refresh stage to the nightly pipeline** (Approach 1 of 3 considered).
Freshness contract: a changed verdict reaches the published message by the
next nightly run (~24h) — confirmed acceptable. Immediate instruction-time
re-render was rejected (needs a live per-day recompute inside the webhook
budget and doesn't catch non-instruction drift); folding the diff into
`publishSettledDays` was rejected (muddies its skip-published contract); a
third cron is impossible on Hobby (max 2).

## Design

### New module: `lib/refreshPublished.ts` (server-only, effectful)

The refresh driver, mirroring `lib/publishVerdicts.ts` in shape:

```ts
export interface RefreshResult {
  refreshed: string[]; // dates edited
  skipped: { date: string; reason: BackfillReason | "not-publishable" | "untracked-channel" }[];
}

export async function refreshPublishedDays(
  days: DayVerdict[],
  period: Period,
  opts: { dryRun?: boolean; onLog?: (m: string) => void; trigger?: SendTrigger },
): Promise<RefreshResult>
```

Flow:

1. `readPublished(period)` → the month's published log.
2. `computeBackfillPlan(log, verdictByDate)` — the existing pure planner
   (`lib/backfillPublished.ts`) already yields `update` only when the stored
   text differs from the fresh `formatDayMessage` render, and skips
   `overridden` (approver strike owns the message), `no-verdict`, and
   `already-current` days.
3. **New guard on top of the plan:** drop an `update` whose fresh verdict
   status is not publishable (`publishableDays` predicate) — never rewrite a
   settled message back to ⏳ PENDING. (Should be unreachable — grace only
   shrinks — but the write is outward-facing, so guard it.)
4. Per remaining update: resolve the entry's channel from `TRACKED_CHANNELS`
   by the **entry's own** `channel` name (skip + log unknown, reason
   `untracked-channel`); `updateMessage` with key
   `backfillEditKey(date, contentRev(newText))` (content-rev-keyed → a re-run
   or redelivery of the same render dedups at the `lib/slack.ts` chokepoint);
   then rewrite the stored text via `recordPublished` + `writePublished`
   **after each edit** so a mid-run failure loses nothing and re-runs are
   no-ops.
5. `dryRun: true` performs steps 1–3 and logs each would-edit date; no Slack
   or DB writes.

`trigger` defaults to `"cron"`; the CLI passes `"cli"` (same convention as
`publishSettledDays`).

### Nightly wiring: `lib/runNightly.ts`

Per window month, inside the existing stage-3 loop, **after**
`publishSettledDays` (a just-posted day's stored text equals the fresh render,
so refresh sees it `already-current`):

- `opts.publish` → `refreshPublishedDays(c.report.days, c.period, { onLog })`.
- dry-run → same call with `dryRun: true` (plan + log only).

`NightlyMonthResult` gains `refreshed: string[]`. Refresh failures propagate
like publish failures (stage `"publish"` short-circuit + operator DM) — an
edit that fails mid-run is safe to retry next night.

### What deliberately does NOT change

- `publishSettledDays` — untouched; posting new days and truing up old ones
  stay separate contracts.
- `field-backfill` CLI — remains the manual, any-window tool on the same
  planner (e.g. for months outside the nightly window).
- The instruction-apply paths — the day-axis/dataset-decline strike and the
  crew-suffix edit still land immediately; refresh skips those days as
  `overridden` (strike) or sees the suffix already reflected in the stored
  text (crew edits rewrite it).

### Known limitation (documented, not solved)

For the catch-up **prior** month the nightly reuses the committed
field-verdict report, so an instruction applied to a prior-month day
re-renders only after an operator re-runs `field-verdict -- --write` (the
instructions CLI already says to). Current-month days are recomputed fresh
nightly and true up automatically.

## Two interfaces

- **CLI:** `npm run field-nightly` (dry-run) prints the per-month refresh
  plan; `--publish` applies it. `npm run sent` audits the edits (feature
  `verdict`, kind `edit`). `field-backfill` covers manual/out-of-window runs.
- **Web:** no new surface — the published log and outbound audit already back
  the existing tabs.

## Testing

- `lib/refreshPublished.test.ts` (mock `./slack`, `./published` — the
  `publishVerdicts.test.ts` pattern): edits only `needs-update` days and
  rewrites stored text after each; skips overridden / already-current /
  no-verdict / non-publishable-status / untracked-channel; dry-run edits and
  writes nothing; edit key is content-rev'd.
- `lib/runNightly.test.ts`: publish path calls the refresh per month and
  surfaces `refreshed`; dry-run passes `dryRun: true`.
