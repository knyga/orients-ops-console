# Per-person drone counts in field-verdict messages

**Date:** 2026-07-02
**Status:** Design approved, pending spec review

## Problem

The daily field-verdict Slack messages (`lib/verdictPublish.ts` → `formatDayMessage`) already show a crew line:

```
⚠️ 2026-06-25 (четвер) — потрібна перевірка: політ відбувся (16:30–19:00), але час у повітрі не вказано; немає повідомлення про датасет за цей день (відео 0 хв, без датасету).
👥 У полі: Влад, Тарас.
```

but carry **no information about how many drones each person had that day**. That information exists — it is posted separately in #field-qa as a free-text drone-count / production report, e.g.:

```
Андріан R&D - 1шт вартовий+ 1 шт азимут (3ремонт : термалка азимут вартовий)
Любомир R&D -1шт вартовий 1шт азимут 1шт термалка
Демонстраційні - 8 шт (Перевірені - 8шт ( 2 шт азимут)
15ка - 1шт
```

Today this report is only **classified as a binary** (`present: true/false`) by `lib/droneCountReport.ts` — used solely as a bonus-gate check ("a drone-count report was posted → the day counts"). The per-person / per-category quantities are never parsed or surfaced.

**Goal:** parse *who had how many drones* out of these reports and add a per-person drone-count line to the verdict message.

## Attribution rule

