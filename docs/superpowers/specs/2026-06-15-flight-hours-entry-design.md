# Design: Flight-hours entry & persistence (web + CLI)

Date: 2026-06-15
Status: Approved (pending spec review)

## Goal

Give flight-hours data a real place to be **entered and persisted** from both the
web dashboard and the command line, so the (separate) reconciliation task can
read a single canonical source instead of relying on the current browser-only,
ephemeral input.

## Scope

**In scope:**

- A committed CSV store for flight hours: `data/flight-hours.csv`.
- Pure serialization/upsert helpers added to `lib/flightHours.ts`.
- A thin Node file-I/O module shared by the API route and the CLI.
- An API route (`GET`/`PUT`) to read and save flight hours.
- Web: the existing field-ops flight-hours editor loads from and saves to the
  store (an explicit Save button); it is no longer ephemeral.
- CLI: add/upsert a single day and list current entries.

**Out of scope (deferred to the reconciliation task):**

- Reconciling flight hours against Vimeo from the CLI (the 50% gate). That task
  will consume `readFlightDays()` from this design.
- Any change to the existing client-side reconciliation already shown on the
  field-ops page (it keeps working unchanged).

## Decisions (from brainstorming)

- **Storage format:** CSV, reusing the existing `parseFlightHoursCsv`.
- **Git tracking:** committed to the repo (shared canonical record).
- **CLI operations:** add (`--date`/`--hours`, duplicate dates sum) + list.
- **Web write path:** an API route (`GET`/`PUT`) backed by a shared file module,
  mirroring the existing `/api/vimeo` pattern. (Server actions rejected for
  consistency; CLI-only writes rejected — the web is part of the entry surface.)

## Components

### 1. Storage — `data/flight-hours.csv`

- Committed. Columns `date,flight_hours`; one row per day; sorted ascending by
  date; a header line.
- `data/flight-hours.example.csv` (committed) documents the format with a couple
  of sample rows.
- Initial `data/flight-hours.csv` is committed containing only the header line
  (empty dataset), so the path always exists.

### 2. Pure logic — extend `lib/flightHours.ts` (no I/O, unit-tested)

The file already exports `parseFlightHoursCsv` and `toFlightDays`. Add:

- `serializeFlightDays(days: FlightDay[]): string`
  - Emits `date,flight_hours\n` header followed by one `YYYY-MM-DD,<hours>` line
    per day, sorted ascending by date. Trailing newline after the last row.
  - `<hours>` is the number rendered plainly (e.g. `2`, `1.5`); no forced
    decimals.
- `upsertFlightDay(days: FlightDay[], date: string, hours: number): FlightDay[]`
  - Returns a new array with `hours` summed into an existing entry for `date`,
    or a new entry appended; result sorted ascending by date. This matches the
    duplicate-summing rule in `toFlightDays`.
  - Pure; does not validate (callers validate before calling — see below).

`lib/flightHours.ts` must stay free of React/Next/Node imports so it remains
pure and testable, consistent with the repo convention.

### 3. File I/O — `lib/flightHoursFile.ts` (new; Node `fs`)

- **Boundary:** imports `node:fs`. Imported ONLY by the API route (server) and
  the CLI (Node) — never from a `"use client"` component. It holds no secret
  (the CSV is committed), so it deliberately does NOT use `server-only`; this
  keeps the CLI runnable with plain `tsx` (no `--conditions=react-server`).
  A doc comment states the no-client-import rule.
- `FLIGHT_HOURS_PATH` — absolute path to `data/flight-hours.csv` resolved from
  the repo root (via `process.cwd()`).
- `readFlightDays(path = FLIGHT_HOURS_PATH): FlightDay[]`
  - Reads the file, runs `parseFlightHoursCsv` then `toFlightDays`. Returns `[]`
    if the file does not exist (ENOENT). Other read errors propagate.
- `writeFlightDays(days: FlightDay[], path = FLIGHT_HOURS_PATH): void`
  - Ensures the parent directory exists, then writes
    `serializeFlightDays(days)`. Overwrites the whole file (the dataset is
    small and always written in full).
- The `path` parameter exists so unit tests can round-trip through a temp dir.

### 4. API route — `app/api/flight-hours/route.ts`

- `export const runtime = "nodejs"; export const dynamic = "force-dynamic";`
  (file I/O must run on the Node runtime and never be cached.)
