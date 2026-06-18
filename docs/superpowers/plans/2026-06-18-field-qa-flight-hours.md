# Field-QA Flight-Hours Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract per-day flight hours from #field-qa Slack reports with Claude and write the committed input CSV the existing field-ops reconciliation already consumes, plus a provenance artifact, a committed-only API route + lean web audit tab, and a skill.

**Architecture:** Mirrors the house reporting pattern. A pure prompt/schema module (`lib/flightExtractPrompt.ts`) and a server-only Claude caller (`lib/flightExtract.ts`) — same split as `lib/occupationPrompt.ts` + `lib/summarize.ts`. A pure shaping module (`scripts/fieldQaReport.ts`) validates/sums/serializes. The CLI (`scripts/fieldQa.ts`) fetches #field-qa via the existing `lib/slack.ts`, extracts, prints, and on `--write` writes `reports/field-ops/inputs/<period>.csv` + `reports/field-qa/<period>.{json,csv}`. The web tab renders the committed JSON only (no live LLM call). Claude Code (skill + CLI) is the primary interface.

**Tech Stack:** TypeScript (strict), Node 22, `@anthropic-ai/sdk` (`claude-sonnet-4-6`, forced tool-use), the existing `lib/slack.ts`/`lib/reports.ts`, Next.js App Router, Vitest. CLI runs under `node --conditions=react-server --import tsx`.

---

## File Structure

- `lib/flightExtractPrompt.ts` (create) — **pure**: `ExtractedDay`/`FlightWindow` types, the `FLIGHT_HOURS_TOOL` JSON schema, and `buildExtractionPrompt(messages)`. No `server-only`; type-only SDK import. Unit-tested.
- `lib/flightExtractPrompt.test.ts` (create) — Vitest for the prompt + schema.
- `lib/flightExtract.ts` (create) — **server-only**: `extractFlightDays(messages)` calls Claude via the SDK with forced tool-use; `FlightExtractError`. Network-bound, not unit-tested.
- `scripts/fieldQaReport.ts` (create) — **pure**: `parseArgs`, `resolvePeriod`, `validateDays`, `toInputsCsv`, `buildReport`, `formatTable`, `Period`/`FieldQaReport` types. Unit-tested.
- `scripts/fieldQaReport.test.ts` (create) — Vitest for the shaping.
- `scripts/fieldQa.ts` (create) — CLI orchestration.
- `package.json` (modify) — add the `field-qa` npm script.
- `app/api/field-qa/route.ts` (create) — committed-only GET (periods list / period read).
- `app/(dashboard)/field-qa/page.tsx` (create) — lean read-only audit page.
- `app/(dashboard)/layout.tsx` (modify) — add the Field QA nav tab.
- `.claude/skills/field-qa-flight-hours/SKILL.md` (create) — feature skill.
- `CLAUDE.md` (modify) — document the command.

All `scripts/` and `lib/` modules use **relative** imports (no `@/*` alias in the Vitest config); API routes and the web page use the `@/*` alias like the rest of `app/`.

---

## Task 1: Pure extraction prompt + tool schema

**Files:**
- Create: `lib/flightExtractPrompt.ts`
- Test: `lib/flightExtractPrompt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/flightExtractPrompt.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { SlackMessage } from "./policySchedule";
import { buildExtractionPrompt, FLIGHT_HOURS_TOOL } from "./flightExtractPrompt";

function msg(ts: string, text: string): SlackMessage {
  return {
    channel: "field-qa",
    authorId: "U1",
    author: "Pilot",
    ts,
    isoTime: new Date(Number(ts) * 1000).toISOString(),
    text,
    permalink: "",
  };
}

describe("FLIGHT_HOURS_TOOL", () => {
  it("forces a days array with the required per-day fields", () => {
    expect(FLIGHT_HOURS_TOOL.name).toBe("report_flight_hours");
    const schema = FLIGHT_HOURS_TOOL.input_schema as {
      properties: { days: { type: string; items: { required: string[] } } };
    };
    expect(schema.properties.days.type).toBe("array");
    expect(schema.properties.days.items.required).toEqual(
      expect.arrayContaining(["date", "flightHours", "windows", "crew", "sourceTs"]),
    );
  });
});

describe("buildExtractionPrompt", () => {
  it("includes the rules and every message with its ts", () => {
    const prompt = buildExtractionPrompt([
      msg("1781798204.640689", "Звіт 18.06.2026\nА+Д 15:20-18:30"),
      msg("1781726409.890369", "Статистика польотів за 2026-06-17"),
    ]);
    expect(prompt).toContain("Звіт");
    expect(prompt).toContain("15:20-18:30");
    expect(prompt).toContain("1781798204.640689");
    expect(prompt).toMatch(/DD\.MM\.YYYY/);
    expect(prompt).toContain("report_flight_hours");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/flightExtractPrompt.test.ts`
