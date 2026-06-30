# Field crew on verdicts + approver thread-corrections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the field crew on each published per-day verdict (Ukrainian, names only) and let an authorized approver correct the crew + per-day bonus eligibility in the verdict thread, feeding corrections into the bonus math.

**Architecture:** Plumb the already-parsed #field-qa "Звіт" roster through `DayVerdict` to the published line as a structured suffix; add an approver-gated `field-roster` CLI that reads verdict-thread replies from the Slack mirror, classifies them via Claude, replays them onto the parsed baseline, stores the effective correction in a new `roster_corrections` table, edits the crew suffix + posts a Ukrainian ack; both `computeVerdicts` (display) and `computeBonuses` (the bonus calc) read that store.

**Tech Stack:** Next.js 16 / React 19 / TypeScript strict, Vitest, Drizzle ORM + Neon Postgres, `@anthropic-ai/sdk` (forced tool-use), Slack Web API via `lib/slack.ts`. CLIs run under `node --conditions=react-server --import tsx`.

## Global Constraints

- **EXECUTION GATE (verify before Task 1):** `npx tsc --noEmit -p tsconfig.json` must report **0 errors** and `git status` must show `lib/resolutions.ts` committed (clean). The `datasetPosted → datasetStatus` migration MUST have landed first. If `tsc` is not clean, STOP — the base is mid-refactor; do not build on it.
- **Isolate:** implement in a dedicated git worktree/branch (the verdict layer is actively edited elsewhere). Use the `superpowers:using-git-worktrees` skill.
- **Two interfaces (non-negotiable, CLAUDE.md):** every feature ships a web view AND a CLI surface over the same `lib/` logic. Pure logic lives in `lib/`; CLI shaping in `scripts/*Report.ts`.
- **server-only discipline:** modules reading `process.env` secrets / live Vimeo / Claude / DB-effects import `"server-only"`; pure + prompt + store-read modules do NOT (CLIs import them). CLIs resolve `server-only` via `--conditions=react-server`.
- **All team-facing Slack copy is Ukrainian.** Internal report JSON/CSV/web reasons stay English.
- **DRY-RUN by default** for any CLI that writes to Slack or the DB; a real write needs `--write`.
- **Idempotency:** every Slack send goes through `lib/slack.ts` (`postMessage`/`updateMessage`) with an idempotency `key` (reserve-then-send dedup).
- **TDD:** pure modules get a failing test first. After each task: run the task's tests green, then `npx tsc --noEmit` clean, then commit. Commit message footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Run a single test file: `npx vitest run <path>`. Full suite: `npx vitest run`. Typecheck: `npx tsc --noEmit -p tsconfig.json`.

---

### Task 1: `DayVerdict` carries the crew

**Files:**
- Modify: `lib/fieldDayVerdict.ts` (interface `DayVerdict`, return of `verdictForDay`)
- Modify: `lib/fieldDayVerdict.test.ts` (assert defaults)
- Modify (keep suite compiling): the `DayVerdict` literal factories in `lib/verdictPublish.test.ts`, `lib/askGaps.test.ts`, `lib/backfillPublished.test.ts`, `scripts/fieldVerdictReport.test.ts`, `scripts/fieldAskReport.test.ts`, `scripts/fieldPublishReport.test.ts`

**Interfaces:**
- Produces: `DayVerdict` now has `roster: string[]` and `unknownInitials: string[]`; `verdictForDay(input)` returns both as `[]` (the pure gate does not know the crew).

- [ ] **Step 1: Write the failing test**

In `lib/fieldDayVerdict.test.ts`, add inside `describe("verdictForDay", ...)`:

```ts
it("returns empty roster/unknownInitials (crew is attached by the orchestrator, not the gate)", () => {
  const v = verdictForDay(base);
  expect(v.roster).toEqual([]);
  expect(v.unknownInitials).toEqual([]);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run lib/fieldDayVerdict.test.ts`
Expected: FAIL — `v.roster` is `undefined` / property missing.

- [ ] **Step 3: Add the fields**

In `lib/fieldDayVerdict.ts`, extend the interface (after `reasons: string[];`):

```ts
  reasons: string[];
  /** Resolved crew names for the day (display/attribution; not part of the gate). */
  roster: string[];
  /** "Звіт" tokens that did not resolve to a name (internal surfaces only). */
  unknownInitials: string[];
```

And in the `return { ... }` of `verdictForDay`, add the two empty defaults:

```ts
  return { date: flightDate, status, airborneMinutes, videoMinutes, ratio, datasetStatus, withinGrace, reasons, roster: [], unknownInitials: [] };
```

- [ ] **Step 4: Keep the other suites compiling**

Each of the six test files has a `DayVerdict` literal (a `day(...)`/`base` factory). Add `roster: [], unknownInitials: []` to each base literal so they remain assignable to `DayVerdict`. Example — `lib/verdictPublish.test.ts`, in the `day` factory object (after `reasons: [],`):

```ts
  reasons: [],
  roster: [],
  unknownInitials: [],
```

Apply the identical two-line addition to the `DayVerdict` base literal in `lib/askGaps.test.ts`, `lib/backfillPublished.test.ts`, `scripts/fieldVerdictReport.test.ts`, `scripts/fieldAskReport.test.ts`, `scripts/fieldPublishReport.test.ts`. (Grep to find them: `grep -rln "reasons: \[\]" lib scripts`.)

- [ ] **Step 5: Run tests + typecheck — expect PASS / 0 errors**

Run: `npx vitest run lib/fieldDayVerdict.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: tests PASS; tsc 0 errors.

- [ ] **Step 6: Commit**

```bash
git add lib/fieldDayVerdict.ts lib/fieldDayVerdict.test.ts lib/verdictPublish.test.ts lib/askGaps.test.ts lib/backfillPublished.test.ts scripts/fieldVerdictReport.test.ts scripts/fieldAskReport.test.ts scripts/fieldPublishReport.test.ts
git commit -m "feat(verdict): add roster + unknownInitials to DayVerdict

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pure roster-correction model

**Files:**
- Create: `lib/rosterCorrection.ts`
- Test: `lib/rosterCorrection.test.ts`

**Interfaces:**
- Produces:
  - `interface RosterCorrection { date: string; roster?: string[]; eligibility?: Record<string, "counted" | "not_counted">; note: string; by: string; source: string; recordedAt: string }`
  - `applyRosterCorrection(parsedRoster: string[], dayCounted: boolean, correction?: RosterCorrection): { roster: string[]; perPerson: { name: string; counted: boolean }[] }`

- [ ] **Step 1: Write the failing test**

`lib/rosterCorrection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyRosterCorrection, type RosterCorrection } from "./rosterCorrection";

const c = (over: Partial<RosterCorrection>): RosterCorrection => ({
  date: "2026-06-10", note: "n", by: "Oleksandr K", source: "slack", recordedAt: "2026-06-30T00:00:00Z", ...over,
});

describe("applyRosterCorrection", () => {
  it("passes the parsed roster through when there is no correction", () => {
    const r = applyRosterCorrection(["Андріан", "Любомир"], true);
    expect(r.roster).toEqual(["Андріан", "Любомир"]);
    expect(r.perPerson).toEqual([
      { name: "Андріан", counted: true },
      { name: "Любомир", counted: true },
    ]);
  });

  it("replaces the roster when the correction sets one", () => {
    const r = applyRosterCorrection(["Андріан"], true, c({ roster: ["Тарас", "Влад"] }));
    expect(r.roster).toEqual(["Тарас", "Влад"]);
  });

  it("honours per-person eligibility over the day gate", () => {
    const r = applyRosterCorrection(["Данило", "Тарас"], true, c({ eligibility: { Данило: "not_counted" } }));
    expect(r.perPerson).toEqual([
      { name: "Данило", counted: false },
      { name: "Тарас", counted: true },
    ]);
  });

  it("force-counts a person even when the day gate failed", () => {
    const r = applyRosterCorrection(["Тарас"], false, c({ eligibility: { Тарас: "counted" } }));
    expect(r.perPerson).toEqual([{ name: "Тарас", counted: true }]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module './rosterCorrection'`)