A drone-count report is attributed to the **date it was published** (the Slack post's Kyiv date), **unless the report text explicitly names a different date**, in which case it is attributed to that named date.

## Decisions (from brainstorming)

- **Primary outcome:** enrich the verdict Slack messages (not a standalone query feature — though the data lands in the report/web for free).
- **Display:** a per-person line plus a grand total; non-person categories folded into an "other" (`інші`) bucket.
- **Names:** shown **as written** in the report (no people-registry resolution).
- **Which days:** every published/settled day (ACCEPTED / NEEDS_REVIEW / ACCEPTED_EXCEPTION) that has a parseable drone report gets the line; days with no report get no line.

## Approach (A — extract in field-qa, persist, verdict reads it)

Fits the house *extract → persist → compute → render* pattern. Keeps `computeVerdicts` Claude-free. Puts the drone data in the persisted field-qa report so the web field-verdict tab + CSV get it for free (two-interface rule). The structured classifier can later replace the bonus path's duplicate binary call (noted as out-of-scope follow-up).

### 1. Structured classifier — `lib/droneCountReport.ts` + `lib/droneCountReportPrompt.ts`

Upgrade the binary classifier to structured output:

```ts
export interface DroneEntry {
  name: string;      // as written in the report, e.g. "Андріан", "Демонстраційні", "15ка"
  isPerson: boolean; // true for a person, false for a category
  count: number;     // sums multi-item lines: "1шт вартовий + 1 шт азимут" -> 2
}

export interface DroneCountReport {
  present: boolean;       // derived: entries.length > 0  (bonus gate stays identical)
  entries: DroneEntry[];
  forDate: string | null; // YYYY-MM-DD only when the report text explicitly names a date
  note: string;           // short quote of the matched drone-count line(s), or ""
}
```

Claude tool schema (`record_drone_count_report`) is extended to return `entries` (array of `{name, isPerson, count}`) plus optional `forDate`. Rules encoded in the prompt/description:

- `count` sums all `Nшт` quantities on a person/category's line(s).
- `isPerson` distinguishes people (`Андріан`, `Любомир`) from categories (`Демонстраційні`, `Перевірені`, `15ка`). Qualifiers like `R&D` on a person line are tags, not separate entries — the person is the name.
- `forDate` is set **only** when the report text explicitly names a date; otherwise omitted/null.
- A flight-hours "Звіт" (roster + time window) or general chatter is **not** a drone-count report → `entries: []`.

**Backward compatibility:** `present` is derived (`entries.length > 0`). The existing bonus-gate caller (`computeBonuses` → `classifyDroneCount(...).present`) is unchanged in behavior.

### 2. Extraction pass — `lib/extractDroneReports.ts`, called by `extractFieldQa`

A dedicated orchestrator (isolated from the airborne vision extraction, which reads stat-card images):

1. `readChannelMessages("field-qa", period)`, filter `!deleted`.
2. Group each day's message text by **Kyiv post-date** via `videoUploadDate(new Date(Number(ts)*1000).toISOString())` — the same grouping the bonus path (`computeBonuses`) uses.
3. One classifier call per day that has text.
4. **Attribution:** if the classifier returns `forDate`, reassign those entries to that date; otherwise keep the post-date.
5. **Merge:** when multiple reports resolve to the same target date, merge entries by `name`+`isPerson`, summing `count`.
6. Return a `Record<string, DroneEntry[]>` (date → entries).

`extractFieldQa` writes the per-date entries onto the field-qa report as `days[].droneReport: DroneEntry[]` (matched by date). Drone reports whose target date has no field-qa day are dropped (logged), since no verdict day exists to carry them.

### 3. Verdict passthrough — `computeVerdicts` + `DayVerdict`

Add an optional field to `DayVerdict` (`lib/fieldDayVerdict.ts`):

```ts
droneReport?: DroneEntry[];
```

`computeVerdicts` reads the field-qa report's `days[].droneReport` and copies it onto each `DayVerdict` by date. No Claude call added to `computeVerdicts`.

### 4. Rendering — `formatDayMessage` + `formatDroneLine`

Pure helper:

```ts
export function formatDroneLine(entries: DroneEntry[]): string | null
```

Given entries, produce (returns `null` when `entries` is empty):

```
🛸 Дрони: Андріан 2, Любомир 3, інші 9 (усього 14)
```

- People (`isPerson`) listed as-written, `"<name> <count>"`, comma-joined, in report order.
- Non-person categories summed into a single `інші <otherTotal>` term (omitted when zero).
- Grand total = sum of all counts, rendered as `(усього <grandTotal>)`.

`formatDayMessage` appends this as a **new trailing line** after the crew suffix when `day.droneReport` is non-empty.

**Region discipline (critical):** the message body has disjoint, separately-edited regions:

- the verdict body (approver-override strike edits its region),
- the crew suffix `👥 У полі: …` (roster corrections edit this region),
- the new drone line `🛸 Дрони: …`.

The drone line goes **after** the crew suffix as its own `🛸`-prefixed line. `splitRosterSuffix` (`lib/verdictPublish.ts`) must be updated so the roster region still splits cleanly with a trailing `🛸` line present (the roster suffix is the text between `👥` and either end-of-string or the `🛸` line). Covered by round-trip tests.

### 5. Two-interface surface (per CLAUDE.md)

- **CLI:** the `field-verdict` report JSON already carries `droneReport` via `DayVerdict` (no extra work). Add a `drones` column to the verdict CSV (`scripts/fieldVerdictReport.ts`), rendered as `Андріан 2; Любомир 3; інші 9 (14)` (semicolon-separated to stay CSV-safe).
- **Web:** add a Drones column/detail to the field-verdict table (`app/(dashboard)/field-verdict/page.tsx`), rendered from the same `formatDroneLine` logic (or its parts).

### 6. Backfill / nightly

- `extractDroneReports` runs inside Stage 3 (`extractFieldQa`) of `runNightly`, so the nightly pipeline picks it up automatically — no new stage.
- `field-backfill` (`lib/backfillPublished.ts`) re-renders already-published messages via `formatDayMessage`, so a backfill run adds the drone line to historical messages. It already **skips overridden days**, so no approver amendment is clobbered.

## Error handling

- Classifier failure for a day → treat as no drone report for that day (log; never block the extract/verdict pipeline). Matches the best-effort posture of the nightly pipeline.
- A drone report attributed (via `forDate` or post-date) to a date with no field-qa day → dropped and logged; nothing to render.
- Empty/zero entries → no drone line rendered.

## Testing

Pure units (LLM classifier mocked per the vitest server-only pattern — `vitest.config.ts` aliases `server-only`, deps via `vi.hoisted`):

- `formatDroneLine`: people-only, people+other, other-only, empty → `null`, total arithmetic.
- Attribution + merge: `forDate` reassignment; same-day merge sums by `name`+`isPerson`; post-date default.
- `splitRosterSuffix`: round-trips with a trailing `🛸` drone line present and absent.
- `formatDayMessage`: renders the drone line after the crew suffix; omits it when absent; region layout stable.
- Bonus-gate regression: `present` still derived correctly so `computeBonuses` behavior is unchanged.

## Out of scope (follow-up)

- Unifying the bonus path (`computeBonuses`) to read `days[].droneReport` from the field-qa report instead of its own live `classifyDroneCount` call. A DRY win, but left out to keep this change contained; the bonus gate is untouched here.
- People-registry (`lib/people.ts`) resolution of report names — names are shown as written.