Expected: FAIL — `Failed to resolve import "./flightExtractPrompt"`.

- [ ] **Step 3: Implement the module**

Create `lib/flightExtractPrompt.ts`:
```ts
/**
 * Pure prompt construction + tool schema for field-qa flight-hours extraction.
 * Kept separate from lib/flightExtract.ts (server-only, hits the Anthropic API)
 * so the prompt/schema can be unit-tested without a network call or the
 * server-only guard — same split as lib/occupationPrompt.ts / lib/summarize.ts.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { SlackMessage } from "./policySchedule";

export interface FlightWindow {
  start: string; // HH:MM
  end: string; // HH:MM
}

export interface ExtractedDay {
  /** Flight date in YYYY-MM-DD (converted from the report's DD.MM.YYYY). */
  date: string;
  /** Total decimal hours, summed across all windows that day. */
  flightHours: number;
  windows: FlightWindow[];
  /** Crew code from the report (e.g. "А+Д"), or null. */
  crew: string | null;
  /** Slack ts of the source "Звіт" message. */
  sourceTs: string;
}

/** Forced-tool-use schema: Claude must return the days array via this tool. */
export const FLIGHT_HOURS_TOOL: Anthropic.Tool = {
  name: "report_flight_hours",
  description: "Return the per-day flight hours extracted from the field-qa reports.",
  input_schema: {
    type: "object",
    properties: {
      days: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: "string", description: "Flight date, YYYY-MM-DD" },
            flightHours: {
              type: "number",
              description: "Total decimal hours, summed across all windows that day",
            },
            windows: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  start: { type: "string", description: "HH:MM" },
                  end: { type: "string", description: "HH:MM" },
                },
                required: ["start", "end"],
              },
            },
            crew: { type: ["string", "null"], description: "Crew code e.g. А+Д, or null" },
            sourceTs: { type: "string", description: "Slack ts of the source Звіт message" },
          },
          required: ["date", "flightHours", "windows", "crew", "sourceTs"],
        },
      },
    },
    required: ["days"],
  },
};

/**
 * Build the extraction prompt from the candidate #field-qa messages. The model
 * is told to consider only "Звіт <date>" daily reports and to call the tool.
 */
export function buildExtractionPrompt(messages: SlackMessage[]): string {
  const list = messages.map((m) => `[ts=${m.ts}] ${m.text}`).join("\n---\n");
  return [
    `You extract drone field flight hours from #field-qa Slack reports (Ukrainian free-text).`,
    ``,
    `Rules:`,
    `- Consider ONLY daily flight reports that begin with "Звіт <DD.MM.YYYY>". Ignore inventory/repair notes, "Статистика польотів" posts, and chatter.`,
    `- Convert the report date DD.MM.YYYY to YYYY-MM-DD.`,
    `- A crew line looks like "А+Д 15:20-18:30" — a crew code followed by one or more HH:MM-HH:MM flight windows. Sum the duration of every window in the report to decimal hours (15:20-18:30 = 3.17).`,
    `- If a window's end time is earlier than its start, it crossed midnight: add 24h to the end before subtracting.`,
    `- Round flightHours to 2 decimals.`,
    `- Emit exactly one entry per distinct report date; if multiple reports share a date, sum their hours. Set sourceTs to the ts of a source message for that date and crew to the crew code (or null).`,
    `- If there are no flight reports, return an empty days array.`,
    ``,
    `Call the report_flight_hours tool with the result.`,
    ``,
    `Messages:`,
    list,
  ].join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/flightExtractPrompt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/flightExtractPrompt.ts lib/flightExtractPrompt.test.ts