Run: `npx vitest run lib/rosterCorrection.test.ts`

- [ ] **Step 3: Implement**

`lib/rosterCorrection.ts`:

```ts
/**
 * Pure roster-correction model. A correction (recorded by an approver in a
 * verdict thread) optionally replaces the day's crew and/or overrides who counts
 * for that day's bonus. `applyRosterCorrection` resolves the effective crew +
 * per-person counted flag against the parsed baseline. No DB/Next imports.
 */
export interface RosterCorrection {
  date: string;
  /** Authoritative crew for the day (replaces the parsed roster) when present. */
  roster?: string[];
  /** Per-person override of the day's bonus gate. */
  eligibility?: Record<string, "counted" | "not_counted">;
  note: string;
  by: string;
  source: string;
  recordedAt: string;
}

export function applyRosterCorrection(
  parsedRoster: string[],
  dayCounted: boolean,
  correction?: RosterCorrection,
): { roster: string[]; perPerson: { name: string; counted: boolean }[] } {
  const roster = correction?.roster ?? parsedRoster;
  const elig = correction?.eligibility;
  const perPerson = roster.map((name) => ({
    name,
    counted: elig?.[name] === "not_counted" ? false : elig?.[name] === "counted" ? true : dayCounted,
  }));
  return { roster, perPerson };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run lib/rosterCorrection.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/rosterCorrection.ts lib/rosterCorrection.test.ts
git commit -m "feat(roster): pure roster-correction model

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Crew suffix on the verdict message (+ disjoint override region)

**Files:**
- Modify: `lib/verdictPublish.ts` (add markers/helpers; wrap `formatDayMessage`)
- Modify: `lib/verdictPublish.test.ts` (round-trip + crew + override-disjoint tests)
- Modify: `lib/applyApproval.ts` (split crew suffix before `formatOverride`, re-append after)

**Interfaces:**
- Consumes: `DayVerdict.roster` (Task 1).
- Produces:
  - `ROSTER_MARKER = "👥 У полі: "`
  - `withRosterSuffix(body: string, roster: string[]): string` — appends `\n👥 У полі: A, B, C.`; returns `body` unchanged for an empty roster.
  - `splitRosterSuffix(text: string): { body: string; rosterLine: string | null }` — splits at the last crew marker; `rosterLine` excludes the leading newline (or `null`).
  - `formatDayMessage(day)` now ends with the crew suffix for every publishable status.

- [ ] **Step 1: Write the failing tests**

Append to `lib/verdictPublish.test.ts`:

```ts
import { ROSTER_MARKER, splitRosterSuffix, withRosterSuffix } from "./verdictPublish";