- `GET` → `{ flightDays: FlightDay[] }` from `readFlightDays()`.
- `PUT` — body `{ rows: FlightHoursRow[] }`.
  - Validate/normalize with `toFlightDays(rows)` (drops invalid/non-positive
    rows, sums duplicates). If the body is not an object with a `rows` array,
    return `400 { error }`.
  - `writeFlightDays(flightDays)`, then return `{ flightDays }` (the normalized,
    saved set) so the client can re-seed from the source of truth.
  - Unexpected errors → `500 { error }`.
- Mirrors `/api/vimeo`'s JSON-error shape (`{ error }` with appropriate status).

### 5. Web entry interface — `app/(dashboard)/field-ops/page.tsx` + `components/FlightHoursEditor.tsx`

- On mount, the page fetches `GET /api/flight-hours` and seeds `flightRows` from
  the returned `flightDays` (mapping each `FlightDay` to a `FlightHoursRow` with
  a fresh id and `hours` as a string).
- A **Save** control (in the editor header, beside `+ Row` / `Upload CSV`) `PUT`s
  the current `flightRows` as `{ rows }`. On success it re-seeds `flightRows`
  from the response and shows a transient "Saved" state; on failure it shows an
  error message (same red-text style already used for CSV errors).
- The editor heading label changes from `(ephemeral)` to `(saved)`.
- The Save action is owned by the page (which holds the rows and the API
  interaction); the editor receives an `onSave` callback plus `saving`/`saved`/
  `saveError` display state via props, keeping the component presentational.
- Client-side reconciliation (`useMemo` over `aggregateByDay`/`summarize`) is
  unchanged.

### 6. CLI — `scripts/flightHours.ts` (+ pure `scripts/flightHoursCli.ts`)

- npm script: `"flight-hours": "node --import tsx scripts/flightHours.ts"`
  (no `--conditions=react-server`: nothing here imports `server-only`).
- `scripts/flightHoursCli.ts` (pure, unit-tested):
  - `parseArgs(argv): { date?: string; hours?: string; list: boolean; format: "json" | "table" }`.
  - `formatTable(days: FlightDay[]): string` — compact table with a total-hours
    line.
- `scripts/flightHours.ts` (thin orchestration):
  - `--list`: `readFlightDays()` → print JSON (default) or table (`--format table`).
  - `--date D --hours H`: validate `D` is `YYYY-MM-DD` and `H` is a finite
    number `> 0`; on bad input print `flight-hours: <message>` to stderr and exit
    1. Otherwise `readFlightDays()` → `upsertFlightDay(days, D, Number(H))` →
    `writeFlightDays(...)`, then print the updated entry / full list confirmation.
  - If neither `--list` nor a complete `--date`+`--hours` pair is given, print a
    one-line usage message and exit 1.
  - Errors are reported as `flight-hours: <message>` with exit code 1 (mirrors
    the Vimeo CLI's error style).

## Data flow

```
Web:  mount → GET /api/flight-hours → seed rows → edit → Save → PUT { rows }
            → toFlightDays(normalize) → writeFlightDays → data/flight-hours.csv
CLI add:  read CSV → upsertFlightDay → write CSV
CLI list: read CSV → print JSON/table
Later (other task): readFlightDays() + Vimeo → reconciliation gate
```

## Error handling

- Pure helpers: total functions; no throwing for normal input. `upsertFlightDay`
  assumes a validated positive `hours`.
- `readFlightDays`: missing file → `[]`; other fs errors propagate.
- API `PUT`: malformed body → 400; write failure → 500; both as `{ error }`.
- CLI: invalid/again missing args → stderr `flight-hours: <message>` + exit 1.
  No secrets are involved, so error text is safe to print verbatim.

## Testing

- **Pure (`lib/flightHours.test.ts`, new):** `serializeFlightDays` (header,
  ordering, round-trips with `parseFlightHoursCsv`+`toFlightDays`),
  `upsertFlightDay` (new day, summing an existing day, sort order).
- **File I/O (`lib/flightHoursFile.test.ts`, new):** round-trip
  `writeFlightDays` → `readFlightDays` through a temp-dir path; `readFlightDays`
  on a non-existent path returns `[]`.
- **CLI parsing (`scripts/flightHoursCli.test.ts`, new):** `parseArgs` flag
  combinations; `formatTable` content (rows + total line).
- **Manual:** API `GET`/`PUT` via the running app; the web Save round-trip;
  `npm run flight-hours -- --date … --hours …` then `--list`.

## Conventions

- `lib/flightHours.ts` stays pure (no Node/React imports). Node I/O is isolated
  in `lib/flightHoursFile.ts`.
- Scripts use relative imports (no `@/*` alias in the Vitest-less test config),
  matching the Vimeo CLI work.
- API route and JSON-error shape follow the existing `/api/vimeo` route.
- TypeScript `strict` stays on.