git commit -m "Add pure field-qa extraction prompt + tool schema"
```

---

## Task 2: Pure CLI shaping

**Files:**
- Create: `scripts/fieldQaReport.ts`
- Test: `scripts/fieldQaReport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/fieldQaReport.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { ExtractedDay } from "../lib/flightExtractPrompt";
import {
  buildReport,
  formatTable,
  parseArgs,
  resolvePeriod,
  toInputsCsv,
  validateDays,
} from "./fieldQaReport";

function day(date: string, flightHours: number, extra: Partial<ExtractedDay> = {}): ExtractedDay {
  return { date, flightHours, windows: [], crew: null, sourceTs: "1.0", ...extra };
}

describe("parseArgs", () => {
  it("reads bounds, format and --write", () => {
    expect(
      parseArgs(["--start", "2026-06-01", "--end", "2026-06-18", "--format", "table", "--write"]),
    ).toEqual({ start: "2026-06-01", end: "2026-06-18", format: "table", write: true });
  });
  it("defaults format json and write false", () => {
    expect(parseArgs([])).toEqual({ start: undefined, end: undefined, format: "json", write: false });
  });
});

describe("resolvePeriod", () => {
  it("uses explicit bounds when both present", () => {
    expect(
      resolvePeriod({ format: "json", write: false, start: "2026-06-01", end: "2026-06-18" }, "2026-06-18"),
    ).toEqual({ start: "2026-06-01", end: "2026-06-18", timezone: "Europe/Kyiv" });
  });
  it("falls back to the current month when a bound is missing", () => {
    expect(
      resolvePeriod({ format: "json", write: false, start: "2026-06-01" }, "2026-06-18"),
    ).toEqual({ start: "2026-06-01", end: "2026-06-18", timezone: "Europe/Kyiv" });
  });
  it("throws on a malformed date", () => {
    expect(() =>
      resolvePeriod({ format: "json", write: false, start: "06/01", end: "2026-06-18" }, "2026-06-18"),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("validateDays", () => {
  it("drops invalid rows, sums duplicate dates, sorts ascending", () => {
    const result = validateDays([
      day("2026-06-02", 2),
      day("2026-06-01", 1.5, { windows: [{ start: "10:00", end: "11:30" }], crew: "А+Д", sourceTs: "100.1" }),
      day("2026-06-01", 0.5, { windows: [{ start: "14:00", end: "14:30" }], sourceTs: "100.9" }),
      day("bad-date", 3),
      day("2026-06-03", 0),
      day("2026-06-04", Number.NaN),
    ]);
    expect(result.map((d) => d.date)).toEqual(["2026-06-01", "2026-06-02"]);
    const first = result[0];
    expect(first.flightHours).toBe(2); // 1.5 + 0.5
    expect(first.windows).toHaveLength(2); // merged
    expect(first.crew).toBe("А+Д");
    expect(first.sourceTs).toBe("100.1");
  });
});

describe("toInputsCsv", () => {
  it("emits the fieldops date,flight_hours contract", () => {
    const csv = toInputsCsv(validateDays([day("2026-06-01", 3.17), day("2026-06-02", 4)]));
    expect(csv).toBe("date,flight_hours\n2026-06-01,3.17\n2026-06-02,4\n");
  });
});

describe("buildReport", () => {
  it("attaches permalinks by sourceTs and totals the hours", () => {
    const days = validateDays([day("2026-06-01", 3, { sourceTs: "100.1" })]);
    const report = buildReport(
      days,
      { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" },
      new Map([["100.1", "https://orientsai.slack.com/archives/C/p1001"]]),
    );
    expect(report.sourceChannel).toBe("field-qa");
    expect(report.days[0].permalink).toBe("https://orientsai.slack.com/archives/C/p1001");
    expect(report.totals).toEqual({ days: 1, flightHours: 3 });
  });
});

describe("formatTable", () => {
  it("renders rows and a total line", () => {
    const days = validateDays([day("2026-06-01", 3), day("2026-06-02", 4)]);
    const table = formatTable(
      buildReport(days, { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" }, new Map()),
    );
    expect(table).toContain("2026-06-01");
    expect(table).toMatch(/TOTAL/i);
    expect(table).toContain("7");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/fieldQaReport.test.ts`
Expected: FAIL — `Failed to resolve import "./fieldQaReport"`.

- [ ] **Step 3: Implement the module**

Create `scripts/fieldQaReport.ts`:
```ts
import { FIELD_TIMEZONE } from "../lib/reconcile";
import type { ExtractedDay, FlightWindow } from "../lib/flightExtractPrompt";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OutputFormat = "json" | "table";

export interface ParsedArgs {
  start?: string;
  end?: string;
  format: OutputFormat;
  write: boolean;
}

export interface Period {
  start: string;
  end: string;
  timezone: string;
}

export interface ReportDay {
  date: string;
  flightHours: number;
  windows: FlightWindow[];
  crew: string | null;
  permalink: string;
}

export interface FieldQaReport {
  period: Period;
  sourceChannel: string;
  days: ReportDay[];
  totals: { days: number; flightHours: number };
}

/** Round to two decimals (hours are derived from minute math). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Parse `--start`, `--end`, `--format`, `--write`. Unknown flags ignored. */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { start: undefined, end: undefined, format: "json", write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") { args.start = value; i += 1; }
    else if (flag === "--end") { args.end = value; i += 1; }
    else if (flag === "--format") { args.format = value === "table" ? "table" : "json"; i += 1; }
    else if (flag === "--write") { args.write = true; }
  }
  return args;
}

/** First of `today`'s month through `today` (both YYYY-MM-DD). */
function defaultMonthWindow(today: string): { start: string; end: string } {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

/**
 * Resolve the window: explicit `--start`/`--end` only when BOTH present;
 * otherwise the full current month. Throws on a malformed explicit bound.
 */
export function resolvePeriod(args: ParsedArgs, today: string): Period {
  let start = args.start;
  let end = args.end;
  if (!start || !end) {
    ({ start, end } = defaultMonthWindow(today));
  }
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }
  return { start, end, timezone: FIELD_TIMEZONE };
}

/**
 * Validate LLM-extracted days: drop rows with a non-YYYY-MM-DD date or a
 * non-finite/non-positive flightHours, sum duplicate dates (merging windows,
 * keeping the first non-null crew and the lexicographically smallest sourceTs
 * for determinism), and sort ascending by date.
 */
export function validateDays(days: ExtractedDay[]): ExtractedDay[] {
  const byDate = new Map<string, ExtractedDay>();
  for (const d of days) {
    if (!DATE_RE.test(d.date) || !Number.isFinite(d.flightHours) || d.flightHours <= 0) continue;
    const existing = byDate.get(d.date);
    if (!existing) {
      byDate.set(d.date, {
        date: d.date,
        flightHours: d.flightHours,
        windows: [...(d.windows ?? [])],
        crew: d.crew ?? null,
        sourceTs: d.sourceTs,
      });
    } else {
      existing.flightHours += d.flightHours;
      existing.windows.push(...(d.windows ?? []));
      existing.crew = existing.crew ?? d.crew ?? null;
      if (d.sourceTs < existing.sourceTs) existing.sourceTs = d.sourceTs;
    }
  }
  return [...byDate.values()]
    .map((d) => ({ ...d, flightHours: round2(d.flightHours) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The fieldops input contract: `date,flight_hours` header + one row per day. */
export function toInputsCsv(days: ExtractedDay[]): string {
  const lines = ["date,flight_hours"];
  for (const d of days) lines.push(`${d.date},${d.flightHours}`);
  return `${lines.join("\n")}\n`;
}

/** Build the lossless report artifact, attaching a Slack permalink per day. */
export function buildReport(
  days: ExtractedDay[],
  period: Period,
  permalinkByTs: Map<string, string>,
): FieldQaReport {
  const reportDays: ReportDay[] = days.map((d) => ({
    date: d.date,
    flightHours: d.flightHours,
    windows: d.windows,
    crew: d.crew,
    permalink: permalinkByTs.get(d.sourceTs) ?? "",
  }));
  const flightHours = round2(reportDays.reduce((sum, d) => sum + d.flightHours, 0));
  return {
    period,
    sourceChannel: "field-qa",
    days: reportDays,
    totals: { days: reportDays.length, flightHours },
  };
}

/** Render the report as a compact human-readable table. */
export function formatTable(report: FieldQaReport): string {
  const { period, totals, days } = report;
  const lines: string[] = [];
  lines.push(`Field-QA flight hours: ${period.start} … ${period.end} (${period.timezone})`);
  lines.push("");
  lines.push("Date         Hours   Crew");
  lines.push("-----------  -----   ----");
  for (const d of days) {
    lines.push(`${d.date}   ${String(d.flightHours).padStart(5)}   ${d.crew ?? ""}`);
  }
  lines.push("-----------  -----   ----");
  lines.push(`TOTAL        ${String(totals.flightHours).padStart(5)}   (${totals.days} days)`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/fieldQaReport.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the full suite + lint**

Run: `npm test && npm run lint`
Expected: all green, lint clean.

- [ ] **Step 6: Commit**

```bash
git add scripts/fieldQaReport.ts scripts/fieldQaReport.test.ts
git commit -m "Add pure field-qa report shaping with vitest coverage"
```

---

## Task 3: Server-only Claude extractor

**Files:**
- Create: `lib/flightExtract.ts`

- [ ] **Step 1: Implement the module**

Create `lib/flightExtract.ts`:
```ts
/**
 * Field-qa flight-hours extraction via Claude. SERVER-ONLY.
 *
 * Reads ANTHROPIC_API_KEY from process.env and never exposes it to the browser
 * — same discipline as lib/summarize.ts. The `server-only` import makes an
 * accidental client import a build error. One Messages API call per period with
 * forced tool-use for structured output.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SlackMessage } from "./policySchedule";
import { buildExtractionPrompt, FLIGHT_HOURS_TOOL, type ExtractedDay } from "./flightExtractPrompt";

const MODEL = "claude-sonnet-4-6";

export class FlightExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlightExtractError";
  }
}

/**
 * Extract per-day flight hours from the given #field-qa messages. Returns the
 * raw model output (unvalidated — callers run validateDays). An empty input
 * short-circuits without a network call.
 */
export async function extractFlightDays(messages: SlackMessage[]): Promise<ExtractedDay[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new FlightExtractError(
      "ANTHROPIC_API_KEY is not set on the server (needed for field-qa extraction).",
    );
  }
  if (messages.length === 0) return [];

  const client = new Anthropic();
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: [FLIGHT_HOURS_TOOL],
      tool_choice: { type: "tool", name: FLIGHT_HOURS_TOOL.name },
      messages: [{ role: "user", content: buildExtractionPrompt(messages) }],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FlightExtractError(`Claude request failed: ${detail}`);
  }

  if (message.stop_reason === "refusal") {
    throw new FlightExtractError("Claude declined the extraction request.");
  }

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    throw new FlightExtractError("Claude returned no tool_use block.");
  }

  const input = toolUse.input as { days?: ExtractedDay[] };
  return input.days ?? [];
}
```

- [ ] **Step 2: Typecheck + lint (no unit test — network-bound, per convention)**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean. (If `tsc` flags the `tool_choice`/`Tool` types, fix the typing without changing behavior and note it.)

- [ ] **Step 3: Commit**

```bash
git add lib/flightExtract.ts
git commit -m "Add server-only field-qa Claude extractor"
```

---

## Task 4: CLI runner

**Files:**
- Create: `scripts/fieldQa.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement the CLI**

Create `scripts/fieldQa.ts`:
```ts
/**
 * CLI: extract #field-qa flight hours for a window and (optionally) persist them.
 *
 * Usage: npm run field-qa -- --start 2026-06-01 --end 2026-06-18 [--format table]
 *        npm run field-qa -- --start 2026-06-01 --end 2026-06-18 --write
 * Defaults to the current Europe/Kyiv month when bounds are omitted.
 *
 * `--write` writes the reconciliation input reports/field-ops/inputs/<period>.csv
 * (the contract scripts/fieldops.ts reads) AND the provenance artifact
 * reports/field-qa/<period>.{json,csv}. Flight hours are extracted by Claude
 * (non-deterministic) — review the committed diff before running fieldops.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so the
 * `server-only` imports in ../lib/slack and ../lib/flightExtract resolve.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchMessages } from "../lib/slack";
import { extractFlightDays } from "../lib/flightExtract";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { defaultBaseDir, periodKey, writeReport } from "../lib/reports";
import {
  buildReport,
  formatTable,
  parseArgs,
  resolvePeriod,
  toInputsCsv,
  validateDays,
  type Period,
} from "./fieldQaReport";

const FIELD_QA_CHANNEL = "field-qa";

/** Today's date (YYYY-MM-DD) in the field timezone. */
function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Reconciliation input path for a period (matches scripts/fieldops.ts). */
function inputsPath(period: Period): string {
  return join(defaultBaseDir(), "field-ops", "inputs", `${periodKey(period)}.csv`);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayInFieldTz());

  const messages = await fetchMessages({ start: period.start, end: period.end });
  const fieldQa = messages.filter((m) => m.channel === FIELD_QA_CHANNEL);

  const days = validateDays(await extractFlightDays(fieldQa));
  const permalinkByTs = new Map(fieldQa.map((m) => [m.ts, m.permalink]));
  const report = buildReport(days, period, permalinkByTs);

  if (args.format === "table") {
    console.log(formatTable(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  if (args.write) {
    const csv = toInputsCsv(days);
    const inputs = inputsPath(period);
    mkdirSync(dirname(inputs), { recursive: true });
    writeFileSync(inputs, csv);
    const { jsonPath } = writeReport("field-qa", period, {
      json: JSON.stringify(report, null, 2),
      csv,
    });
    process.stderr.write(
      `field-qa: wrote ${inputs} + ${jsonPath} (${report.totals.days} days, ${report.totals.flightHours} h)\n`,
    );
  }
}

main().catch((error: unknown) => {
  // Both SlackError and FlightExtractError extend Error, so a uniform message
  // is enough; no need to import or branch on the specific types.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-qa: ${message}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`, add (keep the others; place after `"fieldops"`):
```json
"field-qa": "node --conditions=react-server --import tsx scripts/fieldQa.ts",
```

- [ ] **Step 3: Verify the deterministic error path (no network/LLM)**

Run: `npm run field-qa -- --start BAD --end 2026-06-18`
Expected: stderr `field-qa: Period bounds must be YYYY-MM-DD: start=BAD end=2026-06-18`, exit code 1 (`echo $?` → 1).

- [ ] **Step 4: Verify a live extraction (tokens are configured in .env)**

Run: `npm run field-qa -- --start 2026-06-01 --end 2026-06-18 --format table`
Expected: a table of flight days, e.g. `2026-06-18  3.17  А+Д` and a `TOTAL` line. Then:
Run: `npm run field-qa -- --start 2026-06-01 --end 2026-06-18 --write`
Expected: stderr `field-qa: wrote …/reports/field-ops/inputs/2026-06.csv + …/reports/field-qa/2026-06.json (N days, H h)`; both files exist; `reports/field-ops/inputs/2026-06.csv` starts with `date,flight_hours`.
(If a token were missing, the CLI would exit 1 with a clear `SLACK_TOKEN`/`ANTHROPIC_API_KEY` message — that is the proof the wiring is sound; do not fake data.)

- [ ] **Step 5: Confirm the artifact feeds reconciliation**

Run: `npm run fieldops -- --start 2026-06-01 --end 2026-06-18 --format table`
Expected: the daily reconciliation now shows non-zero `flightMinutes` on the days the extractor populated (no "no flight-hours file" warning).

- [ ] **Step 6: Commit**

```bash
git add scripts/fieldQa.ts package.json
git commit -m "Add field-qa CLI: extract Slack flight hours, write fieldops input"
```

---

## Task 5: Committed-only API route

**Files:**
- Create: `app/api/field-qa/route.ts`

- [ ] **Step 1: Implement the route**

Create `app/api/field-qa/route.ts`:
```ts
import { NextResponse } from "next/server";
import { listPeriods, parsePeriodKey, readReportJson } from "@/lib/reports";

// Reads committed artifacts only; never calls Slack/Claude (extraction is the
// CLI's job — it costs LLM tokens and must be reviewed before use).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEATURE = "field-qa";

/**
 * GET /api/field-qa
 *   ?periods=1    → { periods } committed period keys (newest first)
 *   ?period=<key> → the committed FieldQaReport JSON, or 404
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("periods")) {
    return NextResponse.json({ periods: listPeriods(FEATURE) });
  }

  const period = searchParams.get("period");
  if (period) {
    if (!parsePeriodKey(period)) {
      return NextResponse.json(
        { error: "`period` must be YYYY-MM or YYYY-MM-DD_YYYY-MM-DD." },
        { status: 400 },
      );
    }
    const report = readReportJson(FEATURE, period);
    if (!report) {
      return NextResponse.json({ error: `No committed report for ${period}.` }, { status: 404 });
    }
    return NextResponse.json(report);
  }

  return NextResponse.json(
    { error: "Provide `period` or `periods`." },
    { status: 400 },
  );
}
```

- [ ] **Step 2: Verify the route**

Start the dev server in the background: `npm run dev` (port 3003). Then:
Run: `curl -s 'http://localhost:3003/api/field-qa?periods=1'`
Expected: `{"periods":["2026-06"]}` (or whatever periods you wrote in Task 4).
Run: `curl -s 'http://localhost:3003/api/field-qa?period=2026-06' | head -c 200`
Expected: the committed JSON (`{"period":{...},"sourceChannel":"field-qa",...`).
Run: `curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:3003/api/field-qa?period=1999-01'`
Expected: `404`. Stop the dev server afterward.

- [ ] **Step 3: Commit**

```bash
git add app/api/field-qa/route.ts
git commit -m "Add committed-only /api/field-qa route"
```

---

## Task 6: Lean web audit tab

**Files:**
- Create: `app/(dashboard)/field-qa/page.tsx`
- Modify: `app/(dashboard)/layout.tsx`

- [ ] **Step 1: Add the nav tab**

In `app/(dashboard)/layout.tsx`, add to the `TABS` array (after the Field Ops entry):
```ts
  { href: "/field-qa", label: "Field QA", enabled: true },
```

- [ ] **Step 2: Implement the page**

Create `app/(dashboard)/field-qa/page.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";

interface ReportDay {
  date: string;
  flightHours: number;
  windows: { start: string; end: string }[];
  crew: string | null;
  permalink: string;
}
interface FieldQaReport {
  period: { start: string; end: string; timezone: string };
  sourceChannel: string;
  days: ReportDay[];
  totals: { days: number; flightHours: number };
}

export default function FieldQaPage() {
  const [periods, setPeriods] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<FieldQaReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/field-qa?periods=1")
      .then((r) => r.json())
      .then((b) => {
        const list: string[] = b.periods ?? [];
        setPeriods(list);
        if (list.length > 0) setSelected(list[0]);
      })
      .catch(() => setError("Failed to load committed periods."));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setError(null);
    fetch(`/api/field-qa?period=${selected}`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error ?? `Request failed (${r.status})`);
        setReport(b as FieldQaReport);
      })
      .catch((e) => {
        setReport(null);
        setError(e instanceof Error ? e.message : "Failed to load report.");
      });
  }, [selected]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          Field QA — Flight Hours
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Flight hours extracted from #field-qa by Claude (committed artifacts).
          Review here before they feed reconciliation. Generate with{" "}
          <code className="text-slate-600">npm run field-qa -- --write</code>.
        </p>
      </div>

      {periods.length > 0 && (
        <label className="flex items-center gap-2 text-sm text-slate-600">
          Period
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            {periods.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {periods.length === 0 && !error && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
          No committed reports yet. Run{" "}
          <code className="text-slate-600">npm run field-qa -- --write</code> to create one.
        </p>
      )}

      {report && (
        <section className="space-y-2">
          <div className="text-sm text-slate-500">
            {report.totals.days} days · {report.totals.flightHours} flight hours
          </div>
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="py-1">Date</th>
                <th className="py-1">Hours</th>
                <th className="py-1">Crew</th>
                <th className="py-1">Windows</th>
                <th className="py-1">Source</th>
              </tr>
            </thead>
            <tbody>
              {report.days.map((d) => (
                <tr key={d.date} className="border-t border-slate-100">
                  <td className="py-1 tabular-nums">{d.date}</td>
                  <td className="py-1 tabular-nums">{d.flightHours}</td>
                  <td className="py-1">{d.crew ?? ""}</td>
                  <td className="py-1 text-slate-500">
                    {d.windows.map((w) => `${w.start}-${w.end}`).join(", ")}
                  </td>
                  <td className="py-1">
                    {d.permalink ? (
                      <a href={d.permalink} className="text-sky-600 hover:underline" target="_blank" rel="noreferrer">
                        Slack
                      </a>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify the page builds and renders**

Run: `npm run build`
Expected: build succeeds, no type errors; `/field-qa` appears in the route list.
(Optional visual check: `npm run dev`, open http://localhost:3003/field-qa — the period selector shows `2026-06` and the table lists the extracted days with working Slack links.)

- [ ] **Step 4: Commit**

```bash
git add "app/(dashboard)/field-qa/page.tsx" "app/(dashboard)/layout.tsx"
git commit -m "Add lean Field QA web audit tab"
```

---

## Task 7: Feature skill

**Files:**
- Create: `.claude/skills/field-qa-flight-hours/SKILL.md`

- [ ] **Step 1: Create the skill**

Create `.claude/skills/field-qa-flight-hours/SKILL.md`:
```markdown
---
name: field-qa-flight-hours
description: Use when answering questions about field drone flight hours, or when asked to extract/refresh flight hours from the #field-qa Slack channel for a date range (e.g. "how many flight hours in June?", "pull May's flight hours from field-qa", "update the flight-hours input for last month"). Extracts hours from Ukrainian "Звіт" reports via Claude and writes the input the field-ops reconciliation consumes.
---

# Field-QA flight hours

Extract per-day drone flight hours from #field-qa Slack reports and feed the
field-ops reconciliation.

## Domain (must-know)

- Flight hours live in #field-qa daily reports that begin with `Звіт <DD.MM.YYYY>`
  (Ukrainian). Hours = the sum of the `HH:MM-HH:MM` window(s) on the crew line
  (e.g. `А+Д 15:20-18:30` = 3.17h). Multiple windows in a day are summed.
- Extraction is **LLM-based** (claude-sonnet-4-6), so it is non-deterministic —
  always review before the numbers feed the gate.
- The flight day is the report's stated date, not the Slack post time.

## When to use

"How many flight hours did the field team log in <month>?", "extract/refresh
flight hours for <period> from field-qa", "update the reconciliation input".

## How to use

```bash
# Inspect (no write):
npm run field-qa -- --start 2026-06-01 --end 2026-06-18            # JSON
npm run field-qa -- --start 2026-06-01 --end 2026-06-18 --format table

# Persist (writes the reconciliation input + provenance):
npm run field-qa -- --start 2026-06-01 --end 2026-06-18 --write
```

`--write` produces:
- `reports/field-ops/inputs/<period>.csv` — `date,flight_hours`, consumed by
  `npm run fieldops`.
- `reports/field-qa/<period>.json` — provenance: per-day hours, windows, crew,
  and a permalink back to the source Slack message (also shown on the Field QA
  web tab).

Workflow: `field-qa --write` → review the git diff / web tab → `npm run fieldops
-- … --write` to reconcile against Vimeo.

## Out of scope

- Do not hand-fabricate hours; if `SLACK_TOKEN` or `ANTHROPIC_API_KEY` is missing
  the CLI exits 1 with a clear message — surface that.
- The web tab is read-only and committed-only; it never triggers extraction.
- This feature only produces the flight-hours input — the 50% video gate itself
  is `scripts/fieldops.ts`.
```

- [ ] **Step 2: Verify the frontmatter**

Run: `head -4 .claude/skills/field-qa-flight-hours/SKILL.md`
Expected: valid YAML frontmatter with `name` + `description`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/field-qa-flight-hours/SKILL.md
git commit -m "Add field-qa-flight-hours skill"
```

---

## Task 8: Document the command + final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the command**

In `CLAUDE.md`, under the Commands section (after the `fieldops` line if present, otherwise after the other `npm run` report commands), add:
```markdown
- `npm run field-qa -- --start YYYY-MM-DD --end YYYY-MM-DD [--write]` — extract #field-qa flight-hours reports via Claude; `--write` persists `reports/field-ops/inputs/<period>.csv` (the fieldops input) + `reports/field-qa/<period>.{json,csv}`. `--format table` for a human view. Drives the Field QA tab and the `field-qa-flight-hours` skill.
```

- [ ] **Step 2: Commit the doc**

```bash
git add CLAUDE.md
git commit -m "Document the field-qa command in CLAUDE.md"
```

- [ ] **Step 3: Full verification**

- [ ] `npm test` — all tests pass (new prompt + shaping suites included).
- [ ] `npm run lint` — clean.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run build` — succeeds; `/field-qa` and `/api/field-qa` present.
- [ ] `npm run field-qa -- --start BAD --end 2026-06-18` — exits 1 with the YYYY-MM-DD error.
- [ ] (With tokens) `npm run field-qa -- --start 2026-06-01 --end 2026-06-18 --write` then `npm run fieldops -- --start 2026-06-01 --end 2026-06-18 --format table` — reconciliation reflects the extracted hours.
- [ ] No `"use client"` file imports `node:fs`, `lib/slack`, `lib/flightExtract`, or `lib/reports` write paths.
- [ ] `git status` clean.
```
