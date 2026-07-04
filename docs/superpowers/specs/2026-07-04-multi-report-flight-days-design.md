# Multi-report flight days — per-report verdicts

**Date:** 2026-07-04
**Status:** Approved (design), pending implementation plan

## Problem

`parseMonth` (`lib/fieldReports.ts`) assumes one «Звіт» per flight date and keeps
only the newest message per date. On 2026-07-01 two teams filed separate reports
(Андріан+Надія 12:30–16:10 = 220 min; Владислав+Надія 18.20–20.10 = 110 min).
The evening report silently replaced the afternoon one, the day's `deployMin`
became 110, and the deploy gate (`< 180` → hard fail) auto-REJECTED the day —
publishing the nonsensical «виїзд 110 хв — менше 3 год» against a Звіт that
plainly says 3г40хв.

## Domain rules (confirmed with the operator)

Per flight day:

- **Field reports («Звіт»): multiple** — one per team, each posted as its own
  top-level #field-qa message with its own thread ("each report must be threaded
  separately" is team discipline, and this design relies on it).
- **Drone-count report: one** for all teams.
- **Dataset notice: one** for all teams.

Decisions (operator-approved 2026-07-04):

1. **One verdict per report**, each with its own Slack message + thread.
2. **The ≥3h deploy gate applies per report.** A short trip is a machine
   auto-REJECT for that report only (approver override in that report's thread).
3. **Bonus pays per accepted report.** A person in two accepted reports the same
   day earns each trip (07-01: Надія gets both if both are accepted).
4. **Report identity = the Звіт message's Slack `ts`** (Approach A). A
   correction must be a Slack **edit** of that message (the mirror stores edits
   in place under the same ts). A repost creates a visible duplicate report —
   an approver rejects it in its thread — but a report can never be silently
   dropped, which was the bug.

## Axis model

| Axis | Scope | Source |
|---|---|---|
| Deploy window ≥ 3h | per report | the Звіт's `HH:MM–HH:MM` window |
| Crew (У полі) | per report | the Звіт roster line |
| Video ≥ max(2 хв, 50% × airborne) | day-shared | live Vimeo (by date in video name) |
| Airborne minutes | day-shared | stats-bot telemetry / `airborne_overrides` |
| Dataset notice | day-shared | #datasets mirror + resolutions |
| Drone-count report | day-shared | `days[].droneReport` extraction |

Day-shared axes are computed once per date and replicated onto every report row
of that date: a declined dataset or missing drone report fails **all** of the
day's reports; a video shortfall flags all of them.

## Data model changes

### Parsing (`lib/fieldReports.ts`)

`parseMonth` → returns **all** reports, sorted by (flightDate, ts). Each
`FieldReport` gains `reportTs` (the Звіт message ts — already available as
`threadTs` for top-level messages; make it explicit). No supersede logic: one
message = one report. Slack edits arrive as the same ts, so a corrected Звіт
replaces itself for free.

### Verdicts (`lib/fieldDayVerdict.ts`, `lib/computeVerdicts.ts`)

`DayVerdict` becomes a **report verdict**: adds `reportTs: string | null` and
`reportSeq`/`reportCount` (1-based position among the day's reports, for the
«виїзд 1/2» label). A flight day with telemetry but **zero** Звіт still yields
exactly one synthetic row (`reportTs: null`) — today's "no Звіт" behavior.
`verdictForDay`'s gate logic is unchanged; it just runs once per report with
that report's `deployMin`/crew and the day's shared axes.

**Verdict key:** `verdictKey = reportTs ? "<date>#<reportTs>" : "<date>"`. All
stores that were date-keyed re-key on `verdictKey`; a bare-date key is the
legacy form and maps to the day's single report (every pre-July day has exactly
one).

The field-verdict report JSON keeps a flat `days[]` array — now one row per
report, carrying `date`, `reportTs`, `reportSeq`, `reportCount`. The CSV gains
the same columns.

### Published log (`lib/published.ts`) + bonus notifications

