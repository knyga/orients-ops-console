# Backfill published #field-qa verdicts to Ukrainian (+ ACCEPTED_EXCEPTION formatter fix)

**Date:** 2026-06-29
**Status:** Approved
**Branch:** `feat/field-backfill-ukrainian`

## Problem

The Ukrainian-messages feature (commit 1759bc7) only affects *future* posts. The
**19 verdicts already posted to the live `#field-qa` channel** are English. Verified
against the **live DB** (the real store — `reports/*.json` are stale snapshots): all
19 are in `field-qa`, none carry an `override`, and 06-04 was posted directly as
ACCEPTED_EXCEPTION.

Verifying also exposed a gap in the shipped feature: `formatDayMessage`'s
ACCEPTED_EXCEPTION branch passes `day.reasons` through verbatim, but those are
*machine-generated English* gap strings plus the human note
(`applyResolution` appends `exception (by): note` last). So exception posts render
half-English.

## Part 1 — formatter fix (`lib/verdictPublish.ts`)

Extract a shared `ukrainianGaps(day)` helper (the gap wording already built inline
for NEEDS_REVIEW: low-video / no-dataset, from structured fields). Use it in BOTH
the NEEDS_REVIEW and ACCEPTED_EXCEPTION branches.

ACCEPTED_EXCEPTION render becomes:
`🟡 {date} — прийнято (виняток): {ukrainianGaps; …}; {exceptionNote}.`
where `exceptionNote` is the trailing `exception…` reason with its prefix
translated `exception` → `виняток` and the human note kept **verbatim** (it's
recorded text — we never rewrite it). Machine gaps are rebuilt in Ukrainian, not
string-translated. Pure; unit-tested (incl. the `by`-present and ratio=0 cases).

## Part 2 — backfill CLI (`npm run field-backfill`)

A one-time migration. DRY-RUN by default.

**Pure planner — `lib/backfillPublished.ts` (unit-tested):**
`computeBackfillPlan(log: PublishedLog, verdictByDate)` → one `BackfillItem` per
posted day `{date, channel, ts, oldText, newText, action, overridden}`:
- `newText = formatDayMessage(verdictByDate[date])` (now Ukrainian + weekday + the
  Part-1 exception fix).
- `action = "skip"` when `entry.text === newText` (already current — idempotency
  key, so re-runs are no-ops) OR when `entry.override` is set (we must not clobber
  a struck amendment / its separate ack reply); else `"update"`.
- `overridden = entry.override != null` (none in current data; the guard is
  defensive). Days with no verdict in the report are skipped + flagged.

**CLI shell — `scripts/field-backfill.ts`:** reads the verdict report via
`readReportJson("field-verdict", key)` and the log via `readPublished(period)`
(same DB-backed sources `field-publish` uses — never live recompute). Then:
- **Dry-run (default):** prints each `update` as `old → new`, lists skips
  (already-current vs overridden-skipped), warns if any verdict is missing. Sends
  nothing.
- **`--publish` (+ `--channel <name>`):** asserts every `update` item's channel
  equals `--channel` (refuse on mismatch / multi-channel — prevents cross-posting),
  resolves it via `TRACKED_CHANNELS`, then per item: `updateMessage(id, ts, newText)`
  and `writePublished` with `entry.text = newText` (persist after each, so a
  mid-run failure isn't lost and re-runs skip). `--publish` requires `--channel`.

Runs under `--conditions=react-server` (server-only Slack import), `process.loadEnvFile()`.

## Out of scope / known residue

- 06-04's **separate English ack reply** (`Recorded: …`) — its ts was never stored;
  left as-is (decision: leave + flag). It's the only one (override path unused here).
- No web surface — one-time operational migration; the feature it backfills already
  has web + CLI.

## Testing

TDD throughout. Part 1: extend `verdictPublish.test.ts` (ACCEPTED_EXCEPTION now
Ukrainian incl. machine gaps; exception label `виняток`; note verbatim). Part 2:
`backfillPublished.test.ts` for the planner (update vs skip-already-current vs
skip-overridden vs missing-verdict). Full suite + lint green before any `--publish`.
