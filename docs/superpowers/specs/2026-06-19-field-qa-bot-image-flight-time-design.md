# Design: Field-QA flight time from the stats-bot image (vision)

Date: 2026-06-19
Status: Proposed (pending review)

**Revises** `docs/superpowers/specs/2026-06-18-field-qa-flight-hours-design.md`.
The flight-time source changes from the pilots' free-text `Звіт` *session windows*
to the stats bot's measured **airborne time**, read from its daily summary image.

## Why

The 50% video-completeness gate must compare Vimeo video minutes against the
**bot's measured flight time**, per the operational policy
(`docs/operational-policies-changelog.md`, "наліт … через метрики бота … додатково
звіряється Vimeo") and the authoritative May reconciliation sheet
(`docs/Personal Field Metrics May 2026/Статистика.html`, row "Час в повітрі").

The merged feature parses pilot `Звіт` windows (e.g. `15:20-18:30` = 190 min),
which is the *field session*, not flight time. The bot's airborne time for the
same day is ~18 min. These differ by ~10×, so the current input is wrong.

**Confirmed gate (user, 2026-06-19):** `Vimeo video minutes ≥ 50% × airborne
minutes`, where airborne minutes come from the bot image. Numerator = Vimeo
(unchanged `reconcile.ts`); only the flight-time *input* changes source.

## Source data

In #field-qa, the stats bot (user `U08R76N8HV2`) posts one message per flight
day: text `Статистика польотів за <YYYY-MM-DD>` with an attached PNG
`today_full_summary.png` (800×600). The image is a fixed key/value table:

```
Сьогодні літали            Так | Ні
Кількість польотів         <int>
Час в повітрі (сек)        <int seconds>      ← the flight-time figure
Пролетіли метрів           <int>
Час польоту min/avg/max    <int>/<int>/<int>
```

- The **date** comes from the message title (already `YYYY-MM-DD`).
- The **flight time** is `Час в повітрі (сек)` → `flight_hours = seconds / 3600`.
- `Сьогодні літали = Ні` (or no airborne time) ⇒ no flight that day ⇒ no row.
- Requires the `files:read` Slack scope (now granted) to download the image.

## Components (revision of the existing feature)

### 1. `lib/slack.ts` — expose file attachments + a download helper (server-only)

- Extend the normalized message to carry file metadata. Add to `SlackMessage`
  (in `lib/policySchedule.ts`, where the type lives) an optional
  `files?: { name: string; mimetype: string; urlPrivate: string }[]`, populated
  from the raw `conversations.history` `.files[]` (`url_private`). Optional, so
  the policy feature is unaffected.
- Add `downloadFileBase64(urlPrivate: string): Promise<string>` — GETs the file
  with the bearer token and returns base64. Throws `SlackError` on the HTML
  login-page response (missing scope) or non-image content-type.

### 2. `lib/flightExtractPrompt.ts` — vision prompt + tool schema (pure)

- Replace the `Звіт`-text prompt with a **vision** instruction: "from this flight
  summary image, return the airborne time in seconds (`Час в повітрі`), the flight
  count, and whether they flew." Keep it a pure builder (string + the tool
  schema); the image block is attached by the caller.
- `FLIGHT_HOURS_TOOL` input schema → one object: `{ flew: boolean,
  airborneSeconds: number, flights: number }` (per image — date is known from the
  message, not the image).
- `ExtractedDay` becomes `{ date, airborneSeconds, flightHours, flights, permalink }`.

### 3. `lib/flightExtract.ts` — vision call (server-only)

- `extractAirborne(imageBase64): Promise<{ flew, airborneSeconds, flights }>` —
  one `claude-sonnet-4-6` Messages call with an `image` content block + the
  prompt + forced tool-use. Errors → `FlightExtractError`.
- One call per day-image (≤ ~31/month). Cheap; runs in the CLI only.

### 4. `scripts/fieldQaReport.ts` (pure) — shaping

- `validateDays`: drop `flew === false` or `airborneSeconds ≤ 0`; `flight_hours
  = round2(airborneSeconds / 3600)`; one row per date; sort ascending.
- `toInputsCsv` unchanged (`date,flight_hours`).
- Provenance `buildReport`: per day `{ date, flightHours, airborneSeconds,
  flights, permalink }`; totals.

### 5. `scripts/fieldQa.ts` (CLI) — orchestration

- Fetch #field-qa messages for the period → keep stats-bot `Статистика польотів
  за <date>` messages with an image → for each: parse date from title, download
  image (`downloadFileBase64`), `extractAirborne`, attach date → `validateDays`.
- `--write` unchanged: `reports/field-ops/inputs/<period>.csv` +
  `reports/field-qa/<period>.{json,csv}`.

### 6. `reconcile.ts` / field-ops — **unchanged**

The gate already computes `recordedMinutes(Vimeo) / flightMinutes ≥ 50%`. With
the input now carrying bot-airborne minutes, the gate matches policy. No change.

### 7. Web tab + skill — minor copy update

- Field QA tab: columns become date, airborne (min), flights, permalink. Drop
  crew/windows.
- Skill: update "how it works" to the bot image + `files:read` requirement.

## What is removed

- `Звіт`-window LLM text parsing (crew, time windows) — no longer the source.
  The pilot `Звіт` reports stay in Slack but no longer feed reconciliation.

## Testing

- Pure: `validateDays` (drop non-flew/zero, round, sort), `toInputsCsv`,
  `buildReport`, `parseArgs/resolvePeriod`, the title→date parse.
- Prompt builder + tool schema shape (unit).
- Vision call + image download: not unit-tested (network), consistent with repo
  convention. Manual acceptance: `npm run field-qa -- --start … --end …` prints
  per-day airborne minutes matching the images (06-18 = 1110s ⇒ 0.31h;
  06-13 = 1217s ⇒ 0.34h); `--write` then `npm run fieldops … --format table`
  reconciles Vimeo against the bot-airborne flight time.

## Conventions

- `files:read` is required; document it in `.env.example`'s Slack block and the skill.
- Server-only discipline unchanged (`lib/slack.ts`, `lib/flightExtract.ts`).
- Pure shaping stays unit-tested; relative imports in scripts.
