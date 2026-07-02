# Per-person drone counts in field-verdict messages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse *who had how many drones* out of the daily #field-qa drone-count report and add a per-person drone line (`🛸 Дрони: Андріан 2, Любомир 3, інші 9 (усього 14)`) to the field-verdict Slack message.

**Architecture:** Upgrade the existing binary drone-count classifier (`lib/droneCountReport.ts`) to return structured per-person/per-category entries. Extract them per day in the field-qa stage, persist onto the committed field-qa report, carry them through `computeVerdicts` onto each `DayVerdict`, and render a trailing `🛸`-prefixed line in `formatDayMessage`. The drone line is a third disjoint message region alongside the verdict body and the `👥 У полі:` crew suffix, so approver-override and roster-correction edits never clobber it.

**Tech Stack:** TypeScript (strict), Next.js 16 App Router, Vitest, Anthropic SDK (`claude-sonnet-4-6`), Postgres-backed reports.

## Global Constraints

- **Two interfaces (non-negotiable):** every feature ships a web view *and* a CLI/report surface; shared logic lives in pure `lib/` modules.
- **Server-only discipline:** modules touching Slack/Vimeo/Claude/env import `"server-only"`; CLIs run Node with `--conditions=react-server`. Never import a `server-only` module from a `"use client"` file.
- **Pure libs stay pure:** `lib/droneReport.ts`, `lib/fieldDayVerdict.ts`, `lib/verdictPublish.ts`, `scripts/*Report.ts` have no React/Next/`node:*`/`server-only` imports and are unit-tested.
- **Ukrainian for team-facing text:** the drone line is posted to the channel, so it is Ukrainian (`🛸 Дрони:`, `інші`, `усього`). Internal `reasons` stay English.
- **Classifier model:** `claude-sonnet-4-6` (unchanged).
- **Bonus gate unchanged:** `computeBonuses` reads `classifyDroneCount(...).present`; keep `present` derived (`entries.length > 0`) so its behavior is byte-for-byte identical.
- **Testing:** `npx vitest run <file>` for one file, `npm test` for all. `vitest.config.ts` aliases `server-only` → an empty module; mock server deps with `vi.mock`/`vi.hoisted`.
- **Git:** work on branch `feat/drone-counts-in-verdict` (already created). Commit after each task.

---

### Task 1: Pure drone-report domain helpers

**Files:**
- Create: `lib/droneReport.ts`
- Test: `lib/droneReport.test.ts`

**Interfaces:**
- Produces: `interface DroneEntry { name: string; isPerson: boolean; count: number }`; `mergeDroneEntries(entries: DroneEntry[]): DroneEntry[]`; `droneTotals(entries: DroneEntry[]): { peopleTotal: number; otherTotal: number; grandTotal: number }`; `formatDroneLine(entries: DroneEntry[]): string | null`; `formatDroneCsv(entries: DroneEntry[]): string`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/droneReport.test.ts
import { describe, it, expect } from "vitest";
import { mergeDroneEntries, droneTotals, formatDroneLine, formatDroneCsv, type DroneEntry } from "./droneReport";

const E = (name: string, isPerson: boolean, count: number): DroneEntry => ({ name, isPerson, count });

describe("mergeDroneEntries", () => {
  it("sums same name+isPerson, preserves first-seen order", () => {
    expect(mergeDroneEntries([E("Андріан", true, 1), E("15ка", false, 1), E("Андріан", true, 1)])).toEqual([
      E("Андріан", true, 2),
      E("15ка", false, 1),
    ]);
  });
  it("keeps a person and a category of the same name distinct", () => {
    expect(mergeDroneEntries([E("X", true, 1), E("X", false, 2)])).toEqual([E("X", true, 1), E("X", false, 2)]);
  });
});

describe("droneTotals", () => {
  it("splits people vs other and totals", () => {
    expect(droneTotals([E("Андріан", true, 2), E("Демонстраційні", false, 8), E("15ка", false, 1)])).toEqual({
      peopleTotal: 2,
      otherTotal: 9,
      grandTotal: 11,
    });
  });
});

describe("formatDroneLine", () => {
  it("renders people as-written + folded other + grand total", () => {
    const entries = [E("Андріан", true, 2), E("Любомир", true, 3), E("Демонстраційні", false, 8), E("15ка", false, 1)];
    expect(formatDroneLine(entries)).toBe("🛸 Дрони: Андріан 2, Любомир 3, інші 9 (усього 14)");
  });
  it("omits the other term when there are no categories", () => {
    expect(formatDroneLine([E("Андріан", true, 2)])).toBe("🛸 Дрони: Андріан 2 (усього 2)");
  });
  it("renders only the other term when there are no people", () => {
    expect(formatDroneLine([E("15ка", false, 1)])).toBe("🛸 Дрони: інші 1 (усього 1)");
  });
  it("returns null for empty / all-zero entries", () => {
    expect(formatDroneLine([])).toBeNull();
    expect(formatDroneLine([E("X", true, 0)])).toBeNull();
  });
});

