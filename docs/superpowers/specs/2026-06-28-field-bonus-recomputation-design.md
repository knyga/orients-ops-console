# Field Bonus Recomputation — Design

**Date:** 2026-06-28
**Status:** Approved (design); ready for implementation plan
**Author:** ops-console + Claude

## Problem

Field-team monthly bonuses are computed by hand in a Google Sheet ("Personal Field
Metrics"). The ops console has no tooling to reproduce or audit those payouts. The
two raw sources the calculation needs are already mirrored by the console, but
nothing parses them into a per-person bonus:

- **Deployment window + per-person roster** live in `#field-qa` "Звіт" reports
  (already in the Slack mirror), e.g.:
  ```
  Звіт 27.06.2026
  А+Серж 14:40-17:40
  ...notes (datasets, video, crashes)
  ```
- **Video minutes** come from live Vimeo (already exposed via `/api/vimeo` and the
  vimeo CLI), attributed to a flight day by the date encoded in the video name.

This feature adds the parser + calculator + CLI + web that turn those into an
auditable per-person bonus report.

## Bonus policy (authoritative, from `Правила.html`, in force 2026-03-01)

Per person, per calendar month:

```
gross = 700 × (counted trips)
      + 200 × (early trips:   field arrival ≤ 12:30, counted only)
      + 300 × (weekend trips: Sat/Sun,        counted only)
net   = gross × (1 − penaltyPct)
```

- A trip **counts** iff **deployment ≥ 3h (180 min)** AND **≥ 2 min of video** was
  uploaded for that flight day. This is the policy fix: it replaces the console's
  existing 50%-video-of-airborne reconcile gate (`lib/reconcile.ts`, `MIN_RATIO`),
  which is a *different* policy and is left untouched for its own feature.
- **Drone-loss penalty**, per flight group, counted over **12 consecutive trips**
  of that group: ≤1 loss = OK; 2 losses → −50% of the group's month; 3 → −100%.
  A drone reported lost but later **found** is treated as no loss.
- **Team-wide cutoff:** if the whole team loses **>3 drones** in the month, field
  bonuses are **zero for everyone** (includes R&D flights).
- "Бонус за готові дрони" (assemblers' ready-drone fund) is **out of scope** — a
  separate fund, excluded from this feature.

May 2026 ground-truth total (sheet, excl. ready-drone fund): **35 800 грн**
(29 400 trips + 4 000 early + 2 400 weekend).

## Design decisions

1. **Drone losses: auto-parse from `#field-qa`.** Claude classifies each Звіт's
   free text into `{lost, found, note}`; found ⇒ no loss. (`ANTHROPIC_API_KEY`.)
2. **Video gate: attribute by date-in-name** (reuse `videoFlightDate` from
   `lib/computeVerdicts.ts`) — robust to upload lag.
3. **Unknown roster initials: ask in the report's Slack thread.** When an initial
   is unmapped (e.g. `М` on 27.05), the CLI posts a clarifying question *in that
   report's thread* (DRY-RUN by default; `--publish` to send), mirroring the
   `field-ask`/`field-remember` pattern. A follow-up ingest records the alias. The
   core calculation does not block on this — unknown initials are flagged and
   excluded from that day's attribution until resolved.
4. **Reconcile, don't force-match.** With the correct gate the result will *not*
   equal the sheet's 35 800, because the sheet is internally inconsistent
   (05-07/25/30 excluded despite qualifying; 05-11 paid with zero video). The CLI
   emits a **diff vs the sheet** explaining every divergence.

## Components

All `lib/` modules are pure (no React/Next imports) and unit-tested, per house
convention. Token-touching / DB / network code stays at the CLI/route edge.

### `lib/fieldRoster.ts` (pure)
- Seed initial→name map: `А`→Андріан, `Л`→Любомир, `Д`→Данило, `Т`→Тарас,
  `В`→Влад, `Н`→Надія, `К`→Констянтин, `Серж`/`Сер…`→Сергій, `О`→Олександр.
- `resolveInitial(token, aliases)` → `{ name }` | `{ unknown: token }`.
- Alias overrides come from a DB-backed store (see Persistence), so a resolved
  `М`→<name> is durable and shared by CLI + web.

### `lib/fieldReports.ts` (pure)
- `parseZvit(text, meta)` → `FieldReport | null`:
  ```ts
  interface FieldReport {
    flightDate: string;       // YYYY-MM-DD, from the date in the text (not post time)
    roster: string[];         // resolved names
    unknownInitials: string[];// tokens that didn't resolve
    start: string | null;     // "HH:MM"
    end: string | null;
    deployMin: number | null; // end − start
    crashText: string | null; // free-text remainder, for loss classification
    permalink: string;
    threadTs: string;         // for posting clarifying questions
  }
  ```
- Hardened for the real variances observed in the mirror:
  - Optional `Звіт` keyword (some reports are bare `30.05.2026`).
  - Reversed roster/time order (`15:00-20:00 А+Д`).
  - `.` or `:` time separators (`14.00 - 18.45`).
  - Date-in-text ≠ post date; reports arrive late and out of order.
  - Roster split on `+ / , &`; numeric tokens ignored.
- `parseMonth(messages, aliases)` maps mirror messages (including thread replies)
  to `FieldReport[]`, de-duplicated by `flightDate` (latest edit wins).

### `lib/fieldBonus.ts` (pure)
- Constants: `TRIP=700, EARLY=200, WEEKEND=300, MIN_DEPLOY_MIN=180,
  MIN_VIDEO_MIN=2, EARLY_CUTOFF="12:30", LOSS_WINDOW=12, TEAM_LOSS_CUTOFF=3`.
- `computeBonuses({ reports, videoMinutesByDate, losses })` →
  ```ts
  interface BonusReport {
    period: { start; end; timezone };
    days: DayBonus[];     // date, roster, deployMin, videoMin, counted, early, weekend, perPerson{}
    people: PersonBonus[];// name, trips, early, weekend, gross, penaltyPct, net
    penalties: Penalty[]; // group/person, lossesInWindow, pct, reason
    teamZeroed: boolean;
    flags: Flag[];        // unknown initials, qualifying-but-unrecorded, anomalies
    total: number;
  }
  ```
- Loss multiplier: order each flight group's trips chronologically, slide a window
  of 12 consecutive trips, take the worst applicable penalty for the month. Group =
  the set of people who fly together (v1: derive groups from co-occurrence on the
  flight day; document the simplification).
- Team cutoff: `losses(found=false).length > 3` ⇒ `teamZeroed`, all `net=0`.

### `lib/lossExtract.ts` (+ `lib/lossExtractPrompt.ts`)
- Mirrors `lib/flightExtract.ts`: a tool-call prompt; Claude reads `crashText` and
  returns `{ lost: boolean, found: boolean, note: string }` per report.
- Pure prompt/shape modules are unit-tested; the network call lives at the edge.

## CLI — `scripts/field-bonus.ts` → `npm run field-bonus`

```
npm run field-bonus -- --start YYYY-MM-DD --end YYYY-MM-DD
                       [--format table] [--write] [--ask] [--publish] [--sheet <path>]
```

- Defaults to the current Kyiv month.
- Reads: Slack mirror (`readChannelMessages("field-qa", period)`), live Vimeo
  (`fetchVideosInPeriod` → minutes by name-date), roster aliases, Claude losses.
- Prints the `BonusReport` JSON; `--format table` for a human view.
- `--write` persists the committed artifact (lossless JSON render-source + flat
  per-person CSV: `person,trips,early,weekend,gross,penaltyPct,net`).
- `--ask` computes the unknown-initial questions; **DRY-RUN by default**, prints
  the Ukrainian questions + target threads. `--publish` posts them (needs
  `chat:write`), tracked so each unknown is asked at most once.
- Runs with `node --conditions=react-server` (server-only modules), like the other
  CLIs.
- `--sheet <path>` (a `statistics.csv`/`by_people.csv` export) turns on the
  reconciliation diff: per-person results compared to the sheet, listing each
  divergent day with its reason. Omitted ⇒ no diff.

## Web — `/api/field-bonus` + dashboard tab

- `GET /api/field-bonus?period=<key>` serves committed JSON; `?periods=1` lists
  committed periods; `?refresh=1&start=&end=` does the live recompute (current
  month). Mirrors the hybrid pattern of the other reporting routes.
- A dashboard tab (data-driven nav `enabled` flag) using the shared
  `usePeriodReport` hook: per-person table, per-day breakdown, and a panel listing
  flagged unknowns / penalties / sheet-diff.
- The web never writes `reports/` — only the CLI persists artifacts.

## Persistence

- Committed artifact: DB-backed report store (`writeReport`/`readReportJson`),
  consistent with the current architecture where `reports/*.json` are legacy and
  the live store is Postgres. Flat CSV remains a human record.
- Roster aliases + unknown-initial ask state: small DB-backed stores, following
  the `resolutions`/asks precedent (keyed appropriately; auditable, reversible).

## Testing

- `lib/fieldReports.test.ts` — every observed variance (keyword-optional, reversed
  order, dot separator, thread reply, lagged date, unknown initial) parses
  correctly; malformed lines return `null` without throwing.
- `lib/fieldBonus.test.ts` — the 700/200/300 arithmetic; the 3h+2min gate
  (boundary cases: exactly 180 min, exactly 2 min video); early at exactly 12:30;
  weekend detection; the 12-trip loss windows (2→50%, 3→100%); team >3 cutoff;
  zero-video-but-counted is rejected (the 05-11 anomaly).
- `lib/fieldRoster.test.ts` — seed map + alias override + unknown.
- `lib/lossExtractPrompt.test.ts` — tool shape and required fields.
- Reconciliation check (manual/integration): May diff vs the sheet surfaces
  exactly the known anomaly days and nothing else.

## Out of scope (v1)

- The assemblers' "ready-drone" fund.
- Editing/retro-correcting the source Звіт reports from the console.
- Engineer-vs-pilot roster nuance beyond "two people in field" (documented, not
  enforced).
