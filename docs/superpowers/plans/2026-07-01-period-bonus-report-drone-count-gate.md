# Period Bonus Report + drone-count gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Void a flight day's field bonuses when no drone-count/production report was posted in #field-qa that day, and add a period-bonus-report skill + web void-audit around the existing field-bonus artifact.

**Architecture:** The gate lives in the pure `computeBonuses` calculator (a day counts only if `deploy ≥ 3h AND video ≥ 2min AND a drone-count report exists`). A Claude classifier (`lib/droneCountReport.ts`, mirroring `lib/lossExtract.ts`) detects the report per Kyiv post-day; `computeBonusReport` runs it for otherwise-counted days and feeds the result in. The existing `field-bonus` JSON/web/CLI is extended (not duplicated) with a void audit; a new `bonus-report` skill documents generating the period payout.

**Tech Stack:** TypeScript (strict), Next.js 16 App Router, React 19, Vitest, `@anthropic-ai/sdk`, the repo's `server-only` + pure-`lib/` conventions.

## Global Constraints

- Import alias `@/*` maps to the repo root.
- Pure `lib/` modules (`lib/fieldBonus.ts`) must have **no** React/Next/`node:fs`/`server-only` imports — they are unit-tested in isolation. Keep it that way.
- Server-only modules that touch Claude/Vimeo/DB import `server-only` (throws if bundled to the client). The classifier `lib/droneCountReport.ts` MUST import `server-only`.
- Claude model constant across field classifiers is `"claude-sonnet-4-6"`. Use it.
- Field timezone is `Europe/Kyiv` (`FIELD_TIMEZONE` in `lib/reconcile.ts`). Day boundaries use it, never UTC.
- A Slack `ts` → Kyiv date is `videoUploadDate(new Date(Number(ts) * 1000).toISOString())` (`videoUploadDate` from `lib/reconcile.ts` takes an ISO string, formats in `Europe/Kyiv`).
- `BonusReport` JSON is the web render source and the exact shape `GET /api/field-bonus` returns — changes must be **additive/backward-compatible**.
- The flat field-bonus CSV (`person,trips,early,weekend,gross,penaltyPct,net`) is unchanged.
- Run a single test file with `npx vitest run <path>`; a named test with `npx vitest run -t "<name>"`.
- Commit messages end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

### Task 1: Drone-count classifier prompt + tool schema (pure)

**Files:**
- Create: `lib/droneCountReportPrompt.ts`
- Test: `lib/droneCountReportPrompt.test.ts`

**Interfaces:**
- Consumes: `Anthropic.Tool` type from `@anthropic-ai/sdk` (type-only import, as in `lib/lossExtractPrompt.ts`).
- Produces:
  - `interface DroneCountResult { present: boolean; note: string }`
  - `const DRONE_COUNT_TOOL: Anthropic.Tool` (name `"record_drone_count_report"`)
  - `function buildDroneCountPrompt(dayText: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
// lib/droneCountReportPrompt.test.ts
import { describe, it, expect } from "vitest";
import { DRONE_COUNT_TOOL, buildDroneCountPrompt } from "./droneCountReportPrompt";

describe("droneCountReportPrompt", () => {
  it("exposes a well-formed tool schema", () => {
    expect(DRONE_COUNT_TOOL.name).toBe("record_drone_count_report");
    const schema = DRONE_COUNT_TOOL.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(["present", "note"]);
    expect(schema.required).toEqual(["present", "note"]);
  });

  it("embeds the day's text and asks for the tool call", () => {
    const p = buildDroneCountPrompt("Демонстраційні - 8 шт (Перевірені - 8шт)");
    expect(p).toContain("Демонстраційні - 8 шт");
    expect(p).toContain("record_drone_count_report");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/droneCountReportPrompt.test.ts`
Expected: FAIL — cannot resolve `./droneCountReportPrompt`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/droneCountReportPrompt.ts
/** Pure prompt + tool schema for classifying whether a day's #field-qa messages
 *  contain a drone-count/production report (the bonus gate). */
import type Anthropic from "@anthropic-ai/sdk";

export interface DroneCountResult {
  present: boolean;
  note: string;
}

