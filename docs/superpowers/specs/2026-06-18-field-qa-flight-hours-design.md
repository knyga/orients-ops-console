# Design: Field-QA flight-hours extraction (Slack → Claude → reconciliation input)

Date: 2026-06-18
Status: Approved (pending spec review)

**Supersedes** `docs/superpowers/specs/2026-06-15-flight-hours-entry-design.md`
(manual CSV entry). Flight hours are not hand-entered; they are extracted from
the #field-qa Slack channel with an LLM and feed the existing reconciliation.

## Goal

Produce the flight-hours input the field-ops reconciliation already consumes
(`reports/field-ops/inputs/<period>.csv`, `date,flight_hours`) by reading the
team's #field-qa Slack reports and extracting per-day flight time with Claude,
instead of filling that CSV by hand.

## Background (what already exists)

- `lib/slack.ts` — server-only Slack client (`SLACK_TOKEN`), `fetchMessages(period)`
  returns normalized `SlackMessage[]` (channel name, author, ts, isoTime, text,
  permalink) for every channel in `lib/slackChannels.ts` (now the real Orients
  channels, including `field-qa` = `C08GY2NKF9D`).
- `scripts/fieldops.ts` — reconciles Vimeo vs `reports/field-ops/inputs/<period>.csv`
  (parsed by `parseFlightHoursCsv` + `toFlightDays`); `--inputs` overrides the path;
  a missing file is a warning (all days video-only FLAG).
- `lib/reports.ts` — `writeReport(feature, period, {json, csv})`,
  `readReportJson`, `listPeriods`, `reportPath`, `defaultBaseDir`, `periodKey`.
- `lib/summarize.ts` — precedent for server-only Claude calls via
  `@anthropic-ai/sdk` reading `ANTHROPIC_API_KEY`.
- House pattern (`authoring-reporting-features`): skill → CLI `--write` →
  committed `reports/<feature>/<period>.{json,csv}` → web renders the artifact.

## Pipeline position

```
#field-qa (Slack)  ──fetchMessages──▶  Claude extract  ──▶  reports/field-ops/inputs/<period>.csv
                                              │                      │
                                              └─ provenance ─▶ reports/field-qa/<period>.json
                                                                     │
                                       (existing) scripts/fieldops.ts reconciles vs Vimeo
```

## Decisions (from brainstorming)

- **Source message:** the `Звіт <DD.MM.YYYY>` report; flight hours = sum of the
  `HH:MM-HH:MM` window(s) on the crew line(s). Multiple windows per day are
  summed.
- **Extraction:** LLM, not a deterministic parser (reports are noisy Ukrainian
  free-text).
- **Model:** `claude-sonnet-4-6`.
- **Write target:** `--write` writes directly to
  `reports/field-ops/inputs/<period>.csv` (the contract `fieldops` reads), plus a
  `reports/field-qa/<period>.json` provenance artifact. Review happens via the git
  diff and the web audit view before reconciliation runs.
- **Web:** committed-only (no live LLM call on web requests).
- **Primary interface is Claude Code.** The skill + CLI are the main surface
  (extraction is driven by asking Claude Code, which runs `npm run field-qa`);
  the web tab is a minimal read-only audit view, not the focus. Build order and
  polish prioritize the CLI/skill; keep the web view lean.

## Components

### 1. LLM extraction — `lib/flightExtract.ts` (new, SERVER-ONLY)

- `import "server-only"`; reads `ANTHROPIC_API_KEY` (throw a clear
  `FlightExtractError` if absent, mirroring `SummarizeError`).
- `extractFlightDays(messages: SlackMessage[]): Promise<ExtractedDay[]>`
  - One Anthropic Messages API call for the whole period using **forced tool
    use** for structured output: a tool `report_flight_hours` whose
    `input_schema` is an array of days. Parse the `tool_use` block; if
    `stop_reason === "refusal"` throw `FlightExtractError`.
  - `model: "claude-sonnet-4-6"`, `max_tokens` sized for the day list.
  - Prompt instructs: consider only `Звіт <date>` reports; convert `DD.MM.YYYY`
    → `YYYY-MM-DD`; for each report sum every `HH:MM-HH:MM` window to decimal
    hours (overnight windows where end < start wrap past midnight → add 24h);
    return one entry per date; ignore inventory/repair/misc messages and the
    `Статистика польотів` posts.
- `ExtractedDay` shape:
  ```ts
  interface ExtractedDay {
    date: string;          // YYYY-MM-DD (from report text)
    flightHours: number;   // summed decimal hours
    windows: { start: string; end: string }[];
    crew: string | null;   // e.g. "А+Д"
    sourceTs: string;      // ts of the Звіт message (for permalink lookup)
  }
  ```
- **Prompt builder is a pure exported function** (`buildExtractionPrompt(messages)`)
  so it is unit-testable without the network. The API call is the only impure part.

### 2. Pure shaping — `scripts/fieldQaReport.ts` (unit-tested)

- `parseArgs(argv)` → `{ start?, end?, write: boolean, format: "json" | "table" }`
  (same shape/idiom as the other report CLIs).
- `resolvePeriod(args, today)` → `Period` (explicit bounds when both present
  else current Kyiv month; throws on malformed date) — reuse the established idiom.
- `validateDays(days: ExtractedDay[]): ExtractedDay[]` — drop entries whose
  `date` is not `YYYY-MM-DD` or whose `flightHours` is not finite `> 0`; sum
  duplicate dates; sort ascending by date. Pure.
