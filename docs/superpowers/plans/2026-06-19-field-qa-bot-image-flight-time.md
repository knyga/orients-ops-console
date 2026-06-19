# Field-QA Flight Time from Bot Image (S2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the `Звіт`-window LLM text extraction with vision extraction of the stats bot's `Час в повітрі` (airborne seconds) from its daily `today_full_summary.png`, feeding the same `reports/field-ops/inputs/<period>.csv` contract.

**Architecture:** `lib/slack.ts` exposes message file attachments + a `downloadFileBase64` helper (needs `files:read`). `lib/flightExtractPrompt.ts` + `lib/flightExtract.ts` become a **vision** call (image content block, forced tool-use, `claude-sonnet-4-6`) returning `{flew, airborneSeconds, flights}` per image. `scripts/fieldQa.ts` finds the stats-bot daily messages, parses the date from the title, downloads each image, extracts, and writes the input CSV + provenance. `reconcile.ts`/field-ops is unchanged.

**Tech Stack:** TypeScript strict, `@anthropic-ai/sdk` vision, Slack Web API (`files:read`), Vitest. CLI under `node --conditions=react-server --import tsx`.

Spec: `docs/superpowers/specs/2026-06-19-field-qa-bot-image-flight-time-design.md`.

---

## File Structure
- `lib/policySchedule.ts` (modify) — add optional `files` to `SlackMessage`.
- `lib/slack.ts` (modify) — populate `files`; add `downloadFileBase64`.
- `lib/flightExtractPrompt.ts` (rewrite) — vision prompt + `AIRBORNE_TOOL` schema; `AirborneExtract` type.
- `lib/flightExtract.ts` (rewrite) — `extractAirborne(imageBase64, mediaType)`.
- `scripts/fieldQaReport.ts` (modify) — `ExtractedDay` carries `airborneSeconds`/`flights`; reshape `validateDays`/`toInputsCsv`/`buildReport`/`formatTable`.
- `scripts/fieldQa.ts` (rewrite) — bot-message → image → extract orchestration.
- `lib/flightExtractPrompt.test.ts`, `scripts/fieldQaReport.test.ts` (update).
- `app/(dashboard)/field-qa/page.tsx`, `.claude/skills/field-qa-flight-hours/SKILL.md`, `.env.example` (update copy + `files:read`).

Relative imports in scripts; `import type` for cross-module types to avoid pulling `server-only`.

---

## Task 1: Slack file attachments + download helper

**Files:** Modify `lib/policySchedule.ts`, `lib/slack.ts`; Test `lib/slack.test.ts` (create, for the pure mapper).

- [ ] **Step 1: Add the file type to `SlackMessage`** in `lib/policySchedule.ts` — after the `permalink` field inside the interface add:
```ts
  /** Attached files (e.g. the stats-bot summary image), when present. */
  files?: SlackFile[];
```
and above the `SlackMessage` interface add:
```ts
/** A file attached to a Slack message (subset of fields we use). */
export interface SlackFile {
  name: string;
  mimetype: string;
  /** Authenticated download URL (needs the bot token + files:read). */
  urlPrivate: string;
}
```