export const DRONE_COUNT_TOOL: Anthropic.Tool = {
  name: "record_drone_count_report",
  description:
    "Classify whether the day's #field-qa messages include a drone-count / production tally (how many units were built/checked/at R&D that day).",
  input_schema: {
    type: "object",
    properties: {
      present: {
        type: "boolean",
        description:
          "true if the text contains a per-unit drone-count/production report (e.g. 'R&D - 1шт вартовий', 'Демонстраційні - 8шт', 'Перевірені - 8шт', '15ка - 1шт'). A flight-hours 'Звіт' or general chatter is NOT a drone-count report.",
      },
      note: { type: "string", description: "short quote of the matched drone-count line, or '' if none" },
    },
    required: ["present", "note"],
  },
};

export function buildDroneCountPrompt(dayText: string): string {
  return [
    `These are the #field-qa messages posted on one calendar day (Ukrainian).`,
    `Decide whether they include a drone-count / production tally: counts of drone units by category,`,
    `such as "R&D - 1шт вартовий", "Демонстраційні - 8шт", "Перевірені - 8шт", "15ка - 1шт".`,
    `A flight-hours "Звіт" (roster + time window) or general chatter is NOT a drone-count report.`,
    `Messages:`,
    `"""${dayText}"""`,
    `Call record_drone_count_report with present, note.`,
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/droneCountReportPrompt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/droneCountReportPrompt.ts lib/droneCountReportPrompt.test.ts
git commit -m "feat(bonus): drone-count report classifier prompt + tool schema"
```

---

### Task 2: Drone-count classifier (server-only Claude call)

**Files:**
- Create: `lib/droneCountReport.ts`

**Interfaces:**
- Consumes: `DRONE_COUNT_TOOL`, `buildDroneCountPrompt`, `DroneCountResult` from Task 1.
- Produces: `async function classifyDroneCount(dayText: string): Promise<DroneCountResult>`

**Note:** This module is a thin I/O wrapper around the Anthropic SDK and is not unit-tested in isolation — the sibling `lib/lossExtract.ts` has no test for the same reason (the pure prompt module in Task 1 is the tested surface). Mirror `lib/lossExtract.ts` exactly.

- [ ] **Step 1: Write the implementation**

```typescript
// lib/droneCountReport.ts
/** Classify whether a day's #field-qa messages contain a drone-count report via Claude. SERVER-ONLY. */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { DRONE_COUNT_TOOL, buildDroneCountPrompt, type DroneCountResult } from "./droneCountReportPrompt";

const MODEL = "claude-sonnet-4-6";

export async function classifyDroneCount(dayText: string): Promise<DroneCountResult> {
  if (!dayText.trim()) return { present: false, note: "" };
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (needed for field-bonus drone-count gate).");
  const client = new Anthropic();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    tools: [DRONE_COUNT_TOOL],
    tool_choice: { type: "tool", name: DRONE_COUNT_TOOL.name },
    messages: [{ role: "user", content: [{ type: "text", text: buildDroneCountPrompt(dayText) }] }],
  });
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const input = (block?.input ?? {}) as Partial<DroneCountResult>;
  return { present: Boolean(input.present), note: String(input.note ?? "") };
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no new errors from `lib/droneCountReport.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/droneCountReport.ts
git commit -m "feat(bonus): server-only drone-count classifier"
```

---

### Task 3: Gate in the pure calculator + void audit

**Files:**
- Modify: `lib/fieldBonus.ts`
- Test: `lib/fieldBonus.test.ts`

**Interfaces:**
- Consumes: nothing new (pure).
- Produces (changes later tasks rely on):
  - `computeBonuses` input object gains optional field `droneCountByDate?: Record<string, boolean>`.
  - `Flag.kind` union gains `"no_drone_count"`.
  - `DayBonus.reason` may be the string `"no-drone-count"`.
  - `BonusReport` gains `voidedDays: { date: string; roster: string[]; reason: string }[]`.

**Gate semantics (exact):**
- `input.droneCountByDate === undefined` ⇒ gate disabled (every day treated as reported) — preserves existing callers/tests.
- `input.droneCountByDate` present ⇒ a date missing from the map is `false` (voided).
- `const droneCountReported = input.droneCountByDate == null || input.droneCountByDate[r.flightDate] === true;`
- `const counted = hoursOk && videoOk && droneCountReported;`
- Reason precedence: `counted ? "counted" : !hoursOk ? "deploy<3h" : !videoOk ? "video<2min" : "no-drone-count"`.
- Push `{ kind: "no_drone_count", date, detail }` iff `hoursOk && videoOk && !droneCountReported`.
- `voidedDays` = the `days` where `reason === "no-drone-count"`, mapped to `{ date, roster, reason }`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/fieldBonus.test.ts` (inside the top `describe("computeBonuses", ...)` block, after the existing cases):

```typescript
  it("voids an otherwise-counted day with no drone-count report (that day, whole crew)", () => {
    const r = computeBonuses({
      period,
      reports: [rep({ flightDate: "2026-05-01", roster: ["Андріан", "Данило"] })],
      videoMinutesByDate: { "2026-05-01": 9 },
      losses: [],
      droneCountByDate: { "2026-05-01": false },
    });
    expect(r.people).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.days[0].reason).toBe("no-drone-count");
    expect(r.flags).toContainEqual({ kind: "no_drone_count", date: "2026-05-01", detail: expect.any(String) });
    expect(r.voidedDays).toEqual([{ date: "2026-05-01", roster: ["Андріан", "Данило"], reason: "no-drone-count" }]);
  });

  it("pays normally when the drone-count report is present", () => {
    const r = computeBonuses({
      period,
      reports: [rep({ flightDate: "2026-05-01" })],
      videoMinutesByDate: { "2026-05-01": 9 },
      losses: [],
      droneCountByDate: { "2026-05-01": true },
    });
    expect(r.total).toBe(700);
    expect(r.voidedDays).toEqual([]);
    expect(r.flags.find((f) => f.kind === "no_drone_count")).toBeUndefined();
  });

  it("keeps the hours reason (no drone-count flag) when the day already fails deploy<3h", () => {
    const r = computeBonuses({
      period,
      reports: [rep({ flightDate: "2026-05-02", start: "14:00", end: "16:30", deployMin: 150 })],
      videoMinutesByDate: { "2026-05-02": 9 },
      losses: [],
      droneCountByDate: {}, // present but missing this date
    });
    expect(r.days[0].reason).toBe("deploy<3h");
    expect(r.flags.find((f) => f.kind === "no_drone_count")).toBeUndefined();
    expect(r.voidedDays).toEqual([]);
  });

  it("leaves the gate disabled when droneCountByDate is omitted (backward compatible)", () => {
    const r = computeBonuses({
      period,
      reports: [rep({ flightDate: "2026-05-01" })],
      videoMinutesByDate: { "2026-05-01": 9 },
      losses: [],
    });
    expect(r.total).toBe(700);
    expect(r.voidedDays).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/fieldBonus.test.ts`
Expected: FAIL — `droneCountByDate` not accepted / `voidedDays` undefined / new reason & flag missing.

- [ ] **Step 3: Edit the types**

In `lib/fieldBonus.ts`, change the `Flag` and `BonusReport` interfaces:

```typescript
export interface Flag { kind: "unknown_initial" | "qualifying_unrecorded" | "counted_no_video" | "no_drone_count"; date: string; detail: string }
export interface BonusReport { period: Period; days: DayBonus[]; people: PersonBonus[]; penalties: Penalty[]; teamZeroed: boolean; flags: Flag[]; total: number; voidedDays: { date: string; roster: string[]; reason: string }[] }
```

And add the optional input field to the `computeBonuses` parameter type:

```typescript
export function computeBonuses(input: {
  period: Period;
  reports: FieldReport[];
  videoMinutesByDate: Record<string, number>;
  losses: LossRecord[];
  corrections?: RosterCorrection[];
  droneCountByDate?: Record<string, boolean>;
}): BonusReport {
  const { period, reports, videoMinutesByDate, losses, corrections = [], droneCountByDate } = input;
```

- [ ] **Step 4: Add the gate inside the per-report loop**

In `lib/fieldBonus.ts`, replace the `counted`/`reason` block inside `for (const r of reports)` (currently lines ~53–61) with:

```typescript
    const videoMin = Math.round((videoMinutesByDate[r.flightDate] ?? 0) * 10) / 10;
    const hoursOk = r.deployMin != null && r.deployMin >= MIN_DEPLOY_MIN;
    const videoOk = videoMin >= MIN_VIDEO_MIN;
    const droneCountReported = droneCountByDate == null || droneCountByDate[r.flightDate] === true;
    const counted = hoursOk && videoOk && droneCountReported;
    if (hoursOk && !videoOk) flags.push({ kind: "counted_no_video", date: r.flightDate, detail: `deploy ${r.deployMin}min but video ${videoMin}min < ${MIN_VIDEO_MIN}` });
    if (hoursOk && videoOk && !droneCountReported) flags.push({ kind: "no_drone_count", date: r.flightDate, detail: `deploy ${r.deployMin}min + video ${videoMin}min OK but no drone-count report in #field-qa` });
    const sm = startMin(r.start);
    const early = counted && sm != null && sm <= EARLY_CUTOFF_MIN;
    const weekend = counted && isWeekend(r.flightDate);
    const reason = counted ? "counted" : !hoursOk ? "deploy<3h" : !videoOk ? "video<2min" : "no-drone-count";
```

- [ ] **Step 5: Populate `voidedDays` and add it to the returned report**

In `lib/fieldBonus.ts`, just before the final `return`, add:

```typescript
  const voidedDays = days.filter((d) => d.reason === "no-drone-count").map((d) => ({ date: d.date, roster: d.roster, reason: d.reason }));
```

and change the return to include it:

```typescript
  return { period, days, people, penalties, teamZeroed, flags, total, voidedDays };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run lib/fieldBonus.test.ts`
Expected: PASS — all existing cases plus the 4 new ones.

- [ ] **Step 7: Commit**

```bash
git add lib/fieldBonus.ts lib/fieldBonus.test.ts
git commit -m "feat(bonus): drone-count gate voids unreported days + void audit"
```

---

### Task 4: Wire classification into `computeBonusReport`

**Files:**
- Modify: `lib/computeBonuses.ts`

**Interfaces:**
- Consumes: `classifyDroneCount` (Task 2), `videoUploadDate` (`lib/reconcile.ts`), the extended `computeBonuses` input (Task 3).
- Produces: `computeBonusReport` now feeds `droneCountByDate` into `computeBonuses`; no signature change (still `(period, opts) => Promise<BonusReport>`).

**Note:** `computeBonuses.ts` is `server-only` (live Vimeo + Claude + DB); it is not unit-tested. Verify via typecheck; the behavior is covered by Task 3's pure tests plus the manual run in Task 7.

- [ ] **Step 1: Add the import**

In `lib/computeBonuses.ts`, add near the other `./` imports:

```typescript
import { videoUploadDate } from "./reconcile";
import { classifyDroneCount } from "./droneCountReport";
```

(`videoUploadDate` may already be transitively available; add the explicit import.)

- [ ] **Step 2: Classify otherwise-counted days and build the map**

In `lib/computeBonuses.ts`, after the `losses` loop and before `const corrections = ...`, insert:

```typescript
  // Drone-count gate: a day counts only if a drone-count report was posted in
  // #field-qa that day. Classify only otherwise-counted days (bounds Claude calls).
  const msgKyivDate = (ts: string) => videoUploadDate(new Date(Number(ts) * 1000).toISOString());
  const textByDate = new Map<string, string[]>();
  for (const m of messages) {
    const d = msgKyivDate(m.ts);
    const arr = textByDate.get(d) ?? [];
    if (m.text) arr.push(m.text);
    textByDate.set(d, arr);
  }
  const droneCountByDate: Record<string, boolean> = {};
  for (const r of reports) {
    const videoMin = videoMinutesByDate[r.flightDate] ?? 0;
    const otherwiseCounted = r.deployMin != null && r.deployMin >= 180 && videoMin >= 2;
    if (!otherwiseCounted) continue;
    const dayText = (textByDate.get(r.flightDate) ?? []).join("\n\n");
    const cls = await classifyDroneCount(dayText);
    droneCountByDate[r.flightDate] = cls.present;
  }
  const voided = Object.entries(droneCountByDate).filter(([, present]) => !present).map(([d]) => d);
  log(`field-bonus: ${Object.keys(droneCountByDate).length - voided.length}/${Object.keys(droneCountByDate).length} counted days have a drone-count report${voided.length ? ` (voided: ${voided.join(", ")})` : ""}`);
```

- [ ] **Step 3: Pass the map into `computeBonuses`**

In `lib/computeBonuses.ts`, change the `computeBonuses` call:

```typescript
  const report = computeBonuses({ period, reports, videoMinutesByDate, losses, corrections, droneCountByDate });
```

- [ ] **Step 4: Verify it type-checks and the suite is green**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/computeBonuses.ts
git commit -m "feat(bonus): classify drone-count reports and feed the gate"
```

---

### Task 5: Web void-audit section on the field-bonus page

**Files:**
- Modify: `app/(dashboard)/field-bonus/page.tsx`

**Interfaces:**
- Consumes: `report.voidedDays` and `report.flags` (kind `"no_drone_count"`) from the extended `BonusReport` (Tasks 3–4). The page already renders `report.people`/`report.total`/`report.flags` via `usePeriodReport<BonusReport>`.

**Note:** No route change — `GET /api/field-bonus` serves the extended JSON verbatim. Verify by build + lint (no local Vimeo/Claude needed to render committed JSON).

- [ ] **Step 1: Add a "Voided days" section**

In `app/(dashboard)/field-bonus/page.tsx`, after the block that renders the people/total table and before (or after) the existing flags block, add a section that renders when `report?.voidedDays?.length`:

```tsx
{report && report.voidedDays && report.voidedDays.length > 0 && (
  <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
    <h2 className="text-sm font-semibold text-amber-900">
      Voided days — no drone-count report in #field-qa ({report.voidedDays.length})
    </h2>
    <p className="mt-1 text-xs text-amber-700">
      These days met the 3h + 2min gate but had no drone-count/production report, so
      the whole crew earns nothing for the day.
    </p>
    <ul className="mt-2 space-y-1 text-sm text-amber-900">
      {report.voidedDays.map((d) => (
        <li key={d.date} className="tabular-nums">
          {d.date} — {d.roster.join(", ") || "(no crew parsed)"}
        </li>
      ))}
    </ul>
  </div>
)}
```

- [ ] **Step 2: Verify build + lint**

Run: `npm run lint && npm run build`
Expected: no lint errors; build succeeds. (If `voidedDays` is flagged as possibly-undefined on older committed JSON, the `report.voidedDays &&` guard already handles it.)

- [ ] **Step 3: Commit**

```bash
git add "app/(dashboard)/field-bonus/page.tsx"
git commit -m "feat(bonus): render the drone-count void audit on the field-bonus page"
```

---

### Task 6: New `bonus-report` skill + cross-link

**Files:**
- Create: `.claude/skills/bonus-report/SKILL.md`
- Modify: `.claude/skills/field-bonus/SKILL.md` (add one cross-link line)

**Interfaces:** Documentation only. No code.

- [ ] **Step 1: Write the skill**

Create `.claude/skills/bonus-report/SKILL.md`:

```markdown
---
name: bonus-report
description: Use when asked to generate or read the field-bonus payout report for a whole period — the settled per-person totals, who gets paid, the period total, and which flight days were voided (and why). For per-person "what did X earn" questions use the field-bonus skill instead.
---

# Bonus Report (per period)

Produce and read the period field-bonus payout: the number to actually pay each
person, plus a void audit of days that earned nothing.

## Gate (must-know)

A flight day counts toward bonuses only if **all three** hold:

1. deployment ≥ **3 hours**, and
2. recorded video ≥ **2 minutes**, and
3. a **drone-count / production report was posted in #field-qa that day**
   (e.g. `R&D - 1шт вартовий`, `Демонстраційні - 8шт`, `Перевірені`, `15ка - 1шт`).

A missing drone-count report **voids that day for the whole crew** (reason
`no-drone-count`; surfaced as a `no_drone_count` flag and in `voidedDays`). This
is separate from the monthly `>3 drones lost` team cutoff, which zeroes the
whole period.

## How to generate the report

Run these in order (all default to the current Kyiv month if dates are omitted):

```bash
npm run slack-sync                                   # mirror #field-qa (reports + drone-count posts)
npm run field-qa -- --start 2026-06-01 --end 2026-06-30 --write   # parse flight-hours Звіт
npm run field-bonus -- --start 2026-06-01 --end 2026-06-30 --write # compute + commit the report
```

`--write` persists `reports/field-bonus/<period>.{json,csv}`. The JSON is the
payout report and the web render source.

## How to read it

From `reports/field-bonus/<period>.json` (or `npm run field-bonus -- … --format table`):

- `total` — the summed net payout (0 if `teamZeroed`).
- `people[]` — per person: `{ name, trips, early, weekend, gross, penaltyPct, net }`. **`net` is the amount to pay.**
- `teamZeroed` — true iff >3 drones lost in the period (whole period zeroed).
- `voidedDays[]` — `{ date, roster, reason }` for days voided by the drone-count gate.
- `flags[]` — includes `no_drone_count` entries and `counted_no_video` warnings.

## Prerequisites

- `VIMEO_TOKEN`, `ANTHROPIC_API_KEY`, `POSTGRES_URL` in `.env` (video minutes,
  the drone-loss + drone-count classifiers, and roster aliases). Missing any →
  the CLI exits non-zero with a clear message.
- Run `npm run slack-sync` first — the CLI reads the #field-qa mirror.

## Related

- `field-bonus` skill — per-person questions ("what did X earn in May?").
```

- [ ] **Step 2: Cross-link from the field-bonus skill**

In `.claude/skills/field-bonus/SKILL.md`, under the `## Out of scope` (or near the top "When to use"), add one line:

```markdown
For the whole-period payout report (totals + who gets paid + voided days), use the **bonus-report** skill.
```

- [ ] **Step 3: Verify the skill files are well-formed**

Run: `head -5 .claude/skills/bonus-report/SKILL.md`
Expected: shows the YAML frontmatter with `name: bonus-report` and a `description:`.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/bonus-report/SKILL.md .claude/skills/field-bonus/SKILL.md
git commit -m "docs(bonus): bonus-report skill for the per-period payout"
```

---

### Task 7: Update CLAUDE.md + end-to-end smoke check

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** Documentation + verification only.

- [ ] **Step 1: Document the gate in CLAUDE.md**

In `CLAUDE.md`, on the `npm run field-bonus` bullet, append a sentence noting the third gate condition:

```
A day counts only if deploy ≥ 3h AND video ≥ 2min AND a drone-count/production report was posted in #field-qa that day (Claude-classified); a missing report voids that day for its whole crew (`no-drone-count`, surfaced in `voidedDays`/`no_drone_count` flags). See `.claude/skills/bonus-report/`.
```

- [ ] **Step 2: Full suite + typecheck + lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all green.

- [ ] **Step 3: End-to-end smoke run (requires `.env` with tokens)**

Run: `npm run field-bonus -- --start 2026-06-01 --end 2026-06-30 --format table`
Expected: prints the table; the stderr log line reports `N/M counted days have a drone-count report` and lists any voided dates. Confirm a day known to lack a drone-count report shows `no-drone-count` / appears under voided. (If tokens are absent, note this step was skipped and why.)

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(bonus): document the drone-count gate in CLAUDE.md"
```

---

## Self-Review

**Spec coverage:**
- Gate in pure calculator (spec §Architecture 1) → Task 3. ✓
- Reason `no-drone-count`, flag `no_drone_count`, `voidedDays` (spec §Report shape) → Task 3. ✓
- Two-level `droneCountByDate` semantics (spec §1 edit + Risk #4) → Task 3 gate semantics + backward-compat test. ✓
- Classifier `lib/droneCountReport.ts` + prompt module (spec §Architecture 2) → Tasks 1–2. ✓
- Orchestration: group by Kyiv post-date, classify otherwise-counted days, feed map, log summary (spec §Architecture 3) → Task 4. ✓
- Web void-audit section (spec §Web) → Task 5. ✓
- `bonus-report` skill distinct from `field-bonus` (spec §Skill) → Task 6. ✓
- CSV unchanged, JSON additive (spec §Report shape) → no CSV task; Task 3 keeps `toCsv` untouched. ✓
- Same-day attribution (spec §Risk 1, approved) → Task 4 uses `msgKyivDate(m.ts) === r.flightDate`. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; test code is concrete.

**Type consistency:** `classifyDroneCount` / `DroneCountResult` / `DRONE_COUNT_TOOL` / `record_drone_count_report` used consistently across Tasks 1–2; `droneCountByDate` field, `no_drone_count` flag kind, `no-drone-count` reason, and `voidedDays` used identically in Tasks 3–5. `computeBonuses`/`computeBonusReport` signatures unchanged except the documented additive input. ✓
