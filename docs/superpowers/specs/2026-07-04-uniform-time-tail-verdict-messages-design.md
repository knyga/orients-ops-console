# Uniform time tail on published verdict messages

**Date:** 2026-07-04
**Status:** Approved

## Problem

Published field-verdict Slack messages show time figures inconsistently: airborne
minutes appear on most statuses but not all (ACCEPTED_EXCEPTION omits them, some
REJECTED renders too), and the deployment (виїзд) time — literally the time spent
in the field — only surfaces when it is a *gap* (under 3h or missing). The team
wants time spent in the field visible on **every** published verdict message,
regardless of accepted / needs-review / exception / rejected status.

## Decision summary (from brainstorming)

1. **Which time:** both — deployment (виїзд window + duration) *and* airborne
   minutes, plus the video minutes/ratio already shown.
2. **Placement:** a **uniform inline tail** in the message body, identical across
   all statuses. No new suffix region — the `👥 У полі:` / `🛸 Дрони:` split/parse
   machinery is untouched.
3. **Backfill:** yes — re-edit already-published June + July messages via the
   existing `field-backfill` re-render (it already skips approver-overridden days).

## Message format

Every published message becomes `<icon> <date> — <verdict clause> (<tail>).` with
one shared tail built by a single helper in `lib/verdictPublish.ts`:

```
(виїзд 08:00–16:30 — 8 год 30 хв; у повітрі 45 хв; відео 30 хв — 67%; датасет ✓)
```

Tail segments, in order:

- **виїзд** — window from `deployWindow`, duration from `deployMin` rendered as
  «N год M хв» (whole hours «N год», sub-hour «M хв»). If only one of
  window/duration is known, render that one alone. If the day flew but neither is
  known → `виїзд — не вказано` (uniform shape; matches the 3h gate's insistence).
- **у повітрі** — `у повітрі N хв` always; when airborne wasn't quantified
  (`airborneReported === false`) → `у повітрі — не вказано`.
- **відео** — `відео N хв — P%` with the percent only when `ratio` is non-null;
  otherwise `відео N хв`.
- **датасет** — the existing `datasetMarker` text, unchanged.

The status-specific clause (`прийнято` / `потрібна перевірка: <gaps>` /
`відхилено: <reasons>` / `прийнято (виняток): <note>`) is untouched — gaps still
explain *why*; the tail states the facts. Redundancy between a
«виїзд … менше 3 год» gap and the tail's виїзд figure is accepted.

## Data flow

No new data. `deployWindow`, `deployMin`, `airborneMinutes`, `airborneReported`,
`videoMinutes`, `ratio`, `datasetStatus` already live on `DayVerdict` and flow
from the field-qa extraction. Report JSON/CSV artifacts and the web view are
unchanged (English reasons stay internal). The CLI surface is the existing
`field-publish` / `field-backfill` dry-run output through the same shared
`lib/verdictPublish.ts` — the two-interface rule is satisfied with no new CLI.

## Backfill plan (operational, after the code ships)

1. `npm run field-verdict -- --write` for June and for July (stored verdicts pick
   up deploy fields).
2. `npm run field-backfill -- --start … --end …` dry-run → review the `old → new`
   pairs.
3. `… --publish --channel <#field-qa>` to edit the live messages. Idempotent;
   overridden (struck) days are skipped by design.

Days whose stored verdict lacks deploy data render `виїзд — не вказано` —
visible, honest, curable by a later re-verdict.

## Testing

TDD in `lib/verdictPublish.test.ts`:

- One test per publishable status asserting the identical tail.
- Edge cases: window-only, duration-only, neither (flew), airborne unreported,
  null ratio, duration formatting (whole hours, minutes-only, hours+minutes).
- Existing tests asserting the old per-status wording are updated.

End-to-end: `npm test`, then a `field-publish` dry-run over the current month.