- [ ] **Step 2: Write the failing test** `lib/slack.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { toSlackFiles } from "./slack";

describe("toSlackFiles", () => {
  it("maps raw Slack file objects, preferring the download url", () => {
    expect(
      toSlackFiles([
        { name: "a.png", mimetype: "image/png", url_private: "u", url_private_download: "d" },
      ]),
    ).toEqual([{ name: "a.png", mimetype: "image/png", urlPrivate: "d" }]);
  });
  it("returns undefined when there are no files", () => {
    expect(toSlackFiles(undefined)).toBeUndefined();
    expect(toSlackFiles([])).toBeUndefined();
  });
});
```
Run `npx vitest run lib/slack.test.ts` → FAIL (no `toSlackFiles`).
NOTE: `lib/slack.ts` imports `server-only`; Vitest runs without the `react-server` condition, so this import would throw. To keep `toSlackFiles` unit-testable, put it ABOVE the `import "server-only"` line is not possible (imports hoist). Instead extract `toSlackFiles` into a tiny pure module `lib/slackFiles.ts` (no server-only) and re-export from `lib/slack.ts`. Update the test import to `./slackFiles`. (Adjust Step 2's import accordingly before running.)

- [ ] **Step 3: Implement** `lib/slackFiles.ts`:
```ts
import type { SlackFile } from "./policySchedule";

interface RawFile {
  name?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
}

/** Map raw Slack `.files[]` to our SlackFile shape; undefined when none. */
export function toSlackFiles(raw: RawFile[] | undefined): SlackFile[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((f) => ({
    name: f.name ?? "",
    mimetype: f.mimetype ?? "",
    urlPrivate: f.url_private_download ?? f.url_private ?? "",
  }));
}
```
Run the test → PASS.

- [ ] **Step 4: Wire into `lib/slack.ts`** — (a) extend the history response type and the normalized push to include files; (b) add the downloader. In the `HistoryResponse` `messages` item type add `files?: RawFile[]` (import the `RawFile`/`toSlackFiles` from `./slackFiles`; declare `RawFile` export there or inline). In the `collected.push({...})` add `files: toSlackFiles(m.files)`. Then add, after `fetchMessages`:
```ts
/** Download a Slack file (e.g. the stats-bot image) as base64. Needs files:read. */
export async function downloadFileBase64(
  urlPrivate: string,
): Promise<{ base64: string; mediaType: string }> {
  const res = await fetch(urlPrivate, { headers: { Authorization: `Bearer ${token()}` }, cache: "no-store" });
  if (!res.ok) throw new SlackError(`Slack file download returned ${res.status} ${res.statusText}`, res.status);
  const mediaType = res.headers.get("content-type") ?? "";
  if (!mediaType.startsWith("image/")) {
    throw new SlackError(`Expected an image but got "${mediaType}" — is the files:read scope granted?`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mediaType };
}
```
Export `RawFile` from `slackFiles.ts` and use it in `HistoryResponse` to avoid duplication.

- [ ] **Step 5: Verify** `npm test` (138+ pass), `npm run lint`, `npx tsc --noEmit` all clean.

- [ ] **Step 6: Commit**
```bash
git add lib/policySchedule.ts lib/slack.ts lib/slackFiles.ts lib/slack.test.ts
git commit -m "Expose Slack message files + add downloadFileBase64 (files:read)"
```

---

## Task 2: Vision prompt + tool schema

**Files:** Rewrite `lib/flightExtractPrompt.ts`; update `lib/flightExtractPrompt.test.ts`.

- [ ] **Step 1: Update the test** `lib/flightExtractPrompt.test.ts` to:
```ts
import { describe, expect, it } from "vitest";
import { AIRBORNE_TOOL, buildVisionPrompt } from "./flightExtractPrompt";

describe("AIRBORNE_TOOL", () => {
  it("requires flew, airborneSeconds and flights", () => {
    expect(AIRBORNE_TOOL.name).toBe("report_airborne");
    const schema = AIRBORNE_TOOL.input_schema as { required: string[] };
    expect(schema.required).toEqual(
      expect.arrayContaining(["flew", "airborneSeconds", "flights"]),
    );
  });
});

describe("buildVisionPrompt", () => {
  it("names the airborne field and the no-fly case", () => {
    const p = buildVisionPrompt();
    expect(p).toContain("Час в повітрі");
    expect(p).toContain("report_airborne");
    expect(p).toMatch(/Ні|did not fly|no flight/i);
  });
});
```
Run → FAIL.

- [ ] **Step 2: Rewrite** `lib/flightExtractPrompt.ts`:
```ts
/**
 * Pure prompt + tool schema for reading the stats-bot daily flight-summary image
 * (Час в повітрі). Kept server-only-free so it unit-tests without the guard.
 */
import type Anthropic from "@anthropic-ai/sdk";

/** The model's structured read of one daily summary image. */
export interface AirborneExtract {
  /** Whether the day had any flight ("Сьогодні літали" = Так). */
  flew: boolean;
  /** "Час в повітрі" in seconds (0 when they did not fly). */
  airborneSeconds: number;
  /** "Кількість польотів". */
  flights: number;
}

export const AIRBORNE_TOOL: Anthropic.Tool = {
  name: "report_airborne",
  description: "Return the airborne time and flight count read from the flight-summary image.",
  input_schema: {
    type: "object",
    properties: {
      flew: { type: "boolean", description: "Сьогодні літали = Так → true, Ні → false" },
      airborneSeconds: { type: "number", description: "Час в повітрі (сек); 0 if they did not fly" },
      flights: { type: "number", description: "Кількість польотів" },
    },
    required: ["flew", "airborneSeconds", "flights"],
  },
};

/** Instruction paired with the image content block. */
export function buildVisionPrompt(): string {
  return [
    `This image is a Ukrainian drone flight-summary card with label/value rows.`,
    `Read these values and call report_airborne:`,
    `- "Сьогодні літали" → flew (Так = true, Ні = false)`,
    `- "Час в повітрі (сек)" → airborneSeconds (an integer number of seconds; 0 if they did not fly)`,
    `- "Кількість польотів" → flights`,
    `Return only the tool call.`,
  ].join("\n");
}
```
Run → PASS. (The old `ExtractedDay`/`FLIGHT_HOURS_TOOL`/`buildExtractionPrompt` are removed; Tasks 3–4 update consumers.)

- [ ] **Step 3: Commit**
```bash
git add lib/flightExtractPrompt.ts lib/flightExtractPrompt.test.ts
git commit -m "Rework field-qa prompt to vision airborne-time extraction"
```

---

## Task 3: Vision extraction call

**Files:** Rewrite `lib/flightExtract.ts`.

- [ ] **Step 1: Rewrite** `lib/flightExtract.ts`:
```ts
/**
 * Read airborne time from a stats-bot flight-summary image via Claude vision.
 * SERVER-ONLY (reads ANTHROPIC_API_KEY). One Messages call per image, forced
 * tool-use for structured output.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { AIRBORNE_TOOL, buildVisionPrompt, type AirborneExtract } from "./flightExtractPrompt";

const MODEL = "claude-sonnet-4-6";

export class FlightExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlightExtractError";
  }
}

/** Extract airborne time + flight count from one summary image (base64). */
export async function extractAirborne(
  imageBase64: string,
  mediaType: string,
): Promise<AirborneExtract> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new FlightExtractError("ANTHROPIC_API_KEY is not set on the server (needed for field-qa extraction).");
  }
  const client = new Anthropic();
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      tools: [AIRBORNE_TOOL],
      tool_choice: { type: "tool", name: AIRBORNE_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildVisionPrompt() },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                data: imageBase64,
              },
            },
          ],
        },
      ],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FlightExtractError(`Claude request failed: ${detail}`);
  }
  if (message.stop_reason === "refusal") throw new FlightExtractError("Claude declined the extraction.");
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new FlightExtractError("Claude returned no tool_use block.");
  const input = toolUse.input as Partial<AirborneExtract>;
  return {
    flew: Boolean(input.flew),
    airborneSeconds: Number(input.airborneSeconds ?? 0),
    flights: Number(input.flights ?? 0),
  };
}
```

- [ ] **Step 2: Verify** `npx tsc --noEmit && npm run lint` clean. (If the image `media_type` union complains, keep the cast as written.)

- [ ] **Step 3: Commit**
```bash
git add lib/flightExtract.ts
git commit -m "Rework field-qa extractor to Claude vision (airborne time)"
```

---

## Task 4: Shaping for airborne days

**Files:** Modify `scripts/fieldQaReport.ts`; update `scripts/fieldQaReport.test.ts`.

- [ ] **Step 1: Update the test** — replace the `ExtractedDay` factory + `validateDays`/`toInputsCsv`/`buildReport`/`formatTable` cases so days carry `airborneSeconds`/`flights`:
```ts
import type { ExtractedDay } from "./fieldQaReport";
// ...
function day(date: string, airborneSeconds: number, extra: Partial<ExtractedDay> = {}): ExtractedDay {
  return { date, airborneSeconds, flights: 1, sourceTs: "1.0", ...extra };
}

describe("validateDays", () => {
  it("drops zero/negative airborne, dedupes by date, sorts ascending", () => {
    const r = validateDays([
      day("2026-06-02", 1200),
      day("2026-06-01", 1110, { sourceTs: "100.1" }),
      day("2026-06-03", 0),
      day("bad", 600),
    ]);
    expect(r.map((d) => d.date)).toEqual(["2026-06-01", "2026-06-02"]);
  });
});

describe("toInputsCsv", () => {
  it("emits date,flight_hours from airborne seconds", () => {
    const csv = toInputsCsv(validateDays([day("2026-06-18", 1110)])); // 1110/3600 = 0.31
    expect(csv).toBe("date,flight_hours\n2026-06-18,0.31\n");
  });
});

describe("buildReport", () => {
  it("reports airborne minutes + permalink and totals", () => {
    const days = validateDays([day("2026-06-18", 1110, { sourceTs: "100.1" })]);
    const report = buildReport(days, { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" },
      new Map([["100.1", "https://orientsai.slack.com/p1"]]));
    expect(report.days[0].airborneMinutes).toBe(18.5);
    expect(report.days[0].permalink).toBe("https://orientsai.slack.com/p1");
    expect(report.totals.days).toBe(1);
  });
});
```
(Keep the existing `parseArgs`/`resolvePeriod` tests unchanged.) Run → FAIL.

- [ ] **Step 2: Update `scripts/fieldQaReport.ts`** — replace the `import type { ExtractedDay … } from "../lib/flightExtractPrompt"` with a locally-defined type and reshape:
```ts
export interface ExtractedDay {
  date: string;
  airborneSeconds: number;
  flights: number;
  sourceTs: string;
}

export interface ReportDay {
  date: string;
  flightHours: number;
  airborneMinutes: number;
  flights: number;
  permalink: string;
}
// FieldQaReport.days: ReportDay[]; totals { days, flightHours }
```
- `validateDays`: drop `!DATE_RE.test(date) || !Number.isFinite(airborneSeconds) || airborneSeconds <= 0`; dedupe by date (keep first / smallest sourceTs); sort ascending. Keep raw `airborneSeconds`.
- `round2` helper stays.
- `toInputsCsv(days)`: `flight_hours = round2(airborneSeconds/3600)` per row.
- `buildReport`: per day `{ date, flightHours: round2(sec/3600), airborneMinutes: round2(sec/60), flights, permalink }`; totals `{ days: n, flightHours: round2(sum) }`.
- `formatTable`: columns `Date | Airborne(min) | Flights`; TOTAL line with flightHours.

Run → PASS. Then `npm test && npm run lint` clean.

- [ ] **Step 3: Commit**
```bash
git add scripts/fieldQaReport.ts scripts/fieldQaReport.test.ts
git commit -m "Reshape field-qa report around airborne seconds"
```

---

## Task 5: CLI orchestration (bot message → image → extract)

**Files:** Rewrite `scripts/fieldQa.ts`.

- [ ] **Step 1: Rewrite** `scripts/fieldQa.ts` — keep the env/period/path scaffolding; change the middle to find stats-bot summary messages, download each image, and extract:
```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { downloadFileBase64, fetchMessages } from "../lib/slack";
import { extractAirborne } from "../lib/flightExtract";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { defaultBaseDir, periodKey, writeReport } from "../lib/reports";
import {
  buildReport, formatTable, parseArgs, resolvePeriod, toInputsCsv, validateDays,
  type ExtractedDay, type Period,
} from "./fieldQaReport";

const FIELD_QA_CHANNEL = "field-qa";
const SUMMARY_PREFIX = "Статистика польотів за ";
const TITLE_DATE = /Статистика польотів за (\d{4}-\d{2}-\d{2})/;

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function inputsPath(period: Period): string {
  return join(defaultBaseDir(), "field-ops", "inputs", `${periodKey(period)}.csv`);
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }
  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayInFieldTz());

  const messages = await fetchMessages({ start: period.start, end: period.end });
  const summaries = messages.filter(
    (m) => m.channel === FIELD_QA_CHANNEL && m.text.startsWith(SUMMARY_PREFIX) &&
      (m.files?.some((f) => f.mimetype.startsWith("image/")) ?? false),
  );

  const days: ExtractedDay[] = [];
  for (const m of summaries) {
    const date = TITLE_DATE.exec(m.text)?.[1];
    const image = m.files?.find((f) => f.mimetype.startsWith("image/"));
    if (!date || !image) continue;
    const { base64, mediaType } = await downloadFileBase64(image.urlPrivate);
    const a = await extractAirborne(base64, mediaType);
    if (!a.flew || a.airborneSeconds <= 0) continue;
    days.push({ date, airborneSeconds: a.airborneSeconds, flights: a.flights, sourceTs: m.ts });
  }

  const valid = validateDays(days);
  const permalinkByTs = new Map(summaries.map((m) => [m.ts, m.permalink]));
  const report = buildReport(valid, period, permalinkByTs);

  if (args.format === "table") console.log(formatTable(report));
  else console.log(JSON.stringify(report, null, 2));

  if (args.write) {
    const csv = toInputsCsv(valid);
    const inputs = inputsPath(period);
    mkdirSync(dirname(inputs), { recursive: true });
    writeFileSync(inputs, csv);
    const { jsonPath } = writeReport("field-qa", period, { json: JSON.stringify(report, null, 2), csv });
    process.stderr.write(`field-qa: wrote ${inputs} + ${jsonPath} (${report.totals.days} days, ${report.totals.flightHours} h)\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-qa: ${message}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Verify error path (no network)** `npm run field-qa -- --start BAD --end 2026-06-18; echo $?` → `field-qa: Period bounds must be YYYY-MM-DD…`, exit 1.

- [ ] **Step 3: Verify live** `npm run field-qa -- --start 2026-06-01 --end 2026-06-18 --format table` → rows with airborne minutes (06-18 ≈ 18.5, 06-13 ≈ 20.3) and flight counts. Then `--write`; confirm `reports/field-ops/inputs/2026-06.csv` has `date,flight_hours` with values ≈ sec/3600 (e.g. `2026-06-18,0.31`). Then `npm run fieldops -- --start 2026-06-01 --end 2026-06-18 --format table` reconciles. Paste the table + CSV for review.

- [ ] **Step 4: Commit** (include regenerated artifacts)
```bash
git add scripts/fieldQa.ts reports/field-ops/inputs/ reports/field-qa/
git commit -m "Rewrite field-qa CLI to read airborne time from the bot image"
```

---

## Task 6: Web tab, skill, env docs

**Files:** Modify `app/(dashboard)/field-qa/page.tsx`, `.claude/skills/field-qa-flight-hours/SKILL.md`, `.env.example`.

- [ ] **Step 1: Web columns** — in the page's `ReportDay` interface and table, replace `windows`/`crew` with `airborneMinutes` and `flights`; header `Date | Hours | Airborne (min) | Flights | Source`; cells read `d.flightHours`, `d.airborneMinutes`, `d.flights`, `d.permalink`. Update the intro copy: "Flight time = stats-bot airborne time (`Час в повітрі`) read from the daily summary image."

- [ ] **Step 2: Skill** — update `How it works` to: reads the stats-bot `Статистика польотів за <date>` summary image; needs `files:read`; flight time = `Час в повітрі`. Remove the `Звіт`-window description.

- [ ] **Step 3: `.env.example`** — in the Slack block, change the scope line to `channels:history + groups:history + users:read + files:read` and note files:read is needed to download the stats-bot summary image.

- [ ] **Step 4: Verify** `npm run build` succeeds; `/field-qa` present. `npm run lint` clean.

- [ ] **Step 5: Commit**
```bash
git add "app/(dashboard)/field-qa/page.tsx" .claude/skills/field-qa-flight-hours/SKILL.md .env.example
git commit -m "Update Field QA web/skill/env for bot-image airborne source"
```

---

## Final verification
- [ ] `npm test` green; `npm run lint` clean; `npx tsc --noEmit` clean; `npm run build` ok.
- [ ] Live: `npm run field-qa -- … --write` then `npm run fieldops -- … --format table` reflects bot-airborne flight time.
- [ ] No `"use client"` file imports `node:fs`/`lib/slack`/`lib/flightExtract`.
- [ ] `git status` clean.