`PublishedLog` re-keys on `verdictKey`; `PublishedEntry` gains `reportTs`.
Reads treat an existing bare-date key as that date's single report so June
never re-posts. `bonus_notified` follows the same re-keying.

### Resolutions / instructions (`lib/resolutions.ts`, `lib/applyInstruction*.ts`)

`Resolution` gains optional `reportTs`.

- **Report-scoped instructions** — crew set/add/remove, per-person eligibility,
  day accept/reject — store `reportTs` and apply only to that report. The
  webhook already resolves the thread the approver replied in via the published
  log, which now yields the exact report.
- **Day-scoped instructions** — dataset, video, airborne minutes, drone —
  stay date-keyed regardless of which report's thread they arrive in; the
  Ukrainian ack states the change applies to the whole day.
- Legacy date-only resolutions keep working: they match a report when the day
  has a single report (all existing data).

The crew-sheet import (`field-crew`, one crew row per day) applies only to
single-report days and to synthetic no-Звіт rows; on multi-report days the
Звіт rosters win and the sheet row is skipped (logged, not an error).

### Publishing (`lib/verdictPublish.ts`, `lib/publishVerdicts.ts`)

`formatDayMessage` gains the report label when `reportCount > 1`:

```
⛔ 2026-07-01 (середа), виїзд 2/2 (18:20–20:10) — відхилено: виїзд 110 хв — менше 3 год …
👥 У полі: Владислав, Надія.
🛸 Дрони: … (same day-level line on every report of the day)
```

Single-report days render exactly as today (no «виїзд 1/1» noise), so the
backfill/idempotency comparisons for existing messages stay byte-identical.
Each report posts as its own top-level message; the disjoint-region edit rules
(strike, crew suffix, drone line) are unchanged per message.

### Bonus (`lib/fieldBonus.ts`, `lib/computeBonuses.ts`)

`computeBonuses` iterates report rows instead of day rows: 700/trip (+200
early, +300 weekend — both evaluated per report, from that report's window/date)
for each member of each ACCEPTED / ACCEPTED_EXCEPTION report. `DayBonus`,
`PendingDay`, `voidedDays` entries carry `reportTs` + the report's own roster.
The per-person `eligibility: "counted"` escape hatch stays, now report-scoped
when the resolution has a `reportTs`, day-wide otherwise.

## Migration / rollout

- **No stored-data migration.** Legacy bare-date keys are read-compatible
  everywhere (single-report days).
- **2026-07-01 is the one conflicted day:** its published ⛔ message was
  computed from report 2's window but displays report 1's crew. After deploy,
  the operator strikes/amends the old message and lets the nightly post the two
  per-report verdicts. (`field-backfill` refuses overridden days already; this
  is a one-off manual step, not new tooling.)
- Web (`/api/field-verdict` render, Instructions tab) renders the new
  `reportSeq/reportCount` columns; no separate API change.

## Testing

Pure-lib Vitest coverage (the house pattern — logic in `lib/`, no live deps):

- `fieldReports`: two same-day reports from different crews both survive with
  distinct `reportTs`; an edited message (same ts) replaces itself; roster/
  window parsing unchanged.
- `computeVerdicts`: multi-report day yields N rows sharing day axes; 07-01
  fixture → report 1 ACCEPTED, report 2 REJECTED (deploy 110 < 180); zero-Звіт
  flight day still yields one synthetic row.
- `verdictPublish`: «виїзд 2/2» label only when `reportCount > 1`; legacy
  single-report rendering byte-identical.
- `published`: bare-date legacy key matches the single report; multi-report day
  publishes and dedupes per `verdictKey`.
- `resolutions`/`applyInstruction`: report-scoped vs day-scoped routing; legacy
  date-only resolution still applies.
- `fieldBonus`: Надія in two accepted reports on one day → two trips paid;
  rejected report 2 → one trip + a voided entry carrying report 2's roster.

## Out of scope

- Attributing video/airborne/dataset/drone counts to individual teams.
- Automated repost-vs-duplicate detection (team discipline: edit, don't repost).
- Rewriting already-published June messages (none are multi-report).