describe("crew suffix", () => {
  it("round-trips body + roster", () => {
    const body = "✅ 2026-06-13 — прийнято.";
    const text = withRosterSuffix(body, ["Андріан", "Любомир"]);
    expect(text).toBe(`${body}\n${ROSTER_MARKER}Андріан, Любомир.`);
    const split = splitRosterSuffix(text);
    expect(split.body).toBe(body);
    expect(split.rosterLine).toBe(`${ROSTER_MARKER}Андріан, Любомир.`);
  });

  it("omits the suffix for an empty roster and splits cleanly when absent", () => {
    expect(withRosterSuffix("body", [])).toBe("body");
    expect(splitRosterSuffix("body")).toEqual({ body: "body", rosterLine: null });
  });

  it("formatDayMessage appends the crew line for an ACCEPTED day", () => {
    const msg = formatDayMessage(day({ roster: ["Андріан", "Любомир"] }));
    expect(msg).toContain(`\n${ROSTER_MARKER}Андріан, Любомир.`);
  });

  it("formatDayMessage omits the crew line when roster is empty", () => {
    expect(formatDayMessage(day({ roster: [] }))).not.toContain(ROSTER_MARKER);
  });

  it("an override strike leaves the crew line intact (disjoint regions)", () => {
    // Simulate the publisher: split off crew, strike only the body, re-append crew.
    const published = withRosterSuffix("⚠️ 2026-06-04 — потрібна перевірка: …", ["Тарас"]);
    const { body, rosterLine } = splitRosterSuffix(published);
    const o = formatOverride(body, "accepted_exception", "Oleksandr K", "ми тестували");
    const result = rosterLine ? `${o.updatedText}\n${rosterLine}` : o.updatedText;
    expect(result).toContain("~⚠️ 2026-06-04 — потрібна перевірка: …~");
    expect(result).toContain(`${ROSTER_MARKER}Тарас.`);
    expect(result).not.toContain("~👥"); // crew line is NOT struck
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`ROSTER_MARKER` not exported)

Run: `npx vitest run lib/verdictPublish.test.ts`

- [ ] **Step 3: Add the helpers + wrap `formatDayMessage`**

In `lib/verdictPublish.ts`, add near the top (after the `ICON` map):

```ts
export const ROSTER_MARKER = "👥 У полі: ";

/** Append the crew suffix line. Empty roster → body unchanged. Pure. */
export function withRosterSuffix(body: string, roster: string[]): string {
  if (roster.length === 0) return body;
  return `${body}\n${ROSTER_MARKER}${roster.join(", ")}.`;
}

/** Split a published message into body + crew suffix at the last crew marker. Pure. */
export function splitRosterSuffix(text: string): { body: string; rosterLine: string | null } {
  const idx = text.lastIndexOf(`\n${ROSTER_MARKER}`);
  if (idx === -1) return { body: text, rosterLine: null };
  return { body: text.slice(0, idx), rosterLine: text.slice(idx + 1) };
}
```

Wrap the existing `formatDayMessage` body so every `return` path gets the suffix. The cleanest minimal change: rename the existing function body to compute a local `body` string, then `return withRosterSuffix(body, day.roster)`. Concretely, change the three `return \`...\`;` statements in `formatDayMessage` to assign to `const body = \`...\`;` and fall through to a single final `return withRosterSuffix(body, day.roster);`. Example for the ACCEPTED branch:

```ts
  if (day.status === "ACCEPTED") {
    const body = `✅ ${date} — прийнято (відео ${vid} хв — це ${pct} від ${air} хв у повітрі; ${ds}).`;
    return withRosterSuffix(body, day.roster);
  }
```

Do the same for the `ACCEPTED_EXCEPTION` branch and the trailing `NEEDS_REVIEW` return. (The dataset wording in `body` is whatever the migration settled on — do not change it; only wrap it.)

- [ ] **Step 4: Make the override editor crew-aware — `lib/applyApproval.ts`**

In `applyApproverDecision`, the line `const { updatedText, replyText } = formatOverride(entry.text, decision, by, reason);` must split off the crew suffix first and re-append it so the strike never covers the crew line. Replace that line with:

```ts
  const { body, rosterLine } = splitRosterSuffix(entry.text);
  const { updatedText: struck, replyText } = formatOverride(body, decision, by, reason);
  const updatedText = rosterLine ? `${struck}\n${rosterLine}` : struck;
```

Add `splitRosterSuffix` to the existing `import { formatOverride } from "./verdictPublish";` → `import { formatOverride, splitRosterSuffix } from "./verdictPublish";`.

- [ ] **Step 5: Run tests + typecheck — expect PASS / 0 errors**

Run: `npx vitest run lib/verdictPublish.test.ts && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 6: Commit**

```bash
git add lib/verdictPublish.ts lib/verdictPublish.test.ts lib/applyApproval.ts
git commit -m "feat(verdict): crew suffix on verdict messages; override edits stay disjoint from crew line

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `roster_corrections` table + store

**Files:**
- Modify: `lib/schema.ts` (new `rosterCorrections` table)
- Create: `lib/rosterCorrections.ts` (read/upsert)
- Migration: `npm run db:generate && npm run db:migrate`

**Interfaces:**
- Consumes: `RosterCorrection` (Task 2).
- Produces: `readRosterCorrections(): Promise<RosterCorrection[]>`, `upsertRosterCorrection(c: RosterCorrection): Promise<void>` (insert-or-replace on `date`).

> No unit test (DB I/O, like `lib/resolutions.ts`); the gate is `tsc` + a successful migration.

- [ ] **Step 1: Add the table to `lib/schema.ts`**

After the `resolutions` table block, add (note `jsonb` is already imported in this file):

```ts
/** Approver roster corrections, keyed by flight date (crew + per-person eligibility). */
export const rosterCorrections = pgTable("roster_corrections", {
  date: text("date").primaryKey(),
  roster: jsonb("roster"),            // string[] | null
  eligibility: jsonb("eligibility"),  // Record<name,"counted"|"not_counted"> | null
  note: text("note").notNull(),
  by: text("by").notNull(),
  source: text("source").notNull(),
  recordedAt: text("recorded_at").notNull(),
});
```

- [ ] **Step 2: Create the store `lib/rosterCorrections.ts`**

```ts
/**
 * Durable roster-correction store — approver corrections to a day's crew +
 * per-person bonus eligibility, keyed by flight date. Backed by the
 * `roster_corrections` Postgres table; read by the verdict (display) and the
 * bonus calc. NOT server-only (CLIs import it, like lib/resolutions.ts).
 */
import { db, schema } from "./db";
import type { RosterCorrection } from "./rosterCorrection";

function toCorrection(r: typeof schema.rosterCorrections.$inferSelect): RosterCorrection {
  return {
    date: r.date,
    note: r.note,
    by: r.by,
    source: r.source,
    recordedAt: r.recordedAt,
    ...(r.roster != null ? { roster: r.roster as string[] } : {}),
    ...(r.eligibility != null ? { eligibility: r.eligibility as Record<string, "counted" | "not_counted"> } : {}),
  };
}

export async function readRosterCorrections(): Promise<RosterCorrection[]> {
  const rows = await db.select().from(schema.rosterCorrections);
  return rows.map(toCorrection);
}

export async function upsertRosterCorrection(c: RosterCorrection): Promise<void> {
  const values = {
    date: c.date,
    roster: c.roster ?? null,
    eligibility: c.eligibility ?? null,
    note: c.note,
    by: c.by,
    source: c.source,
    recordedAt: c.recordedAt,
  };
  await db
    .insert(schema.rosterCorrections)
    .values(values)
    .onConflictDoUpdate({ target: schema.rosterCorrections.date, set: values });
}
```

- [ ] **Step 3: Generate + apply the migration**

Run: `npm run db:generate && npm run db:migrate`
Expected: a new `drizzle/` migration adds `roster_corrections`; migrate succeeds (requires `POSTGRES_URL`).

- [ ] **Step 4: Typecheck — expect 0 errors**

Run: `npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 5: Commit**

```bash
git add lib/schema.ts lib/rosterCorrections.ts drizzle/
git commit -m "feat(roster): roster_corrections table + store

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Claude classifier for a correction reply

**Files:**
- Create: `lib/rosterCorrectionClassifyPrompt.ts` (pure — types, tool schema, prompt)
- Create: `lib/rosterCorrectionClassify.ts` (server-only — one Messages call)
- Test: `lib/rosterCorrectionClassifyPrompt.test.ts`

**Interfaces:**
- Produces:
  - `type RosterCorrectionKind = "set_roster" | "patch" | "unclear"`
  - `interface RosterCorrectionClassification { kind: RosterCorrectionKind; roster?: string[]; add?: string[]; remove?: string[]; counted?: string[]; notCounted?: string[]; reason: string }`
  - `ROSTER_CORRECTION_TOOL: Anthropic.Tool`, `buildRosterCorrectionPrompt(verdictMessage: string, reply: string): string`
  - `classifyRosterCorrection(verdictMessage: string, reply: string): Promise<RosterCorrectionClassification>`

- [ ] **Step 1: Write the failing test** (`lib/rosterCorrectionClassifyPrompt.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { ROSTER_CORRECTION_TOOL, buildRosterCorrectionPrompt } from "./rosterCorrectionClassifyPrompt";

describe("rosterCorrectionClassifyPrompt", () => {
  it("includes the verdict and the reply", () => {
    const p = buildRosterCorrectionPrompt("✅ 2026-06-13 — прийнято.\n👥 У полі: Андріан.", "насправді були Тарас і Влад");
    expect(p).toContain("Андріан");
    expect(p).toContain("насправді були Тарас і Влад");
  });

  it("exposes the structured tool with kind + crew/eligibility arrays", () => {
    const props = ROSTER_CORRECTION_TOOL.input_schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["kind", "roster", "add", "remove", "counted", "notCounted", "reason"]),
    );
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run lib/rosterCorrectionClassifyPrompt.test.ts`

- [ ] **Step 3: Implement the prompt module** (`lib/rosterCorrectionClassifyPrompt.ts`)

```ts
/**
 * Pure prompt + tool schema for classifying an approver's verdict-thread reply
 * into a roster correction. Two intents: set_roster (authoritative crew) and
 * patch (add/remove a person, or count/don't-count a person for the bonus).
 * Server-only-free so it unit-tests (mirrors lib/approvalClassifyPrompt.ts).
 */
import type Anthropic from "@anthropic-ai/sdk";

export type RosterCorrectionKind = "set_roster" | "patch" | "unclear";

export interface RosterCorrectionClassification {
  kind: RosterCorrectionKind;
  roster?: string[];      // set_roster: the full authoritative crew
  add?: string[];         // patch: add to the crew
  remove?: string[];      // patch: remove from the crew
  counted?: string[];     // patch: count this person for the bonus this day
  notCounted?: string[];  // patch: do NOT count this person this day (stays on the crew)
  reason: string;
}

export const ROSTER_CORRECTION_TOOL: Anthropic.Tool = {
  name: "classify_roster_correction",
  description:
    "Classify an approver's reply correcting who was in the field on a flight day, and/or who should count for that day's bonus.",
  input_schema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["set_roster", "patch", "unclear"],
        description:
          "set_roster = the reply states the full crew (replace the list); " +
          "patch = add/remove a person, or count/don't-count a person; " +
          "unclear = not a roster/eligibility correction",
      },
      roster: { type: "array", items: { type: "string" }, description: "set_roster: full crew, names or initials" },
      add: { type: "array", items: { type: "string" }, description: "patch: people to add to the crew" },
      remove: { type: "array", items: { type: "string" }, description: "patch: people to remove from the crew" },
      counted: { type: "array", items: { type: "string" }, description: "patch: people to COUNT for the bonus this day" },
      notCounted: { type: "array", items: { type: "string" }, description: "patch: people NOT to count this day (kept on crew)" },
      reason: { type: "string", description: "Short factual summary of the correction" },
    },
    required: ["kind", "reason"],
  },
};

export function buildRosterCorrectionPrompt(verdictMessage: string, reply: string): string {
  return [
    `You are reconciling a drone field-ops bonus. The bot posted a per-day verdict that lists`,
    `the crew ("👥 У полі: …"), and an AUTHORIZED approver replied in the thread to correct it.`,
    `Decide the correction, then call classify_roster_correction.`,
    ``,
    `BOT VERDICT MESSAGE:`,
    verdictMessage,
    ``,
    `APPROVER REPLY:`,
    reply,
    ``,
    `Guidance (Ukrainian or English):`,
    `- set_roster: states the whole crew ("були А, Б, В", "склад: Тарас, Влад") → roster=[…].`,
    `- patch add/remove: "додай Тараса" → add=["Тарас"]; "прибери Влада"/"Влада не було" → remove=["Влад"].`,
    `- patch eligibility: "Данило не рахується цього дня" → notCounted=["Данило"]; "Тарасу зарахуй" → counted=["Тарас"].`,
    `- unclear: a question or comment that doesn't change the crew or eligibility.`,
    `Return people as written (names or single-initial); the caller resolves initials. Return only the tool call.`,
  ].join("\n");
}
```

- [ ] **Step 4: Implement the server-only classifier** (`lib/rosterCorrectionClassify.ts`)

```ts
/**
 * Classify an approver's roster-correction reply via Claude. SERVER-ONLY
 * (reads ANTHROPIC_API_KEY). One Messages call, forced tool-use. Mirrors
 * lib/approvalClassify.ts.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  ROSTER_CORRECTION_TOOL,
  buildRosterCorrectionPrompt,
  type RosterCorrectionClassification,
  type RosterCorrectionKind,
} from "./rosterCorrectionClassifyPrompt";

const MODEL = "claude-sonnet-4-6";
const VALID: RosterCorrectionKind[] = ["set_roster", "patch", "unclear"];

export class RosterCorrectionClassifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RosterCorrectionClassifyError";
  }
}

const arr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined;

export async function classifyRosterCorrection(
  verdictMessage: string,
  reply: string,
): Promise<RosterCorrectionClassification> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new RosterCorrectionClassifyError("ANTHROPIC_API_KEY is not set on the server.");
  }
  const client = new Anthropic();
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      tools: [ROSTER_CORRECTION_TOOL],
      tool_choice: { type: "tool", name: ROSTER_CORRECTION_TOOL.name },
      messages: [{ role: "user", content: buildRosterCorrectionPrompt(verdictMessage, reply) }],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RosterCorrectionClassifyError(`Claude request failed: ${detail}`);
  }
  if (message.stop_reason === "refusal") throw new RosterCorrectionClassifyError("Claude declined the classification.");
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new RosterCorrectionClassifyError("Claude returned no tool_use block.");
  const input = toolUse.input as Partial<RosterCorrectionClassification>;
  const kind: RosterCorrectionKind = VALID.includes(input.kind as RosterCorrectionKind)
    ? (input.kind as RosterCorrectionKind)
    : "unclear";
  return {
    kind,
    roster: arr(input.roster),
    add: arr(input.add),
    remove: arr(input.remove),
    counted: arr(input.counted),
    notCounted: arr(input.notCounted),
    reason: String(input.reason ?? ""),
  };
}
```

- [ ] **Step 5: Run test + typecheck — expect PASS / 0 errors**

Run: `npx vitest run lib/rosterCorrectionClassifyPrompt.test.ts && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 6: Commit**

```bash
git add lib/rosterCorrectionClassifyPrompt.ts lib/rosterCorrectionClassify.ts lib/rosterCorrectionClassifyPrompt.test.ts
git commit -m "feat(roster): Claude classifier for roster-correction replies

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: CLI shaping — args, period, replay/decide

**Files:**
- Create: `scripts/fieldRosterReport.ts` (pure)
- Test: `scripts/fieldRosterReport.test.ts`

**Interfaces:**
- Consumes: `RosterCorrectionClassification` (Task 5), `RosterCorrection` (Task 2).
- Produces:
  - `interface RosterArgs { start?: string; end?: string; write: boolean }`, `parseArgs(argv)`, `resolvePeriod(args, today)`, `interface Period { start: string; end: string }`
  - `interface ClassifiedRosterReply { classification: RosterCorrectionClassification; by: string; permalink: string; ts: string }`
  - `decideRosterCorrection(parsedRoster: string[], replies: ClassifiedRosterReply[]): { roster: string[]; eligibility: Record<string, "counted" | "not_counted">; note: string; by: string; evidencePermalink: string } | null`

> Names in `replies` are assumed already alias-resolved by the CLI (Task 8) before reaching `decide`, so this stays pure.

- [ ] **Step 1: Write the failing test** (`scripts/fieldRosterReport.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { decideRosterCorrection, parseArgs, resolvePeriod, type ClassifiedRosterReply } from "./fieldRosterReport";

const reply = (over: Partial<ClassifiedRosterReply> & { kind: ClassifiedRosterReply["classification"]["kind"] }): ClassifiedRosterReply => ({
  by: "Oleksandr K", permalink: "p", ts: over.ts ?? "1",
  classification: { kind: over.kind, reason: "r", roster: over.classification?.roster, add: over.classification?.add, remove: over.classification?.remove, counted: over.classification?.counted, notCounted: over.classification?.notCounted },
} as ClassifiedRosterReply);

describe("parseArgs / resolvePeriod", () => {
  it("defaults to the current month and parses --write", () => {
    expect(parseArgs(["--write"]).write).toBe(true);
    expect(resolvePeriod(parseArgs([]), "2026-06-30")).toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });
});

describe("decideRosterCorrection", () => {
  it("returns null when there is no decisive reply", () => {
    expect(decideRosterCorrection(["Андріан"], [reply({ kind: "unclear" })])).toBeNull();
  });

  it("set_roster replaces the crew", () => {
    const out = decideRosterCorrection(["Андріан"], [
      { ...reply({ kind: "set_roster" }), classification: { kind: "set_roster", roster: ["Тарас", "Влад"], reason: "r" } },
    ]);
    expect(out?.roster).toEqual(["Тарас", "Влад"]);
  });

  it("patch add/remove and eligibility replay in ts order", () => {
    const out = decideRosterCorrection(["Андріан", "Любомир"], [
      { ...reply({ kind: "patch", ts: "1" }), classification: { kind: "patch", remove: ["Любомир"], reason: "r" } },
      { ...reply({ kind: "patch", ts: "2" }), classification: { kind: "patch", add: ["Тарас"], notCounted: ["Андріан"], reason: "r" } },
    ]);
    expect(out?.roster).toEqual(["Андріан", "Тарас"]);
    expect(out?.eligibility).toEqual({ Андріан: "not_counted" });
  });

  it("force-count adds the person to the crew", () => {
    const out = decideRosterCorrection([], [
      { ...reply({ kind: "patch" }), classification: { kind: "patch", counted: ["Тарас"], reason: "r" } },
    ]);
    expect(out?.roster).toEqual(["Тарас"]);
    expect(out?.eligibility).toEqual({ Тарас: "counted" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run scripts/fieldRosterReport.test.ts`

- [ ] **Step 3: Implement** (`scripts/fieldRosterReport.ts`)

```ts
/**
 * Pure CLI shaping for `field-roster`: arg parsing, period resolution, and the
 * replay that turns an approver's classified thread replies into one effective
 * roster correction. No server/Next/fs imports — unit-tested. Names are assumed
 * already alias-resolved by the CLI before they reach decideRosterCorrection.
 */
import type { RosterCorrectionClassification } from "../lib/rosterCorrectionClassifyPrompt";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Period { start: string; end: string }
export interface RosterArgs { start?: string; end?: string; write: boolean }

export interface ClassifiedRosterReply {
  classification: RosterCorrectionClassification;
  by: string;
  permalink: string;
  ts: string;
}

export interface RosterOutcome {
  roster: string[];
  eligibility: Record<string, "counted" | "not_counted">;
  note: string;
  by: string;
  evidencePermalink: string;
}

export function parseArgs(argv: string[]): RosterArgs {
  const args: RosterArgs = { write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") { args.start = value; i += 1; }
    else if (flag === "--end") { args.end = value; i += 1; }
    else if (flag === "--write") { args.write = true; }
  }
  return args;
}

export function defaultMonthWindow(today: string): Period {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

export function resolvePeriod(args: RosterArgs, today: string): Period {
  let start = args.start;
  let end = args.end;
  if (!start || !end) ({ start, end } = defaultMonthWindow(today));
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }
  return { start, end };
}

/**
 * Replay decisive replies (ts order) onto the parsed baseline. set_roster
 * replaces the crew; patch applies add/remove (membership) and counted/notCounted
 * (eligibility). `unclear` is skipped. note/by/evidence come from the LAST
 * decisive reply. Returns null when nothing decisive applies.
 */
export function decideRosterCorrection(
  parsedRoster: string[],
  replies: ClassifiedRosterReply[],
): RosterOutcome | null {
  const decisive = replies
    .filter((r) => r.classification.kind !== "unclear")
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (decisive.length === 0) return null;

  let roster = [...parsedRoster];
  const eligibility: Record<string, "counted" | "not_counted"> = {};
  const addName = (n: string) => { if (!roster.includes(n)) roster.push(n); };

  for (const r of decisive) {
    const c = r.classification;
    if (c.kind === "set_roster" && c.roster) {
      roster = [...new Set(c.roster)];
      for (const k of Object.keys(eligibility)) if (!roster.includes(k)) delete eligibility[k];
      continue;
    }
    // patch
    for (const a of c.add ?? []) addName(a);
    for (const rm of c.remove ?? []) { roster = roster.filter((x) => x !== rm); delete eligibility[rm]; }
    for (const n of c.counted ?? []) { eligibility[n] = "counted"; addName(n); }
    for (const n of c.notCounted ?? []) eligibility[n] = "not_counted";
  }

  const last = decisive[decisive.length - 1];
  return { roster, eligibility, note: last.classification.reason, by: last.by, evidencePermalink: last.permalink };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run scripts/fieldRosterReport.test.ts`

- [ ] **Step 5: Commit**

```bash
git add scripts/fieldRosterReport.ts scripts/fieldRosterReport.test.ts
git commit -m "feat(roster): field-roster CLI shaping + correction replay

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Outbound keys + the correction effect

**Files:**
- Modify: `lib/outboundKeys.ts` (+ `rosterEditKey`, `rosterAckKey`)
- Modify: `lib/outboundKeys.test.ts` (key format) — if the file does not exist, create it with the two assertions below
- Create: `lib/applyRosterCorrection.ts` (server-only effect)

**Interfaces:**
- Consumes: `RosterOutcome` (Task 6), `PublishedEntry` (`lib/published.ts`), `splitRosterSuffix`/`withRosterSuffix` (Task 3), `upsertRosterCorrection` (Task 4), `contentRev` (`lib/outboundKeys.ts`), `TRACKED_CHANNELS` (`lib/slackChannels.ts`), `updateMessage`/`postMessage` (`lib/slack.ts`).
- Produces:
  - `rosterEditKey(date, rev)`, `rosterAckKey(date, rev)` in `lib/outboundKeys.ts`
  - `applyRosterDecision(args: { entry: PublishedEntry; period: Period; outcome: RosterOutcome; trigger?: SendTrigger }): Promise<{ applied: boolean }>`

- [ ] **Step 1: Write the failing key test** (`lib/outboundKeys.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { rosterAckKey, rosterEditKey } from "./outboundKeys";

describe("roster outbound keys", () => {
  it("namespaces edit + ack by date and rev", () => {
    expect(rosterEditKey("2026-06-10", "abc")).toBe("roster-edit:2026-06-10:abc");
    expect(rosterAckKey("2026-06-10", "abc")).toBe("roster-ack:2026-06-10:abc");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run lib/outboundKeys.test.ts`

- [ ] **Step 3: Add the keys** (`lib/outboundKeys.ts`, after `backfillEditKey`)

```ts
export const rosterEditKey = (date: string, rev: string): string =>
  `roster-edit:${date}:${rev}`;
export const rosterAckKey = (date: string, rev: string): string =>
  `roster-ack:${date}:${rev}`;
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run lib/outboundKeys.test.ts`

- [ ] **Step 5: Implement the effect** (`lib/applyRosterCorrection.ts`)

```ts
/**
 * Shared effect: apply an approver's roster correction to a published verdict.
 * SERVER-ONLY (writes to Slack + DB). Upserts the correction, edits ONLY the
 * crew suffix of the verdict message (leaving any override amendment in the body
 * intact), and posts a Ukrainian threaded ack. Idempotent via content-rev keys.
 * Mirrors lib/applyApproval.ts. Callable by the field-roster CLI (and later the
 * events webhook).
 */
import "server-only";
import { postMessage, updateMessage } from "./slack";
import { contentRev, rosterAckKey, rosterEditKey, type SendTrigger } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { writePublished, type PublishedEntry } from "./published";
import { upsertRosterCorrection } from "./rosterCorrections";
import { splitRosterSuffix, withRosterSuffix } from "./verdictPublish";
import type { RosterOutcome } from "../scripts/fieldRosterReport";
import type { Period } from "./period";

export async function applyRosterDecision(args: {
  entry: PublishedEntry;
  period: Period;
  outcome: RosterOutcome;
  trigger?: SendTrigger;
}): Promise<{ applied: boolean }> {
  const { entry, period, outcome, trigger = "unknown" } = args;

  await upsertRosterCorrection({
    date: entry.date,
    ...(outcome.roster.length ? { roster: outcome.roster } : {}),
    ...(Object.keys(outcome.eligibility).length ? { eligibility: outcome.eligibility } : {}),
    note: outcome.note,
    by: outcome.by,
    source: outcome.evidencePermalink || "slack",
    recordedAt: new Date().toISOString(),
  });

  const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
  if (!channel) return { applied: false };

  // Edit ONLY the crew suffix; keep the body (incl. any override strike) intact.
  const { body } = splitRosterSuffix(entry.text);
  const updatedText = withRosterSuffix(body, outcome.roster);
  if (updatedText === entry.text) return { applied: false }; // suffix already current

  await updateMessage(channel.id, entry.ts, updatedText, {
    key: rosterEditKey(entry.date, contentRev(updatedText)),
    feature: "roster",
    channel: channel.name,
    trigger,
  });

  const notCounted = Object.entries(outcome.eligibility).filter(([, v]) => v === "not_counted").map(([n]) => n);
  const tail = notCounted.length ? ` (не рахується: ${notCounted.join(", ")})` : "";
  const replyText = `👥 Зафіксовано склад: ${outcome.roster.join(", ")}${tail} — ${outcome.by}.`;
  await postMessage(
    channel.id,
    replyText,
    { key: rosterAckKey(entry.date, contentRev(replyText)), feature: "roster", channel: channel.name, trigger },
    entry.ts,
  );

  await writePublished(period, { [entry.date]: { ...entry, text: updatedText } });
  return { applied: true };
}
```

> Note: `postMessage`/`updateMessage` `meta.feature` is a free-text string column — `"roster"` is a new value, no enum change needed in `lib/slack.ts`. Confirm the `SendMeta` type accepts an arbitrary `feature: string` (it does — same call site as `"approval"`).

- [ ] **Step 6: Typecheck — expect 0 errors**

Run: `npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 7: Commit**

```bash
git add lib/outboundKeys.ts lib/outboundKeys.test.ts lib/applyRosterCorrection.ts
git commit -m "feat(roster): correction effect (edit crew suffix + ack) + outbound keys

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The `field-roster` CLI

**Files:**
- Create: `scripts/field-roster.ts`
- Modify: `package.json` (`"field-roster"` script)

**Interfaces:**
- Consumes: everything above + `readPublished` (`lib/published.ts`), `readChannelMessages` (`lib/slackMirror.ts`), `approverFor` (`lib/approvers.ts`), `parseMonth` (`lib/fieldReports.ts`), `readAliases`/`mergeAliases` (`lib/rosterAliases.ts`), `SEED_ALIASES`/`resolveInitial` (`lib/fieldRoster.ts`), `classifyRosterCorrection` (Task 5), `applyRosterDecision` (Task 7).

> No unit test (top-level orchestration, like `scripts/field-approvals.ts`); gate = `tsc` clean + a dry-run smoke run.

- [ ] **Step 1: Add the npm script** (`package.json`, after the `field-approvals` line)

```json
    "field-roster": "node --conditions=react-server --import tsx scripts/field-roster.ts",
```

- [ ] **Step 2: Implement the CLI** (`scripts/field-roster.ts`)

```ts
/**
 * CLI: ingest AUTHORIZED approvers' in-thread roster corrections to published
 * verdicts — DRY-RUN BY DEFAULT. For each posted verdict it reads the threaded
 * replies from the Slack mirror, keeps only approver replies (lib/approvers),
 * classifies each as a roster/eligibility correction via Claude, resolves names
 * via the alias map, replays them onto the parsed "Звіт" roster, and (with
 * --write) edits the crew suffix + posts a Ukrainian ack and records the
 * correction. The next field-verdict + field-bonus runs reflect it.
 *
 * Usage:
 *   npm run field-roster -- --start 2026-06-01 --end 2026-06-19          # dry-run
 *   npm run field-roster -- --start … --end … --write                   # apply
 * Defaults to the current Europe/Kyiv month. Run `npm run slack-sync` first.
 * Classification needs ANTHROPIC_API_KEY. Runs under --conditions=react-server.
 */
import { classifyRosterCorrection } from "../lib/rosterCorrectionClassify";
import { approverFor } from "../lib/approvers";
import { applyRosterDecision } from "../lib/applyRosterCorrection";
import { readChannelMessages } from "../lib/slackMirror";
import { readPublished } from "../lib/published";
import { parseMonth } from "../lib/fieldReports";
import { readAliases, mergeAliases } from "../lib/rosterAliases";
import { SEED_ALIASES, resolveInitial } from "../lib/fieldRoster";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import {
  decideRosterCorrection,
  parseArgs,
  resolvePeriod,
  type ClassifiedRosterReply,
  type Period,
} from "./fieldRosterReport";

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// Resolve initials/short tokens to canonical names (same map as parseZvit).
function resolveNames(tokens: string[] | undefined, aliases: Record<string, string>): string[] | undefined {
  if (!tokens) return undefined;
  return tokens.map((t) => {
    const r = resolveInitial(t, aliases);
    return "name" in r ? r.name : r.unknown;
  });
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }

  const args = parseArgs(process.argv.slice(2));
  const today = todayInFieldTz();
  const period: Period = resolvePeriod(args, today);

  const published = await readPublished(period);
  const entries = Object.values(published);
  if (entries.length === 0) {
    process.stderr.write(`field-roster: no published verdicts for ${period.start}…${period.end} (run \`npm run field-publish --publish\` first).\n`);
    return;
  }

  const aliases = mergeAliases(SEED_ALIASES, await readAliases());
  const readWindow = { start: period.start, end: today > period.end ? today : period.end };

  // Parsed baseline crew per flight day, from the #field-qa "Звіт" reports.
  const fieldQaMessages = (await readChannelMessages("field-qa", readWindow)).filter((m) => !m.deleted);
  const parsedByDate = new Map(parseMonth(fieldQaMessages, aliases).map((r) => [r.flightDate, r.roster]));

  let applied = 0;
  for (const entry of entries) {
    const replies = (await readChannelMessages(entry.channel, readWindow)).filter(
      (m) => m.thread_ts === entry.ts && m.ts !== entry.ts && !m.deleted,
    );
    if (replies.length === 0) continue;

    const classified: ClassifiedRosterReply[] = [];
    for (const r of replies) {
      const approver = approverFor(r.authorId);
      if (!approver) { console.log(`• ${entry.date} — ignoring reply from non-approver ${r.author}.`); continue; }
      const c = await classifyRosterCorrection(entry.text, r.text);
      // Resolve any initials in the classifier's people arrays to canonical names.
      const resolved = {
        ...c,
        roster: resolveNames(c.roster, aliases),
        add: resolveNames(c.add, aliases),
        remove: resolveNames(c.remove, aliases),
        counted: resolveNames(c.counted, aliases),
        notCounted: resolveNames(c.notCounted, aliases),
      };
      classified.push({ classification: resolved, by: approver.name, permalink: r.permalink, ts: r.ts });
      console.log(`• ${entry.date} ← ${approver.name}: "${r.text.slice(0, 80)}" → ${c.kind}`);
    }

    const outcome = decideRosterCorrection(parsedByDate.get(entry.date) ?? [], classified);
    if (!outcome) continue;

    console.log(`  ⇒ ${args.write ? "applying" : "would apply"}: ${entry.date} → crew [${outcome.roster.join(", ")}]` +
      (Object.keys(outcome.eligibility).length ? ` elig ${JSON.stringify(outcome.eligibility)}` : "") + ` by ${outcome.by}`);

    if (args.write) {
      const result = await applyRosterDecision({ entry, period, outcome, trigger: "cli" });
      if (result.applied) { process.stderr.write(`field-roster: amended crew for ${entry.date} in #${entry.channel}.\n`); applied += 1; }
      else process.stderr.write(`field-roster: ${entry.date} — recorded correction but crew suffix unchanged / channel not tracked.\n`);
    }
  }

  if (args.write) process.stderr.write(`field-roster: applied ${applied} correction(s). Re-run \`npm run field-verdict -- --write\` and \`npm run field-bonus\` to reflect them.\n`);
  else process.stderr.write("field-roster: DRY RUN — nothing written. Re-run with --write to apply.\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-roster: ${message}\n`);
  process.exit(1);
});
```

- [ ] **Step 3: Typecheck + dry-run smoke**

Run: `npx tsc --noEmit -p tsconfig.json`
Then (needs `POSTGRES_URL` + a synced mirror + published verdicts; safe — dry-run writes nothing):
`npm run field-roster -- --start 2026-06-01 --end 2026-06-30`
Expected: prints classifications + "DRY RUN — nothing written" (or "no published verdicts …").

- [ ] **Step 4: Commit**

```bash
git add scripts/field-roster.ts package.json
git commit -m "feat(roster): field-roster CLI (dry-run default, approver-gated)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Attach + correct the crew in `computeVerdicts`

**Files:**
- Modify: `lib/computeVerdicts.ts`

**Interfaces:**
- Consumes: `parseMonth`, `readAliases`/`mergeAliases`, `SEED_ALIASES`, `readRosterCorrections`, `applyRosterCorrection`.
- Produces: each `DayVerdict` in the report now has the effective `roster` + `unknownInitials`.

> No unit test (server-only orchestration); gate = `tsc` clean. The crew shows up in the committed `field-verdict` JSON consumed by Task 11's table/web.

- [ ] **Step 1: Add imports** (top of `lib/computeVerdicts.ts`)

```ts
import { parseMonth } from "./fieldReports";
import { readAliases, mergeAliases } from "./rosterAliases";
import { SEED_ALIASES } from "./fieldRoster";
import { readRosterCorrections } from "./rosterCorrections";
import { applyRosterCorrection } from "./rosterCorrection";
```

- [ ] **Step 2: Build the parsed-roster + corrections maps** (inside `computeVerdicts`, after step "4. Resolutions")

```ts
  // 5. Crew per flight day — parsed from the #field-qa "Звіт" reports + corrections.
  const aliases = mergeAliases(SEED_ALIASES, await readAliases());
  const fieldQaMessages = (await readChannelMessages("field-qa", period)).filter((m) => !m.deleted);
  const parsedByDate = new Map(parseMonth(fieldQaMessages, aliases).map((r) => [r.flightDate, r]));
  const corrections = await readRosterCorrections();
```

- [ ] **Step 3: Attach the effective crew** (in the `flightDates.map(...)` callback, replace the final `return applyResolution(base, resolutions);`)

```ts
    const resolved = applyResolution(base, resolutions);
    const parsed = parsedByDate.get(date);
    const eff = applyRosterCorrection(parsed?.roster ?? [], true, corrections.find((c) => c.date === date));
    return { ...resolved, roster: eff.roster, unknownInitials: parsed?.unknownInitials ?? [] };
```

- [ ] **Step 4: Typecheck — expect 0 errors**

Run: `npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 5: Commit**

```bash
git add lib/computeVerdicts.ts
git commit -m "feat(verdict): attach effective crew (parsed Звіт + corrections) to each day

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Corrections flow into the bonus math

**Files:**
- Modify: `lib/fieldBonus.ts` (`computeBonuses` input + per-day apply)
- Modify: `lib/fieldBonus.test.ts` (new cases)
- Modify: `lib/computeBonuses.ts` (read + pass corrections)

**Interfaces:**
- Consumes: `RosterCorrection`, `applyRosterCorrection` (Task 2), `readRosterCorrections` (Task 4).
- Produces: `computeBonuses` accepts an optional `corrections?: RosterCorrection[]`; effective crew + per-person counted drive `DayBonus.roster` and the per-person tally.

- [ ] **Step 1: Write the failing tests** (append to `lib/fieldBonus.test.ts`)

```ts
import type { RosterCorrection } from "./rosterCorrection";

describe("computeBonuses with roster corrections", () => {
  const period = { start: "2026-06-01", end: "2026-06-30" };
  // One qualifying day (deploy ≥ 180m, video ≥ 2m): both crew get a trip.
  const reports = [
    { flightDate: "2026-06-10", roster: ["Андріан", "Любомир"], unknownInitials: [], start: "08:00", end: "12:00", deployMin: 240, crashText: null, permalink: "p", threadTs: "t" },
  ];
  const videoMinutesByDate = { "2026-06-10": 30 };

  it("uses a corrected crew", () => {
    const corr: RosterCorrection[] = [{ date: "2026-06-10", roster: ["Тарас"], note: "n", by: "Oleksandr K", source: "s", recordedAt: "r" }];
    const r = computeBonuses({ period, reports, videoMinutesByDate, losses: [], corrections: corr });
    expect(r.people.map((p) => p.name)).toEqual(["Тарас"]);
  });

  it("drops a person marked not_counted from the tally", () => {
    const corr: RosterCorrection[] = [{ date: "2026-06-10", eligibility: { Любомир: "not_counted" }, note: "n", by: "Oleksandr K", source: "s", recordedAt: "r" }];
    const r = computeBonuses({ period, reports, videoMinutesByDate, losses: [], corrections: corr });
    expect(r.people.map((p) => p.name)).toEqual(["Андріан"]);
  });

  it("works unchanged when no corrections are passed", () => {
    const r = computeBonuses({ period, reports, videoMinutesByDate, losses: [] });
    expect(r.people.map((p) => p.name).sort()).toEqual(["Андріан", "Любомир"]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`corrections` not in input type / ignored)

Run: `npx vitest run lib/fieldBonus.test.ts`

- [ ] **Step 3: Thread corrections through `computeBonuses`** (`lib/fieldBonus.ts`)

Add the import and extend the input + per-day loop:

```ts
import { applyRosterCorrection, type RosterCorrection } from "./rosterCorrection";
```

Change the signature input to include `corrections?: RosterCorrection[];`:

```ts
export function computeBonuses(input: {
  period: Period;
  reports: FieldReport[];
  videoMinutesByDate: Record<string, number>;
  losses: LossRecord[];
  corrections?: RosterCorrection[];
}): BonusReport {
  const { period, reports, videoMinutesByDate, losses, corrections = [] } = input;
```

In the `for (const r of reports)` loop, after `const counted = hoursOk && videoOk;`, compute the effective crew and store it on the day:

```ts
    const eff = applyRosterCorrection(r.roster, counted, corrections.find((c) => c.date === r.flightDate));
```

Change the `days.push({...})` to use the effective roster:

```ts
    days.push({ date: r.flightDate, roster: eff.roster, deployMin: r.deployMin, videoMin, counted, early, weekend, reason });
```

Replace the per-person tally loop (`for (const d of days) { if (!d.counted) continue; for (const name of d.roster) {...} }`) so it honours per-person eligibility. Recompute the effective per-person flags from the same corrections:

```ts
  // Per-person tallies — honour per-person eligibility overrides.
  const tally = new Map<string, { trips: number; early: number; weekend: number; dates: string[] }>();
  for (const d of days) {
    const eff = applyRosterCorrection(d.roster, d.counted, corrections.find((c) => c.date === d.date));
    for (const { name, counted } of eff.perPerson) {
      if (!counted) continue;
      const t = tally.get(name) ?? { trips: 0, early: 0, weekend: 0, dates: [] };
      t.trips += 1; if (d.early) t.early += 1; if (d.weekend) t.weekend += 1; t.dates.push(d.date);
      tally.set(name, t);
    }
  }
```

> The flight-group / loss-penalty logic keeps using `d.counted` + `d.roster` (now the effective crew) — group-level penalties are unchanged by per-person eligibility, which is acceptable for v1.

- [ ] **Step 4: Read + pass corrections in the orchestrator** (`lib/computeBonuses.ts`)

Add the import and the read, then pass into `computeBonuses`:

```ts
import { readRosterCorrections } from "./rosterCorrections";
```

```ts
  const corrections = await readRosterCorrections();
  const report = computeBonuses({ period, reports, videoMinutesByDate, losses, corrections });
```

- [ ] **Step 5: Run tests + typecheck — expect PASS / 0 errors**

Run: `npx vitest run lib/fieldBonus.test.ts && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 6: Commit**

```bash
git add lib/fieldBonus.ts lib/fieldBonus.test.ts lib/computeBonuses.ts
git commit -m "feat(bonus): roster corrections drive the per-person tally

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Surfaces — CLI table, web crew column, Outbound filter, docs

**Files:**
- Modify: `scripts/fieldVerdictReport.ts` (table crew column; CSV roster column)
- Modify: `scripts/fieldVerdictReport.test.ts` (assert crew renders)
- Modify: `app/(dashboard)/field-verdict/page.tsx` (Crew column)
- Modify: the Outbound tab feature filter (`app/(dashboard)/sent/page.tsx` and/or `lib/sentLog.ts`) if it hardcodes a feature list — add `"roster"`
- Create: `.claude/skills/field-roster/SKILL.md`
- Modify: `CLAUDE.md` (Commands bullet)

**Interfaces:**
- Consumes: `DayVerdict.roster` / `.unknownInitials`.

- [ ] **Step 1: Write the failing table test** (append to `scripts/fieldVerdictReport.test.ts`)

```ts
it("renders the crew (and ? for unknown initials) in the table", () => {
  const report = buildReport(
    [{ date: "2026-06-10", status: "ACCEPTED", airborneMinutes: 30, videoMinutes: 40, ratio: 40 / 30, datasetStatus: "POSTED", withinGrace: false, reasons: [], roster: ["Андріан"], unknownInitials: ["Ж"] }],
    { start: "2026-06-01", end: "2026-06-30" }, "2026-06-30", 3,
  );
  const table = formatTable(report);
  expect(table).toContain("Андріан");
  expect(table).toContain("?Ж");
});
```

(Confirm `formatTable`/`buildReport` are imported at the top of the test file; add them if not.)

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run scripts/fieldVerdictReport.test.ts`

- [ ] **Step 3: Add the crew column to the table + CSV** (`scripts/fieldVerdictReport.ts`)

In `formatTable`, append a `Crew` column. Add `  Crew` to the header + ruler lines, and to each row append the crew string:

```ts
      const crew = [...d.roster, ...d.unknownInitials.map((u) => `?${u}`)].join(", ");
      lines.push(
        `${d.date}   ${((STATUS_ICON[d.status] ?? "") + " " + d.status).padEnd(18)}   ${String(d.airborneMinutes).padStart(6)}  ${String(d.videoMinutes).padStart(6)}  ${(d.ratio === null ? "—" : d.ratio.toFixed(2)).padStart(5)}  ${d.datasetStatus.padEnd(8)}  ${d.reasons.join("; ")}  ${crew}`,
      );
```

(Match the header/ruler to whatever the post-migration dataset column became; the key addition is the trailing `Crew` value.) In `toCsv`, add a `roster` column: append `,roster` to the header line and `csvField(d.roster.join("; "))` to each row.

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run scripts/fieldVerdictReport.test.ts`

- [ ] **Step 5: Add the Crew column to the web table** (`app/(dashboard)/field-verdict/page.tsx`)

Add a header cell after `Reasons` and bump the empty-state `colSpan` from `7` to `8`:

```tsx
                <th className="px-3 py-2">Reasons</th>
                <th className="px-3 py-2">Crew</th>
```

```tsx
                  <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
```

And a body cell after the Reasons `<td>`:

```tsx
                      <td className="px-3 py-2 text-slate-700">
                        {[...d.roster, ...d.unknownInitials.map((u) => `?${u}`)].join(", ") || "—"}
                      </td>
```

- [ ] **Step 6: Outbound feature filter** — inspect the Outbound tab. Run `grep -n "feature" app/(dashboard)/sent/page.tsx lib/sentLog.ts`. The `feature` column is free-text (`lib/sentLog.ts` types it `feature: string`), so a hardcoded filter list is the only thing to touch. If `app/(dashboard)/sent/page.tsx` builds a fixed dropdown of feature names, add `"roster"`; if it derives the list from the data, no change is needed. Make the minimal edit (or none) accordingly.

- [ ] **Step 7: Create the skill** (`.claude/skills/field-roster/SKILL.md`)

```markdown
---
name: field-roster
description: Use when answering "who was in the field on day X" or correcting a flight day's crew / per-person bonus eligibility from an approver's verdict-thread reply.
---

# Field roster (crew display + approver corrections)

The crew per flight day comes from the #field-qa "Звіт" reports (`lib/fieldReports.ts`),
shown on each published verdict line as `👥 У полі: …` and in `npm run field-verdict`.

To correct a day's crew or who counts for the bonus, an **authorized approver**
(`lib/approvers.ts`) replies in the verdict thread; ingest it with:

- `npm run field-roster -- --start YYYY-MM-DD --end YYYY-MM-DD` — DRY-RUN (prints what it would change)
- add `--write` to record the correction, edit the crew suffix, and post a Ukrainian ack

Corrections live in the `roster_corrections` table and flow into both
`npm run field-verdict` (display) and `npm run field-bonus` (the tally).
Run `npm run slack-sync` first; classification needs `ANTHROPIC_API_KEY`.
```

- [ ] **Step 8: Document the command** (`CLAUDE.md`, in the Commands list after the `field-approvals` bullet)

```markdown
- `npm run field-roster -- --start YYYY-MM-DD --end YYYY-MM-DD [--write]` — apply **authorized approver** crew corrections. Reads each published verdict's thread replies (Slack mirror), keeps only approver replies (`lib/approvers.ts`), classifies each via Claude into a roster/eligibility correction, replays them onto the parsed #field-qa "Звіт" crew, and (with `--write`) records it in `roster_corrections`, edits the verdict's `👥 У полі:` crew suffix, and posts a Ukrainian ack. **DRY-RUN by default.** The crew shows on every published verdict line and feeds both `field-verdict` (display) and `field-bonus` (the per-person tally). Needs `ANTHROPIC_API_KEY`; run `npm run slack-sync` first. (See `.claude/skills/field-roster/`.)
```

- [ ] **Step 9: Full suite + typecheck — expect PASS / 0 errors**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 10: Commit**

```bash
git add scripts/fieldVerdictReport.ts scripts/fieldVerdictReport.test.ts "app/(dashboard)/field-verdict/page.tsx" "app/(dashboard)/sent/page.tsx" .claude/skills/field-roster/SKILL.md CLAUDE.md
git commit -m "feat(roster): crew column in verdict table + web, field-roster skill + docs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage:**
- §1 DayVerdict crew → Task 1. §2 computeVerdicts attach/correct → Task 9. §3 crew suffix + override disjointness → Task 3. §4 store + pure apply → Tasks 2, 4. §5 classifier → Task 5. §6 CLI → Tasks 6, 8. §7 effect + keys → Task 7. §8 bonus wiring → Task 10. §9 both interfaces (CLI table + web + Outbound + skill + CLAUDE.md) → Task 11. Resolved flags: unknown initials internal-only → Tasks 9 (carried) + 11 (`?<tok>` in table/web, never in the Slack suffix); webhook deferred → out of scope (effect module is shared and ready). ✅ all covered.

**Placeholder scan:** No TBD/TODO; every code step shows the code; the only "inspect then maybe edit" step (Task 11 Step 6) is a genuine conditional with an explicit grep + decision rule, not a vague placeholder.

**Type consistency:** `RosterCorrection` (Task 2) used identically in Tasks 4/6/7/10. `RosterOutcome` produced in Task 6, consumed in Tasks 7/8. `applyRosterCorrection` (pure, Task 2) vs `applyRosterDecision` (effect, Task 7) — distinct names, no clash. `withRosterSuffix`/`splitRosterSuffix` (Task 3) consumed in Task 7. Classifier kinds `set_roster|patch|unclear` consistent across Tasks 5/6. `feature: "roster"` string used in Task 7, filtered in Task 11. `datasetStatus` (post-migration) used in the Task 11 test literal — consistent with the gated base.