describe("formatDroneCsv", () => {
  it("is CSV-friendly: semicolons, plain total, no emoji", () => {
    const entries = [E("Андріан", true, 2), E("Любомир", true, 3), E("Демонстраційні", false, 8), E("15ка", false, 1)];
    expect(formatDroneCsv(entries)).toBe("Андріан 2; Любомир 3; інші 9 (14)");
  });
  it("is empty for no entries", () => {
    expect(formatDroneCsv([])).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/droneReport.test.ts`
Expected: FAIL — `Cannot find module './droneReport'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/droneReport.ts
/** Pure domain helpers for per-person/per-category drone counts parsed from a
 *  #field-qa drone-count report. No server/Next imports; unit-tested. */

export interface DroneEntry {
  /** Name as written in the report (person or category), e.g. "Андріан", "15ка". */
  name: string;
  /** true for a person, false for a category ("Демонстраційні", "15ка", ...). */
  isPerson: boolean;
  /** Total units for this entry (multi-item lines summed). */
  count: number;
}

/** Sum entries sharing the same name+isPerson, preserving first-seen order. Pure. */
export function mergeDroneEntries(entries: DroneEntry[]): DroneEntry[] {
  const order: string[] = [];
  const byKey = new Map<string, DroneEntry>();
  for (const e of entries) {
    const key = `${e.isPerson ? "p" : "c"}:${e.name}`;
    const existing = byKey.get(key);
    if (existing) existing.count += e.count;
    else {
      byKey.set(key, { ...e });
      order.push(key);
    }
  }
  return order.map((k) => byKey.get(k)!);
}

export interface DroneTotals {
  peopleTotal: number;
  otherTotal: number;
  grandTotal: number;
}

/** People total, folded category ("other") total, and grand total. Pure. */
export function droneTotals(entries: DroneEntry[]): DroneTotals {
  let peopleTotal = 0;
  let otherTotal = 0;
  for (const e of entries) {
    if (e.isPerson) peopleTotal += e.count;
    else otherTotal += e.count;
  }
  return { peopleTotal, otherTotal, grandTotal: peopleTotal + otherTotal };
}

/** Ordered "<name> <count>" people terms + an optional folded "інші <n>" term. */
function droneTerms(merged: DroneEntry[]): string[] {
  const { otherTotal } = droneTotals(merged);
  const terms = merged.filter((e) => e.isPerson).map((e) => `${e.name} ${e.count}`);
  if (otherTotal > 0) terms.push(`інші ${otherTotal}`);
  return terms;
}

/**
 * The Ukrainian drone-count line for a verdict message, or null when there are
 * no positive entries. People listed as-written, non-person categories folded
 * into a single "інші <n>" term, grand total in parens:
 *   🛸 Дрони: Андріан 2, Любомир 3, інші 9 (усього 14)
 */
export function formatDroneLine(entries: DroneEntry[]): string | null {
  const merged = mergeDroneEntries(entries).filter((e) => e.count > 0);
  if (merged.length === 0) return null;
  return `🛸 Дрони: ${droneTerms(merged).join(", ")} (усього ${droneTotals(merged).grandTotal})`;
}

/** Same content as formatDroneLine, CSV-friendly: no emoji, "; " separators,
 *  plain "(<total>)". Empty string when there are no positive entries. */
export function formatDroneCsv(entries: DroneEntry[]): string {
  const merged = mergeDroneEntries(entries).filter((e) => e.count > 0);
  if (merged.length === 0) return "";
  return `${droneTerms(merged).join("; ")} (${droneTotals(merged).grandTotal})`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/droneReport.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/droneReport.ts lib/droneReport.test.ts
git commit -m "feat(drones): pure drone-count entry helpers (merge/totals/format)"
```

---

### Task 2: Structured drone-count classifier

**Files:**
- Modify: `lib/droneCountReportPrompt.ts` (whole file)
- Modify: `lib/droneCountReport.ts` (whole file)
- Test: `lib/droneCountReport.test.ts` (create; if a test already exists for the old binary shape, replace its assertions)

**Interfaces:**
- Consumes: `DroneEntry` (Task 1).
- Produces: `interface DroneCountResult { present: boolean; entries: DroneEntry[]; forDate: string | null; note: string }`; `classifyDroneCount(dayText: string): Promise<DroneCountResult>` (`present` derived from `entries.length > 0`). `DRONE_COUNT_TOOL`, `buildDroneCountPrompt(dayText)` still exported.

- [ ] **Step 1: Write the failing test**

```ts
// lib/droneCountReport.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { classifyDroneCount } from "./droneCountReport";

function toolUse(input: unknown) {
  return { content: [{ type: "tool_use", name: "record_drone_count_report", input }] };
}

describe("classifyDroneCount", () => {
  beforeEach(() => {
    create.mockReset();
    process.env.ANTHROPIC_API_KEY = "test";
  });

  it("returns entries and derives present", async () => {
    create.mockResolvedValue(
      toolUse({
        entries: [
          { name: "Андріан", isPerson: true, count: 2 },
          { name: "15ка", isPerson: false, count: 1 },
        ],
        note: "Андріан R&D - 1шт вартовий+ 1 шт азимут",
      }),
    );
    const r = await classifyDroneCount("Андріан R&D - 1шт вартовий+ 1 шт азимут\n15ка - 1шт");
    expect(r.present).toBe(true);
    expect(r.entries).toEqual([
      { name: "Андріан", isPerson: true, count: 2 },
      { name: "15ка", isPerson: false, count: 1 },
    ]);
    expect(r.forDate).toBeNull();
  });

  it("keeps a valid explicit forDate, rejects a malformed one", async () => {
    create.mockResolvedValue(toolUse({ entries: [{ name: "X", isPerson: true, count: 1 }], forDate: "2026-06-20", note: "" }));
    expect((await classifyDroneCount("x")).forDate).toBe("2026-06-20");
    create.mockResolvedValue(toolUse({ entries: [{ name: "X", isPerson: true, count: 1 }], forDate: "20 червня", note: "" }));
    expect((await classifyDroneCount("x")).forDate).toBeNull();
  });

  it("sanitizes bad entries (blank name, zero/negative/non-numeric count)", async () => {
    create.mockResolvedValue(
      toolUse({
        entries: [
          { name: "  ", isPerson: true, count: 3 },
          { name: "Y", isPerson: true, count: 0 },
          { name: "Z", isPerson: false, count: "2" },
          { name: "W", isPerson: true, count: -1 },
        ],
        note: "",
      }),
    );
    const r = await classifyDroneCount("x");
    expect(r.entries).toEqual([{ name: "Z", isPerson: false, count: 2 }]);
    expect(r.present).toBe(true);
  });

  it("short-circuits empty text without calling Claude", async () => {
    const r = await classifyDroneCount("   ");
    expect(create).not.toHaveBeenCalled();
    expect(r).toEqual({ present: false, entries: [], forDate: null, note: "" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/droneCountReport.test.ts`
Expected: FAIL — current `DroneCountResult` has no `entries`/`forDate`; assertions mismatch.

- [ ] **Step 3: Rewrite the prompt module**

```ts
// lib/droneCountReportPrompt.ts
/** Pure prompt + tool schema for extracting a day's #field-qa drone-count /
 *  production report into per-person / per-category entries. */
import type Anthropic from "@anthropic-ai/sdk";
import type { DroneEntry } from "./droneReport";

export interface DroneCountResult {
  /** Derived by the classifier: entries.length > 0. Kept for the bonus gate. */
  present: boolean;
  entries: DroneEntry[];
  /** YYYY-MM-DD only when the report text explicitly names a date; else null. */
  forDate: string | null;
  note: string;
}

export const DRONE_COUNT_TOOL: Anthropic.Tool = {
  name: "record_drone_count_report",
  description:
    "Extract the day's #field-qa drone-count / production tally: how many drone units each person or category had that day.",
  input_schema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        description:
          "One item per person or category named in the drone-count report. Empty when the messages contain no drone-count tally (a flight-hours 'Звіт' or general chatter is NOT a drone-count report).",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Person or category name exactly as written, e.g. 'Андріан', 'Демонстраційні', '15ка'. A qualifier like 'R&D' is a tag, not a separate entry — use the person's name.",
            },
            isPerson: {
              type: "boolean",
              description: "true for a person's name, false for a category ('Демонстраційні', 'Перевірені', '15ка', ...).",
            },
            count: {
              type: "integer",
              description: "Total drone units for this entry, summing every 'Nшт' on its line(s), e.g. '1шт вартовий + 1 шт азимут' → 2.",
            },
          },
          required: ["name", "isPerson", "count"],
        },
      },
      forDate: {
        type: "string",
        description: "YYYY-MM-DD ONLY if the report text explicitly names the date it is for; otherwise omit it.",
      },
      note: { type: "string", description: "short quote of the matched drone-count line(s), or '' if none" },
    },
    required: ["entries", "note"],
  },
};

export function buildDroneCountPrompt(dayText: string): string {
  return [
    `These are the #field-qa messages posted on one calendar day (Ukrainian).`,
    `Extract the drone-count / production tally: how many drone units each person or category had that day, e.g.`,
    `"Андріан R&D - 1шт вартовий+ 1 шт азимут" → {name:"Андріан", isPerson:true, count:2};`,
    `"Демонстраційні - 8 шт" → {name:"Демонстраційні", isPerson:false, count:8}; "15ка - 1шт" → {name:"15ка", isPerson:false, count:1}.`,
    `A flight-hours "Звіт" (roster + time window) or general chatter is NOT a drone-count report → return entries: [].`,
    `Set forDate ONLY if the text explicitly names the date it is for; otherwise omit it.`,
    `Messages:`,
    `"""${dayText}"""`,
    `Call record_drone_count_report with entries, note (and forDate only if explicit).`,
  ].join("\n");
}
```

- [ ] **Step 4: Rewrite the classifier**

```ts
// lib/droneCountReport.ts
/** Extract a day's #field-qa drone-count report into per-person / per-category
 *  entries via Claude. SERVER-ONLY. `present` is derived (entries.length > 0),
 *  so the field-bonus gate (which reads .present) is unchanged. */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { DRONE_COUNT_TOOL, buildDroneCountPrompt, type DroneCountResult } from "./droneCountReportPrompt";
import type { DroneEntry } from "./droneReport";

const MODEL = "claude-sonnet-4-6";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerce raw tool input into clean DroneEntry[]: drop blank names / bad counts. */
function sanitizeEntries(raw: unknown): DroneEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DroneEntry[] = [];
  for (const e of raw) {
    const rec = (e ?? {}) as Record<string, unknown>;
    const name = String(rec.name ?? "").trim();
    const count = Math.round(Number(rec.count));
    if (!name || !Number.isFinite(count) || count <= 0) continue;
    out.push({ name, isPerson: Boolean(rec.isPerson), count });
  }
  return out;
}

export async function classifyDroneCount(dayText: string): Promise<DroneCountResult> {
  if (!dayText.trim()) return { present: false, entries: [], forDate: null, note: "" };
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (needed for field-bonus drone-count gate).");
  const client = new Anthropic();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [DRONE_COUNT_TOOL],
    tool_choice: { type: "tool", name: DRONE_COUNT_TOOL.name },
    messages: [{ role: "user", content: [{ type: "text", text: buildDroneCountPrompt(dayText) }] }],
  });
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const input = (block?.input ?? {}) as Record<string, unknown>;
  const entries = sanitizeEntries(input.entries);
  const forDateRaw = typeof input.forDate === "string" ? input.forDate : "";
  const forDate = DATE_RE.test(forDateRaw) ? forDateRaw : null;
  return { present: entries.length > 0, entries, forDate, note: String(input.note ?? "") };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/droneCountReport.test.ts lib/droneReport.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm the bonus path still type-checks**

Run: `npx tsc --noEmit`
Expected: no errors — `computeBonuses` reads only `.present`, still present.

- [ ] **Step 7: Commit**

```bash
git add lib/droneCountReport.ts lib/droneCountReportPrompt.ts lib/droneCountReport.test.ts
git commit -m "feat(drones): structured drone-count classifier (entries + forDate, present derived)"
```

---

### Task 3: Per-day extraction orchestrator

**Files:**
- Create: `lib/extractDroneReports.ts`
- Test: `lib/extractDroneReports.test.ts`

**Interfaces:**
- Consumes: `DroneEntry`, `mergeDroneEntries` (Task 1); `classifyDroneCount` (Task 2); `videoUploadDate` from `lib/reconcile`.
- Produces: `interface DroneMessage { ts: string; text: string }`; `type DroneClassifier = (dayText: string) => Promise<{ entries: DroneEntry[]; forDate: string | null }>`; `extractDroneReports(messages: DroneMessage[], classify?: DroneClassifier): Promise<Map<string, DroneEntry[]>>` (date → merged entries).

- [ ] **Step 1: Write the failing test**

```ts
// lib/extractDroneReports.test.ts
import { describe, it, expect, vi } from "vitest";
vi.mock("./droneCountReport", () => ({ classifyDroneCount: vi.fn() }));
import { extractDroneReports, type DroneMessage } from "./extractDroneReports";
import { type DroneEntry } from "./droneReport";

const E = (name: string, isPerson: boolean, count: number): DroneEntry => ({ name, isPerson, count });
// 2026-06-25 12:00 Kyiv ≈ 09:00 UTC. Use a fixed UTC ts that maps to the Kyiv day.
const tsFor = (isoUtc: string) => String(Math.floor(new Date(isoUtc).getTime() / 1000));

describe("extractDroneReports", () => {
  it("attributes to the post date and merges same-day reports", async () => {
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-25T09:00:00Z"), text: "Андріан R&D - 1шт" },
      { ts: tsFor("2026-06-25T15:00:00Z"), text: "Андріан R&D - 1шт" },
    ];
    const classify = vi.fn(async () => ({ entries: [E("Андріан", true, 1)], forDate: null }));
    const out = await extractDroneReports(messages, classify);
    // both messages fall on the same Kyiv day → one classify call over joined text → but our
    // stub returns one entry per call; same-day grouping means ONE call here.
    expect(classify).toHaveBeenCalledTimes(1);
    expect(out.get("2026-06-25")).toEqual([E("Андріан", true, 1)]);
  });

  it("reassigns entries to an explicit forDate and merges across source days", async () => {
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-25T09:00:00Z"), text: "for 2026-06-20: Андріан 1шт" },
      { ts: tsFor("2026-06-26T09:00:00Z"), text: "for 2026-06-20: Андріан 2шт" },
    ];
    const classify = vi.fn(async (t: string) => ({
      entries: [E("Андріан", true, t.includes("2шт") ? 2 : 1)],
      forDate: "2026-06-20",
    }));
    const out = await extractDroneReports(messages, classify);
    expect(out.get("2026-06-20")).toEqual([E("Андріан", true, 3)]);
    expect(out.has("2026-06-25")).toBe(false);
  });

  it("skips days with no drone entries", async () => {
    const messages: DroneMessage[] = [{ ts: tsFor("2026-06-25T09:00:00Z"), text: "just chatter" }];
    const classify = vi.fn(async () => ({ entries: [], forDate: null }));
    const out = await extractDroneReports(messages, classify);
    expect(out.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/extractDroneReports.test.ts`
Expected: FAIL — `Cannot find module './extractDroneReports'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/extractDroneReports.ts
/** Extract per-day drone-count entries from a period's #field-qa messages.
 *  SERVER-ONLY (the default classifier calls Claude). Groups messages by Kyiv
 *  POST date (same-day, matching the bonus gate), classifies each day's joined
 *  text, and attributes the entries to the date the report names (forDate) or,
 *  absent that, the post date. Multiple reports on one target date are merged. */
import "server-only";
import { videoUploadDate } from "./reconcile";
import { classifyDroneCount } from "./droneCountReport";
import { mergeDroneEntries, type DroneEntry } from "./droneReport";

export interface DroneMessage {
  ts: string;
  text: string;
}

export type DroneClassifier = (dayText: string) => Promise<{ entries: DroneEntry[]; forDate: string | null }>;

const kyivPostDate = (ts: string) => videoUploadDate(new Date(Number(ts) * 1000).toISOString());

/** date → merged drone entries. `classify` is injectable for tests. */
export async function extractDroneReports(
  messages: DroneMessage[],
  classify: DroneClassifier = classifyDroneCount,
): Promise<Map<string, DroneEntry[]>> {
  const textByPostDate = new Map<string, string[]>();
  for (const m of messages) {
    if (!m.text) continue;
    const d = kyivPostDate(m.ts);
    const arr = textByPostDate.get(d) ?? [];
    arr.push(m.text);
    textByPostDate.set(d, arr);
  }

  const byDate = new Map<string, DroneEntry[]>();
  for (const [postDate, texts] of textByPostDate) {
    const { entries, forDate } = await classify(texts.join("\n\n"));
    if (entries.length === 0) continue;
    const target = forDate ?? postDate;
    byDate.set(target, [...(byDate.get(target) ?? []), ...entries]);
  }
  for (const [date, entries] of byDate) byDate.set(date, mergeDroneEntries(entries));
  return byDate;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/extractDroneReports.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/extractDroneReports.ts lib/extractDroneReports.test.ts
git commit -m "feat(drones): per-day extraction with post-date/forDate attribution + merge"
```

---

### Task 4: Field-qa report shape carries drone entries

**Files:**
- Modify: `scripts/fieldQaReport.ts` (`ReportDay`, `buildReport`)
- Test: `scripts/fieldQaReport.test.ts` (create or extend)

**Interfaces:**
- Consumes: `DroneEntry` (Task 1).
- Produces: `ReportDay` gains optional `droneReport?: DroneEntry[]`; `buildReport(days, period, permalinkByTs, droneByDate?: Map<string, DroneEntry[]>)`.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/fieldQaReport.test.ts  (add this describe block; keep any existing tests)
import { describe, it, expect } from "vitest";
import { buildReport, type ExtractedDay, type Period } from "./fieldQaReport";
import { type DroneEntry } from "../lib/droneReport";

const PERIOD: Period = { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" };
const day = (date: string): ExtractedDay => ({ date, airborneSeconds: 600, flights: 1, flew: true, sourceTs: `${date}-ts` });

describe("buildReport drone attachment", () => {
  it("attaches drone entries by date and omits the field when none", () => {
    const drones = new Map<string, DroneEntry[]>([["2026-06-25", [{ name: "Андріан", isPerson: true, count: 2 }]]]);
    const report = buildReport([day("2026-06-25"), day("2026-06-26")], PERIOD, new Map(), drones);
    expect(report.days.find((d) => d.date === "2026-06-25")?.droneReport).toEqual([{ name: "Андріан", isPerson: true, count: 2 }]);
    expect(report.days.find((d) => d.date === "2026-06-26")).not.toHaveProperty("droneReport");
  });
  it("omits droneReport entirely when no map is passed", () => {
    const report = buildReport([day("2026-06-25")], PERIOD, new Map());
    expect(report.days[0]).not.toHaveProperty("droneReport");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/fieldQaReport.test.ts`
Expected: FAIL — `buildReport` takes 3 args; `droneReport` never set.

- [ ] **Step 3: Edit `scripts/fieldQaReport.ts`**

Add the import near the top (after the existing `FIELD_TIMEZONE` import):

```ts
import type { DroneEntry } from "../lib/droneReport";
```

Add the optional field to `ReportDay` (after `permalink: string;`):

```ts
  /** Per-person / per-category drone counts from that day's drone-count report. */
  droneReport?: DroneEntry[];
```

Replace `buildReport` with the drone-aware version:

```ts
/** Build the lossless report artifact, attaching a Slack permalink and (when
 *  provided) the day's parsed drone-count entries per day. */
export function buildReport(
  days: ExtractedDay[],
  period: Period,
  permalinkByTs: Map<string, string>,
  droneByDate?: Map<string, DroneEntry[]>,
): FieldQaReport {
  const reportDays: ReportDay[] = days.map((d) => {
    const drones = droneByDate?.get(d.date);
    return {
      date: d.date,
      flightHours: round2(d.airborneSeconds / 3600),
      airborneMinutes: round2(d.airborneSeconds / 60),
      flights: d.flew ? d.flights : 0, // a no-fly day carries 0 flights (no phantom count)
      flew: d.flew,
      permalink: permalinkByTs.get(d.sourceTs) ?? "",
      ...(drones && drones.length ? { droneReport: drones } : {}),
    };
  });
  const flightHours = round2(reportDays.reduce((sum, d) => sum + d.flightHours, 0));
  return {
    period,
    sourceChannel: "field-qa",
    days: reportDays,
    totals: { days: reportDays.filter((d) => d.flew).length, flightHours },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/fieldQaReport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/fieldQaReport.ts scripts/fieldQaReport.test.ts
git commit -m "feat(drones): field-qa ReportDay carries optional droneReport"
```

---

### Task 5: Wire extraction into the field-qa extract pass

**Files:**
- Modify: `lib/fieldQaExtract.ts`
- Test: `lib/fieldQaExtract.test.ts` (create)

**Interfaces:**
- Consumes: `extractDroneReports` (Task 3); drone-aware `buildReport` (Task 4).
- Produces: `extractFieldQa` now populates `report.days[].droneReport`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/fieldQaExtract.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("./slack", () => ({
  fetchMessages: vi.fn(async () => [
    {
      channel: "field-qa",
      ts: "1000",
      text: "Статистика польотів за 2026-06-25\nЧас в повітрі (сек): 600\nКількість польотів: 1\nСьогодні літали: Так",
      files: [],
      permalink: "https://slack/p1",
    },
    { channel: "field-qa", ts: "1001", text: "Андріан R&D - 1шт", files: [], permalink: "https://slack/p2" },
  ]),
  downloadFileBase64: vi.fn(),
}));
vi.mock("./flightExtract", () => ({ extractAirborne: vi.fn() }));
vi.mock("./flightTextParse", () => ({
  parseAirborneFromText: vi.fn(() => ({ airborneSeconds: 600, flights: 1, flew: true })),
}));
vi.mock("./extractDroneReports", () => ({
  extractDroneReports: vi.fn(async () => new Map([["2026-06-25", [{ name: "Андріан", isPerson: true, count: 1 }]]])),
}));
vi.mock("./reports", () => ({ writeReport: vi.fn(async () => ({ key: "2026-06" })) }));

import { extractFieldQa } from "./fieldQaExtract";
import { extractDroneReports } from "./extractDroneReports";

describe("extractFieldQa drone wiring", () => {
  it("passes field-qa messages to extractDroneReports and attaches the result", async () => {
    const { report } = await extractFieldQa({ start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" });
    expect(extractDroneReports).toHaveBeenCalledWith([
      { ts: "1000", text: expect.stringContaining("Статистика") },
      { ts: "1001", text: "Андріан R&D - 1шт" },
    ]);
    expect(report.days.find((d) => d.date === "2026-06-25")?.droneReport).toEqual([{ name: "Андріан", isPerson: true, count: 1 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/fieldQaExtract.test.ts`
Expected: FAIL — `extractDroneReports` not called; `droneReport` undefined.

- [ ] **Step 3: Edit `lib/fieldQaExtract.ts`**

Add the import (after `import { parseAirborneFromText } from "./flightTextParse";`):

```ts
import { extractDroneReports } from "./extractDroneReports";
```

After the `extracted` loop and before `const days = validateDays(extracted);`, add the drone pass over ALL field-qa messages (not just the summary cards):

```ts
  // Per-day drone-count entries from that day's #field-qa messages (a separate
  // free-text report, not the stat card). Attributed by post date / explicit date.
  const fieldQaMessages = messages.filter((m) => m.channel === FIELD_QA_CHANNEL);
  const droneByDate = await extractDroneReports(fieldQaMessages.map((m) => ({ ts: m.ts, text: m.text })));
```

Change the `buildReport` call to pass `droneByDate`:

```ts
  const report = buildReport(days, period, permalinkByTs, droneByDate);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/fieldQaExtract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/fieldQaExtract.ts lib/fieldQaExtract.test.ts
git commit -m "feat(drones): extract per-day drone counts in the field-qa pass"
```

---

### Task 6: Carry drone entries through to DayVerdict

**Files:**
- Modify: `lib/fieldDayVerdict.ts` (`DayVerdict` type)
- Modify: `lib/computeVerdicts.ts` (local `FieldQaReport` interface + attach)

**Interfaces:**
- Consumes: `DroneEntry` (Task 1); `report.days[].droneReport` (Task 4).
- Produces: `DayVerdict` gains optional `droneReport?: DroneEntry[]`; `computeVerdicts` populates it per day.

- [ ] **Step 1: Edit `lib/fieldDayVerdict.ts`**

Add the type import (after the existing imports at the top):

```ts
import type { DroneEntry } from "./droneReport";
```

Add the optional field to `DayVerdict` (after `deployWindow?: { start: string; end: string };`):

```ts
  /** Per-person / per-category drone counts for the day (display only; not a gate). */
  droneReport?: DroneEntry[];
```

`verdictForDay` needs no change — the field is optional and set later by `computeVerdicts`.

- [ ] **Step 2: Edit `lib/computeVerdicts.ts`**

Add the type import (near the other type imports):

```ts
import type { DroneEntry } from "./droneReport";
```

Extend the local `FieldQaReport` interface:

```ts
interface FieldQaReport {
  days: { date: string; airborneMinutes: number; droneReport?: DroneEntry[] }[];
}
```

After the `airborneByDate` block (before section 2), build the drone map:

```ts
  const droneByDate = new Map<string, DroneEntry[]>(
    (fq?.days ?? []).filter((d) => d.droneReport && d.droneReport.length).map((d) => [d.date, d.droneReport!]),
  );
```

In the `flightDays.map(...)` return, attach it:

```ts
    const drones = droneByDate.get(date);
    return {
      ...resolved,
      roster: eff.roster,
      unknownInitials: parsed?.unknownInitials ?? [],
      ...(drones && drones.length ? { droneReport: drones } : {}),
    };
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/fieldDayVerdict.ts lib/computeVerdicts.ts
git commit -m "feat(drones): thread droneReport onto DayVerdict in computeVerdicts"
```

---

### Task 7: Render the drone line + keep message regions disjoint

**Files:**
- Modify: `lib/verdictPublish.ts`
- Modify: `lib/applyRosterCorrection.ts`
- Modify: `lib/applyApproval.ts`
- Test: `lib/verdictPublish.test.ts` (extend)

**Interfaces:**
- Consumes: `formatDroneLine` (Task 1); `DayVerdict.droneReport` (Task 6).
- Produces: `DRONE_MARKER`; `withDroneLine(text, entries)`; `splitDroneLine(text)`; `splitRosterSuffix` now returns `{ body, rosterLine, droneLine }`.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/verdictPublish.test.ts  (add; keep existing tests)
import { describe, it, expect } from "vitest";
import { formatDayMessage, splitRosterSuffix, parseRosterSuffix, withDroneLine } from "./verdictPublish";
import type { DayVerdict } from "./fieldDayVerdict";

const base: DayVerdict = {
  date: "2026-06-25",
  status: "NEEDS_REVIEW",
  airborneMinutes: 0,
  videoMinutes: 0,
  ratio: null,
  datasetStatus: "MISSING",
  withinGrace: false,
  reasons: [],
  roster: ["Влад", "Тарас"],
  unknownInitials: [],
  airborneReported: false,
  deployWindow: { start: "16:30", end: "19:00" },
  droneReport: [
    { name: "Андріан", isPerson: true, count: 2 },
    { name: "Демонстраційні", isPerson: false, count: 8 },
  ],
};

describe("formatDayMessage drone line", () => {
  it("appends the drone line after the crew suffix", () => {
    const msg = formatDayMessage(base);
    expect(msg).toContain("\n👥 У полі: Влад, Тарас.");
    expect(msg).toContain("\n🛸 Дрони: Андріан 2, інші 8 (усього 10)");
    expect(msg.indexOf("👥")).toBeLessThan(msg.indexOf("🛸")); // crew before drones
  });
  it("omits the drone line when there is no drone report", () => {
    expect(formatDayMessage({ ...base, droneReport: undefined })).not.toContain("🛸");
  });
});

describe("region discipline", () => {
  const withDrones = formatDayMessage(base);
  it("splitRosterSuffix peels the crew line drone-free and returns the drone line", () => {
    const { body, rosterLine, droneLine } = splitRosterSuffix(withDrones);
    expect(rosterLine).toBe("👥 У полі: Влад, Тарас.");
    expect(droneLine).toBe("🛸 Дрони: Андріан 2, інші 8 (усього 10)");
    expect(body).not.toContain("👥");
    expect(body).not.toContain("🛸");
  });
  it("parseRosterSuffix ignores the drone line", () => {
    expect(parseRosterSuffix(withDrones)).toEqual(["Влад", "Тарас"]);
  });
  it("withDroneLine round-trips a re-composed message", () => {
    const { body, rosterLine, droneLine } = splitRosterSuffix(withDrones);
    const recomposed = withDroneLine(`${body}\n${rosterLine}`, base.droneReport);
    expect(recomposed).toBe(withDrones);
    expect(droneLine).not.toBeNull();
  });
  it("no drone line → droneLine null, crew still parses", () => {
    const plain = formatDayMessage({ ...base, droneReport: undefined });
    const { rosterLine, droneLine } = splitRosterSuffix(plain);
    expect(droneLine).toBeNull();
    expect(rosterLine).toBe("👥 У полі: Влад, Тарас.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/verdictPublish.test.ts`
Expected: FAIL — no `withDroneLine`/drone rendering; `splitRosterSuffix` has no `droneLine`.

- [ ] **Step 3: Edit `lib/verdictPublish.ts`**

Add imports (after the existing `import type { DayVerdict }` line):

```ts
import { formatDroneLine, type DroneEntry } from "./droneReport";
```

Add the marker + helpers after `ROSTER_MARKER`:

```ts
export const DRONE_MARKER = "🛸 Дрони: ";

/** Append the drone-count line. Null/empty entries → text unchanged. Pure. */
export function withDroneLine(text: string, entries: DroneEntry[] | undefined): string {
  const line = entries ? formatDroneLine(entries) : null;
  return line ? `${text}\n${line}` : text;
}

/** Peel a trailing "\n🛸 Дрони: …" line off the end. Pure. */
export function splitDroneLine(text: string): { rest: string; droneLine: string | null } {
  const idx = text.lastIndexOf(`\n${DRONE_MARKER}`);
  if (idx === -1) return { rest: text, droneLine: null };
  const after = text.slice(idx + 1);
  if (after.includes("\n")) return { rest: text, droneLine: null }; // not the trailing line
  return { rest: text.slice(0, idx), droneLine: after };
}
```

Replace `splitRosterSuffix` (peel the drone line first, and return it):

```ts
/** Split a published message into body + crew suffix + drone line. The crew
 *  suffix is the line at the last crew marker with any trailing drone line
 *  removed, so parseRosterSuffix stays drone-free. Pure. */
export function splitRosterSuffix(text: string): { body: string; rosterLine: string | null; droneLine: string | null } {
  const { rest, droneLine } = splitDroneLine(text);
  const idx = rest.lastIndexOf(`\n${ROSTER_MARKER}`);
  if (idx === -1) return { body: rest, rosterLine: null, droneLine };
  return { body: rest.slice(0, idx), rosterLine: rest.slice(idx + 1), droneLine };
}
```

`parseRosterSuffix` already destructures `{ rosterLine }` from `splitRosterSuffix`, so it needs no change (rosterLine is now drone-free).

Update the three `formatDayMessage` returns to append the drone line after the crew suffix:

```ts
  if (day.status === "ACCEPTED") {
    return withDroneLine(
      withRosterSuffix(`✅ ${date} — прийнято (відео ${vid} хв — це ${pct} від ${air} хв у повітрі; ${ds}).`, day.roster),
      day.droneReport,
    );
  }
  if (day.status === "ACCEPTED_EXCEPTION") {
    const note = day.reasons.length
      ? day.reasons[day.reasons.length - 1].replace(/^exception/, "виняток")
      : "";
    const parts = [...ukrainianGaps(day), note].filter(Boolean);
    return withDroneLine(
      withRosterSuffix(`🟡 ${date} — прийнято (виняток): ${parts.join("; ")}.`, day.roster),
      day.droneReport,
    );
  }
  const tail = day.airborneReported && day.airborneMinutes > 0
    ? `(відео ${vid} хв / ${air} хв у повітрі, ${ds})`
    : `(відео ${vid} хв, ${ds})`;
  return withDroneLine(
    withRosterSuffix(`${icon} ${date} — потрібна перевірка: ${ukrainianGaps(day).join("; ")} ${tail}.`, day.roster),
    day.droneReport,
  );
```

- [ ] **Step 4: Fix `lib/applyRosterCorrection.ts` (preserve the drone line on a crew edit)**

Replace lines 41–42:

```ts
  // Edit ONLY the crew suffix; keep the body (incl. any override strike) AND the
  // trailing drone line intact — each is a disjoint region.
  const { body, droneLine } = splitRosterSuffix(entry.text);
  const withRoster = withRosterSuffix(body, outcome.roster);
  const updatedText = droneLine ? `${withRoster}\n${droneLine}` : withRoster;
```

- [ ] **Step 5: Fix `lib/applyApproval.ts` (preserve crew + drone line under a strike)**

Replace lines 69–71:

```ts
  const { body, rosterLine, droneLine } = splitRosterSuffix(entry.text);
  const { updatedText: struck, replyText } = formatOverride(body, decision, by, reason);
  const tail = [rosterLine, droneLine].filter(Boolean).join("\n");
  const updatedText = tail ? `${struck}\n${tail}` : struck;
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run lib/verdictPublish.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors. (`applyInstruction.ts` uses `parseRosterSuffix`, which is unchanged in signature — verify it still compiles.)

- [ ] **Step 7: Commit**

```bash
git add lib/verdictPublish.ts lib/applyRosterCorrection.ts lib/applyApproval.ts lib/verdictPublish.test.ts
git commit -m "feat(drones): render 🛸 drone line as a disjoint verdict-message region"
```

---

### Task 8: Two-interface surfaces (verdict CSV + web column)

**Files:**
- Modify: `scripts/fieldVerdictReport.ts` (`toCsv`)
- Modify: `app/(dashboard)/field-verdict/page.tsx` (table)
- Test: `scripts/fieldVerdictReport.test.ts` (extend or create)

**Interfaces:**
- Consumes: `formatDroneCsv` (Task 1); `formatDroneLine` (Task 1); `DayVerdict.droneReport` (Task 6).

- [ ] **Step 1: Write the failing test**

```ts
// scripts/fieldVerdictReport.test.ts  (add; keep existing tests)
import { describe, it, expect } from "vitest";
import { toCsv, type VerdictReport } from "./fieldVerdictReport";
import type { DayVerdict } from "../lib/fieldDayVerdict";

const day: DayVerdict = {
  date: "2026-06-25", status: "NEEDS_REVIEW", airborneMinutes: 0, videoMinutes: 0, ratio: null,
  datasetStatus: "MISSING", withinGrace: false, reasons: [], roster: ["Влад"], unknownInitials: [],
  airborneReported: false, droneReport: [{ name: "Андріан", isPerson: true, count: 2 }, { name: "15ка", isPerson: false, count: 1 }],
};
const report: VerdictReport = {
  period: { start: "2026-06-01", end: "2026-06-30" }, runDate: "2026-06-30", graceWorkingDays: 3,
  days: [day], summary: { accepted: 0, pending: 0, needsReview: 1, acceptedException: 0, rejected: 0 },
};

describe("verdict CSV drones column", () => {
  it("has a drones header and CSV-friendly cell", () => {
    const csv = toCsv(report);
    expect(csv.split("\n")[0]).toBe("date,status,airborneMinutes,videoMinutes,ratio,datasetStatus,reasons,roster,drones");
    expect(csv.split("\n")[1]).toContain("Андріан 2; інші 1 (3)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/fieldVerdictReport.test.ts`
Expected: FAIL — header has no `drones`; cell absent.

- [ ] **Step 3: Edit `scripts/fieldVerdictReport.ts`**

Add the import (after `import type { DayVerdict } from "../lib/fieldDayVerdict";`):

```ts
import { formatDroneCsv } from "../lib/droneReport";
```

Replace `toCsv`:

```ts
export function toCsv(report: VerdictReport): string {
  const lines = ["date,status,airborneMinutes,videoMinutes,ratio,datasetStatus,reasons,roster,drones"];
  for (const d of report.days) {
    lines.push([
      d.date,
      d.status,
      d.airborneReported ? String(d.airborneMinutes) : "n/a",
      String(d.videoMinutes),
      d.ratio === null ? "" : d.ratio.toFixed(3),
      d.datasetStatus,
      csvField(d.reasons.join("; ")),
      csvField(d.roster.join("; ")),
      csvField(formatDroneCsv(d.droneReport ?? [])),
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: Run the CSV test**

Run: `npx vitest run scripts/fieldVerdictReport.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the web column in `app/(dashboard)/field-verdict/page.tsx`**

Add the import near the top of the file (with the other imports):

```ts
import { formatDroneLine } from "@/lib/droneReport";
```

Add a header cell after the Crew `<th>` (line ~156):

```tsx
                <th className="px-3 py-2">Drones</th>
```

Bump the empty-state `colSpan` from `8` to `9` (line ~162).

Add a body cell after the Crew `<td>` (line ~188), rendering the same line (the `🛸 Дрони: ` prefix is stripped for the table):

```tsx
                      <td className="px-3 py-2 text-slate-700">
                        {formatDroneLine(d.droneReport ?? [])?.replace("🛸 Дрони: ", "") || "—"}
                      </td>
```

- [ ] **Step 6: Typecheck + build the web**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; build succeeds. (`formatDroneLine` is a pure lib import — safe in the client component.)

- [ ] **Step 7: Commit**

```bash
git add scripts/fieldVerdictReport.ts scripts/fieldVerdictReport.test.ts "app/(dashboard)/field-verdict/page.tsx"
git commit -m "feat(drones): surface drone counts in the verdict CSV + web table"
```

---

### Task 9: Full suite, end-to-end dry-run, docs

**Files:**
- Modify: `CLAUDE.md` (field-qa + field-publish command notes)
- Modify: `.claude/skills/bonus-report/SKILL.md` (drone-count section note) — adjust to the actual skill path if different
- Create: `/home/node/.claude/projects/-workspaces-orients-ops-console/memory/drone-counts-in-verdict.md` + a one-line pointer in `MEMORY.md`

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS (all files, including the new drone tests).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: End-to-end dry-run against a committed month**

Run (requires `ANTHROPIC_API_KEY`, `VIMEO_TOKEN`, `POSTGRES_URL`; run `npm run slack-sync` first if the mirror is stale):

```bash
npm run field-qa -- --start 2026-06-01 --end 2026-06-30 --write
npm run field-verdict -- --start 2026-06-01 --end 2026-06-30 --write
npm run field-publish -- --start 2026-06-01 --end 2026-06-30
```

Expected: `field-publish` DRY-RUN prints at least one verdict message with a `🛸 Дрони: …` line after the `👥 У полі:` crew line for a day that had a drone-count report (e.g. 2026-06-25). Confirm no message is missing its crew line and no crash.

- [ ] **Step 4: Update `CLAUDE.md`**

In the `npm run field-qa` bullet, append: `Also extracts each day's #field-qa drone-count report into per-person/per-category entries (\`days[].droneReport\`, attributed to the post date unless the text names a date).`

In the `npm run field-publish` bullet, append: `Verdict messages carry a \`🛸 Дрони:\` line (per-person counts + total, non-person categories folded into \`інші\`) when the day had a drone-count report — a disjoint region below \`👥 У полі:\`.`

- [ ] **Step 5: Update the drone-count skill note**

In `.claude/skills/bonus-report/SKILL.md` (the skill that documents the drone-count gate), add a sentence noting the classifier now returns structured per-person entries (`classifyDroneCount → { present, entries, forDate }`), used by the verdict `🛸 Дрони:` line; `present` (derived) still gates the bonus.

- [ ] **Step 6: Write the memory note**

Create `/home/node/.claude/projects/-workspaces-orients-ops-console/memory/drone-counts-in-verdict.md`:

```markdown
---
name: drone-counts-in-verdict
description: verdict messages now carry a 🛸 Дрони: per-person line; drone classifier upgraded binary→structured
metadata:
  type: project
---

SHIPPED 2026-07: the #field-qa drone-count report is now parsed per-person/per-category (`lib/droneCountReport.classifyDroneCount` → `{present, entries, forDate}`; `present` still derived so the bonus gate is unchanged). Entries are extracted per day in `extractFieldQa` (`lib/extractDroneReports`, post-date attribution unless the text names a date), persisted to `field-qa` report `days[].droneReport`, carried onto `DayVerdict.droneReport`, and rendered by `formatDayMessage` as a trailing `🛸 Дрони: Андріан 2, інші 9 (усього 11)` line — a THIRD disjoint message region below `👥 У полі:` (splitRosterSuffix now returns `{body, rosterLine, droneLine}`; applyRosterCorrection/applyApproval preserve it). Out of scope: unifying the bonus path to read `days[].droneReport` instead of its own live classify. See [[field-bonus-model-and-gap]], [[approver-instructions-feature]].
```

Then add to `MEMORY.md`:

```markdown
- [Drone counts in verdict](drone-counts-in-verdict.md) — 🛸 Дрони: per-person line on verdict messages; classifier now structured (entries+forDate), present still derived; disjoint region below crew line
```

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md .claude/skills/bonus-report/SKILL.md
git commit -m "docs(drones): note structured drone-count classifier + verdict drone line"
```

(The memory files live outside the repo; they are written, not committed here.)

---

## Self-Review

**Spec coverage:**
- Structured classifier (spec §1) → Task 2. ✅
- Extraction pass + attribution/merge (spec §2) → Task 3, wired in Task 5. ✅
- Verdict passthrough (spec §3) → Task 6. ✅
- Rendering + region discipline (spec §4) → Task 7 (incl. `splitRosterSuffix`/`applyRosterCorrection`/`applyApproval`). ✅
- Two-interface surface: CSV + web (spec §5) → Task 8. ✅
- Backfill/nightly (spec §6): no code change needed — `extractFieldQa` (nightly Stage 3) now emits `droneReport`, and `field-backfill` re-renders via `formatDayMessage`. Verified by the Task 9 dry-run and covered by the region-discipline tests. ✅
- Error handling (spec): empty/failed classify → `entries: []` → no line (Task 2 short-circuit + Task 1 `formatDroneLine` null); drone report for a date with no field-qa day → dropped because `buildReport`/`computeVerdicts` only attach to existing days (Task 4/6). ✅
- Tests (spec) → Tasks 1,2,3,4,5,7,8. ✅
- Out-of-scope (bonus unification, registry resolution) → left untouched; `present` derived keeps the bonus gate identical (Task 2 Step 6). ✅

**Placeholder scan:** none — every code step shows full code.

**Type consistency:** `DroneEntry` defined once in `lib/droneReport.ts` (Task 1) and imported everywhere. `DroneCountResult` shape (Task 2) matches the `DroneClassifier` structural type used by `extractDroneReports` (Task 3). `splitRosterSuffix`'s new `{ body, rosterLine, droneLine }` return is consumed consistently in Tasks 7 (`applyRosterCorrection` uses `{body, droneLine}`, `applyApproval` uses all three); `parseRosterSuffix` still destructures `{ rosterLine }`. `buildReport`'s new 4th param is optional, so existing callers/tests are unaffected until Task 5 passes it.