- `toInputsCsv(days): string` — `date,flight_hours` header + one row per day
  (hours rendered plainly, e.g. `3.17`). This is BOTH the fieldops input and the
  field-qa `.csv` sidecar.
- `toProvenanceJson(days, period, permalinkByTs): object` — the lossless artifact:
  `{ period, days: [{ date, flightHours, windows, crew, permalink }], sourceChannel: "field-qa" }`.
- `formatTable(days): string` — compact human table + total-hours line.

### 3. CLI — `scripts/fieldQa.ts` (orchestration)

- npm script: `"field-qa": "node --conditions=react-server --import tsx scripts/fieldQa.ts"`.
- Flow: `process.loadEnvFile()` (ignore if absent) → `parseArgs` → `resolvePeriod`
  → `fetchMessages(period)` → keep only `channel === "field-qa"` messages →
  `extractFlightDays` → `validateDays`.
- Output: print provenance JSON (default) or `formatTable` (`--format table`).
- `--write` persists:
  - `reports/field-ops/inputs/<key>.csv` — via a direct write to
    `join(defaultBaseDir(), "field-ops", "inputs", "<key>.csv")` (creates the
    dir), matching `fieldops`'s `defaultInputsPath`.
  - `reports/field-qa/<key>.{json,csv}` — via `writeReport("field-qa", period,
    { json: provenanceJson, csv: inputsCsv })`. The `.json` is the web render
    source; the `.csv` mirrors the inputs CSV.
  - Print a stderr summary (`wrote … (<n> days, <total> h)`).
- Errors: `fieldExtractError`/`SlackError`/etc. → `field-qa: <message>` to stderr,
  exit 1. No secret values are printed.

### 4. API route — `app/api/field-qa/route.ts`

- `runtime = "nodejs"`, `dynamic = "force-dynamic"`.
- `GET /api/field-qa` (no `period`) → `{ periods: listPeriods("field-qa") }`.
- `GET /api/field-qa?period=YYYY-MM` → `readReportJson("field-qa", period)` or
  `404 { error }` when absent. Committed-only — never calls Slack/Claude.
- JSON-error shape consistent with the other routes.

### 5. Web — `app/(dashboard)/field-qa/page.tsx` + nav tab

- A "Field-QA" tab (enabled) in `app/(dashboard)/layout.tsx`.
- Period picker seeded from `GET /api/field-qa` (the committed period list);
  selecting one loads the artifact and renders a table: per day → flight hours,
  windows, crew, and a **permalink to the source Slack message** (audit trail).
- Read-only. Purpose: verify extracted hours before they flow into reconciliation.

### 6. Skill — `.claude/skills/field-qa-flight-hours/SKILL.md`

- Describes when to use (questions about field flight hours from #field-qa; or
  "extract/refresh flight hours for <month>"), how to run `npm run field-qa`,
  the artifact locations, and that `--write` feeds `scripts/fieldops.ts`. States
  the review-before-reconcile workflow and that extraction is LLM-based
  (non-deterministic; review the diff).

## Data flow & review workflow

1. `npm run field-qa -- --start … --end … --write` → extracts, writes inputs CSV
   + provenance JSON.
2. Human reviews the git diff / the Field-QA web view (permalinks back to Slack).
3. Edit the committed CSV if the LLM got something wrong.
4. `npm run fieldops -- --start … --end … --write` → reconciliation artifact.

The LLM never silently feeds the gate — a committed, reviewable artifact sits
between extraction and reconciliation.

## Error handling

- Missing `SLACK_TOKEN` → `SlackError` (clear message, exit 1).
- Missing `ANTHROPIC_API_KEY` → `FlightExtractError` (clear message, exit 1).
- Slack API/scope errors → surfaced via `SlackError` (502/etc.).
- LLM refusal or unparseable tool output → `FlightExtractError`, exit 1 (no
  partial CSV written).
- `validateDays` silently drops malformed rows; the stderr summary reports the
  kept count so silent loss is visible.
- API `GET` for an absent period → 404; malformed artifact → 500.

## Testing

- **Pure (`scripts/fieldQaReport.test.ts`):** `parseArgs`, `resolvePeriod`,
  `validateDays` (drop invalid, sum duplicates, sort), `toInputsCsv`,
  `toProvenanceJson`, `formatTable`.
- **Prompt (`lib/flightExtract.test.ts`):** `buildExtractionPrompt` includes the
  candidate messages and the extraction rules; the network call itself is not
  unit-tested (consistent with `lib/summarize.ts`).
- **Manual acceptance:** `npm run field-qa -- --start 2026-06-01 --end 2026-06-18`
  returns sensible JSON for the real #field-qa reports (e.g. 18.06 `А+Д
  15:20-18:30` → 3.17h); `--write` produces both artifacts; `npm run fieldops …`
  then reconciles using them; the web tab renders with working Slack permalinks.

## Conventions

- Server-only client (`lib/flightExtract.ts`) keeps `ANTHROPIC_API_KEY` off the
  browser; `lib/slack.ts` keeps `SLACK_TOKEN` off the browser. The CLI runs under
  `--conditions=react-server` (npm script) so both `server-only` imports resolve.
- Pure shaping lives in `scripts/fieldQaReport.ts` and the prompt builder; both
  are unit-tested. Scripts use relative imports (no `@/*` alias in tests).
- Artifacts follow the `reports/<feature>/<period>.{json,csv}` convention via
  `lib/reports.ts`; the inputs CSV follows `fieldops`'s existing path.
- TypeScript `strict` stays on.
```
