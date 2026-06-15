# Claude-Code-queryable Vimeo Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CLI that fetches and aggregates Vimeo video stats over a date window, plus a project skill so Claude Code can answer field-ops video questions in chat — reusing the existing pure `lib/` logic with zero duplication.

**Architecture:** A thin CLI entry (`scripts/vimeo.ts`) loads `.env`, parses flags, calls the server-only `fetchVideosInPeriod`, and delegates all shaping to a pure, unit-tested helper module (`scripts/vimeoStats.ts`) that reuses `aggregateByDay`/`videoUploadDate` from `lib/reconcile.ts`. Output is JSON by default (`--format table` optional). A committed `.claude/skills/vimeo-stats/SKILL.md` teaches Claude Code when and how to run it. Reconciliation / the 50% gate is explicitly out of scope (no flight-hours source yet).

**Tech Stack:** TypeScript (strict), Node 22, `tsx` (new devDependency) run with `--conditions=react-server` so `server-only` resolves to its empty module instead of throwing, Vitest.

---

## File Structure

- `scripts/vimeo.ts` (create) — CLI entry: `.env` load, arg parsing orchestration, live Vimeo fetch, output. Imports the server-only client; runs only under Node with the `react-server` condition.
- `scripts/vimeoStats.ts` (create) — **pure** helpers: `parseArgs`, `defaultMonthWindow`, `resolvePeriod`, `buildStats`, `formatTable`, and the `VimeoStats` shape. No `server-only` import (only a type-only import of `VimeoVideo`, erased at runtime). Unit-tested.
- `scripts/vimeoStats.test.ts` (create) — Vitest coverage for the pure helpers.
- `package.json` (modify) — add `tsx` devDependency and the `vimeo` npm script.
- `.claude/skills/vimeo-stats/SKILL.md` (create) — project skill.
- `CLAUDE.md` (modify) — document the new command and skill under Commands/Architecture.

Note on imports: tests run under Vitest with **no** alias config, and existing tests use relative imports (`./reconcile`). All `scripts/` files therefore use **relative** imports (`../lib/...`, `./vimeoStats`), not the `@/*` alias.

---

## Task 1: Add tsx and prove the runner wiring

This de-risks the core assumption first: that `lib/vimeo.ts` (which does `import "server-only"`) can be imported from a Node CLI when run with `--conditions=react-server`.

**Files:**
- Modify: `package.json`
- Create: `scripts/vimeo.ts` (temporary smoke version, fleshed out in Task 3)

- [ ] **Step 1: Install tsx as a devDependency**

Run:
```bash
npm install --save-dev tsx
```
Expected: `tsx` appears under `devDependencies` in `package.json`, install succeeds.

- [ ] **Step 2: Add the npm script**

Edit `package.json` `"scripts"` — add the `vimeo` entry (keep existing scripts):
```json
"vimeo": "node --conditions=react-server --import tsx scripts/vimeo.ts"
```

- [ ] **Step 3: Create a minimal smoke entry**

Create `scripts/vimeo.ts`:
```ts
// Smoke test for the runner wiring; replaced in Task 3.
import "../lib/vimeo";

console.log("runner ok");
```

- [ ] **Step 4: Run it to confirm `server-only` does NOT throw**

Run:
```bash
npm run vimeo
```
Expected: prints `runner ok`. If you instead see `Error: This module cannot be imported from a Client Component module`, the `--conditions=react-server` flag is not reaching Node — fall back to the npm script `"tsx --conditions=react-server scripts/vimeo.ts"` and re-run until `runner ok` prints.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts/vimeo.ts
git commit -m "Add tsx runner for Vimeo CLI (server-only via react-server condition)"
```

---

## Task 2: Pure stats helpers (TDD)

Build and test `scripts/vimeoStats.ts` — everything that can be tested without the network.

**Files:**
- Create: `scripts/vimeoStats.ts`
- Test: `scripts/vimeoStats.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/vimeoStats.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { VimeoVideo } from "../lib/vimeo";
import {
  buildStats,
  defaultMonthWindow,
  formatTable,
  parseArgs,
  resolvePeriod,
} from "./vimeoStats";

/** A Vimeo video uploaded at noon Kyiv on `date` (stable day mapping). */
function videoOn(
  date: string,
  durationSeconds: number,
  name = "clip",
): VimeoVideo {
  return {
    name,
    duration: durationSeconds,
    description: null,
    created_time: `${date}T12:00:00+00:00`,
    link: `https://vimeo.com/${name}`,
    pictures: { base_link: "" },
  };
}

describe("parseArgs", () => {
  it("reads --start, --end and --format", () => {
    expect(
      parseArgs(["--start", "2026-05-01", "--end", "2026-05-31", "--format", "table"]),
    ).toEqual({ start: "2026-05-01", end: "2026-05-31", format: "table" });
  });

  it("defaults format to json and leaves dates undefined when absent", () => {
    expect(parseArgs([])).toEqual({ start: undefined, end: undefined, format: "json" });
  });
});

describe("defaultMonthWindow", () => {
  it("spans the first of the month to today", () => {
    expect(defaultMonthWindow("2026-06-15")).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
    });
  });
});

describe("resolvePeriod", () => {
  it("uses explicit bounds when both are given", () => {
    const period = resolvePeriod(
      { start: "2026-05-01", end: "2026-05-31", format: "json" },
      "2026-06-15",
    );
    expect(period).toEqual({
      start: "2026-05-01",
      end: "2026-05-31",
      timezone: "Europe/Kyiv",
    });
  });

  it("falls back to the current month when bounds are omitted", () => {
    const period = resolvePeriod({ format: "json" }, "2026-06-15");
    expect(period).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
      timezone: "Europe/Kyiv",
    });
  });

  it("throws on a malformed date", () => {
    expect(() =>
      resolvePeriod({ start: "2026/05/01", end: "2026-05-31", format: "json" }, "2026-06-15"),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("buildStats", () => {
  it("groups by upload day and totals counts and minutes", () => {
    const videos = [
      videoOn("2026-05-01", 1800, "a"), // 30 min
      videoOn("2026-05-01", 1800, "b"), // 30 min
      videoOn("2026-05-02", 600, "c"), // 10 min
    ];
    const stats = buildStats(videos, {
      start: "2026-05-01",
      end: "2026-05-31",
      timezone: "Europe/Kyiv",
    });

    expect(stats.totals).toEqual({ videoCount: 3, recordedMinutes: 70 });
    expect(stats.byDay).toEqual([
      { date: "2026-05-01", videoCount: 2, recordedMinutes: 60 },
      { date: "2026-05-02", videoCount: 1, recordedMinutes: 10 },
    ]);
    expect(stats.videos).toEqual([
      { date: "2026-05-01", minutes: 30, name: "a", link: "https://vimeo.com/a" },
      { date: "2026-05-01", minutes: 30, name: "b", link: "https://vimeo.com/b" },
      { date: "2026-05-02", minutes: 10, name: "c", link: "https://vimeo.com/c" },
    ]);
    expect(stats.period.start).toBe("2026-05-01");
  });

  it("never emits a reconciliation status or ratio", () => {
    const stats = buildStats([videoOn("2026-05-01", 600)], {
      start: "2026-05-01",
      end: "2026-05-31",
      timezone: "Europe/Kyiv",
    });
    const dayKeys = Object.keys(stats.byDay[0]);
    expect(dayKeys).not.toContain("status");
    expect(dayKeys).not.toContain("ratio");
  });
});

describe("formatTable", () => {
  it("renders per-day rows and a totals line", () => {
    const stats = buildStats(
      [videoOn("2026-05-01", 1800), videoOn("2026-05-02", 600)],
      { start: "2026-05-01", end: "2026-05-31", timezone: "Europe/Kyiv" },
    );
    const table = formatTable(stats);
    expect(table).toContain("2026-05-01");
    expect(table).toContain("2026-05-02");
    expect(table).toMatch(/TOTAL/i);
    expect(table).toContain("2026-05-01 … 2026-05-31"); // period header
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run scripts/vimeoStats.test.ts
```
Expected: FAIL — `Failed to resolve import "./vimeoStats"` / functions not defined.

- [ ] **Step 3: Implement the pure helpers**

Create `scripts/vimeoStats.ts`:
```ts
import { aggregateByDay, FIELD_TIMEZONE, videoUploadDate } from "../lib/reconcile";
import type { ReconVideo } from "../lib/reconcile";
// Type-only import: erased at runtime, so it does NOT pull in `server-only`.
import type { VimeoVideo } from "../lib/vimeo";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OutputFormat = "json" | "table";

export interface ParsedArgs {
  start?: string;
  end?: string;
  format: OutputFormat;
}

export interface Period {
  start: string;
  end: string;
  timezone: string;
}

export interface DayStat {
  date: string;
  videoCount: number;
  recordedMinutes: number;
}

export interface VideoStat {
  date: string;
  minutes: number;
  name: string;
  link: string;
}

export interface VimeoStats {
  period: Period;
  totals: { videoCount: number; recordedMinutes: number };
  byDay: DayStat[];
  videos: VideoStat[];
}

/** Round to one decimal place (minutes are derived from seconds). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Parse `--start`, `--end`, `--format` from raw CLI args. Unknown flags ignored. */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { start: undefined, end: undefined, format: "json" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") { args.start = value; i += 1; }
    else if (flag === "--end") { args.end = value; i += 1; }
    else if (flag === "--format") {
      args.format = value === "table" ? "table" : "json";
      i += 1;
    }
  }
  return args;
}

/** First day of `today`'s month through `today` (both YYYY-MM-DD). */
export function defaultMonthWindow(today: string): { start: string; end: string } {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

/**
 * Resolve the reporting window: explicit `--start`/`--end` when both present,
 * otherwise the current month. Throws on a malformed explicit bound.
 */
export function resolvePeriod(args: ParsedArgs, today: string): Period {
  let start = args.start;
  let end = args.end;
  if (!start || !end) {
    const window = defaultMonthWindow(today);
    start = start ?? window.start;
    end = end ?? window.end;
  }
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }
  return { start, end, timezone: FIELD_TIMEZONE };
}

/**
 * Shape fetched videos into deterministic stats. Reuses the unit-tested
 * `aggregateByDay` for the per-day rollup but reports only Vimeo-derived facts —
 * no `ratio`/`status`, since reconciliation needs flight data we don't have here.
 */
export function buildStats(videos: VimeoVideo[], period: Period): VimeoStats {
  const reconVideos: ReconVideo[] = videos.map((v) => ({
    createdTime: v.created_time,
    durationSeconds: v.duration,
  }));

  const byDay: DayStat[] = aggregateByDay(reconVideos, []).map((d) => ({
    date: d.date,
    videoCount: d.videoCount,
    recordedMinutes: round1(d.recordedMinutes),
  }));

  const totalSeconds = videos.reduce((sum, v) => sum + v.duration, 0);

  const videoStats: VideoStat[] = videos
    .map((v) => ({
      date: videoUploadDate(v.created_time),
      minutes: round1(v.duration / 60),
      name: v.name,
      link: v.link,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    period,
    totals: { videoCount: videos.length, recordedMinutes: round1(totalSeconds / 60) },
    byDay,
    videos: videoStats,
  };
}

/** Render stats as a compact human-readable table. */
export function formatTable(stats: VimeoStats): string {
  const { period, totals, byDay } = stats;
  const lines: string[] = [];
  lines.push(`Period: ${period.start} … ${period.end} (${period.timezone})`);
  lines.push("");
  lines.push("Date         Videos   Minutes");
  lines.push("-----------  ------   -------");
  for (const day of byDay) {
    lines.push(
      `${day.date}   ${String(day.videoCount).padStart(6)}   ${String(day.recordedMinutes).padStart(7)}`,
    );
  }
  lines.push("-----------  ------   -------");
  lines.push(
    `TOTAL        ${String(totals.videoCount).padStart(6)}   ${String(totals.recordedMinutes).padStart(7)}`,
  );
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run scripts/vimeoStats.test.ts
```
Expected: PASS — all describe blocks green.

- [ ] **Step 5: Run the full suite and lint to confirm no regressions**

Run:
```bash
npm test && npm run lint
```
Expected: existing `lib/reconcile.test.ts` still passes; lint clean.

- [ ] **Step 6: Commit**

```bash
git add scripts/vimeoStats.ts scripts/vimeoStats.test.ts
git commit -m "Add pure Vimeo stats helpers with vitest coverage"
```

---

## Task 3: Wire the CLI entry

Replace the smoke `scripts/vimeo.ts` with the real orchestration: load env, compute today in Kyiv, parse args, fetch live, shape, print.

**Files:**
- Modify: `scripts/vimeo.ts`

- [ ] **Step 1: Implement the entry**

Replace the entire contents of `scripts/vimeo.ts`:
```ts
/**
 * CLI: fetch Vimeo video stats for a date window and print them.
 *
 * Usage: npm run vimeo -- --start 2026-05-01 --end 2026-05-31 [--format table]
 * Defaults to the current Europe/Kyiv calendar month when bounds are omitted.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so
 * the `server-only` import in ../lib/vimeo resolves to its empty module.
 */
import { fetchVideosInPeriod } from "../lib/vimeo";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { buildStats, formatTable, parseArgs, resolvePeriod } from "./vimeoStats";

/** Today's date (YYYY-MM-DD) in the field timezone. */
function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function main(): Promise<void> {
  // Load .env (where VIMEO_TOKEN lives) if present; ignore if absent.
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayInFieldTz());

  const videos = await fetchVideosInPeriod(period.start, period.end);
  const stats = buildStats(videos, period);

  if (args.format === "table") {
    console.log(formatTable(stats));
  } else {
    console.log(JSON.stringify(stats, null, 2));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`vimeo: ${message}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the error path with no token**

Run (force an empty token to exercise the clear-error path without needing network):
```bash
VIMEO_TOKEN= npm run vimeo -- --start 2026-05-01 --end 2026-05-31
```
Expected: stderr prints `vimeo: VIMEO_TOKEN is not set on the server.` and exit code is non-zero (`echo $?` → `1`). No stack trace, no token value leaked.

- [ ] **Step 3: Verify the happy path against live Vimeo**

Requires a real `VIMEO_TOKEN` in `.env`. Run:
```bash
npm run vimeo -- --start 2026-05-01 --end 2026-05-31
```
Expected: a JSON object with `period`, `totals`, `byDay`, `videos`. Then confirm the table view:
```bash
npm run vimeo -- --start 2026-05-01 --end 2026-05-31 --format table
```
Expected: a readable table with a `TOTAL` line. (If no token is available in this environment, note that this step is unverified and the no-token path in Step 2 is the proof the wiring is sound.)

- [ ] **Step 4: Commit**

```bash
git add scripts/vimeo.ts
git commit -m "Implement Vimeo stats CLI entry"
```

---

## Task 4: Add the project skill

Teach Claude Code when and how to use the CLI.

**Files:**
- Create: `.claude/skills/vimeo-stats/SKILL.md`

- [ ] **Step 1: Create the skill**

Create `.claude/skills/vimeo-stats/SKILL.md`:
```markdown
---
name: vimeo-stats
description: Use when answering questions about field-ops video recordings — how many videos, total recorded minutes, or per-day uploads over a date range. Pulls live data from the account's Vimeo via the repo's CLI. Does NOT do reconciliation / the 50% flight-bonus gate (no flight-hours source yet).
---

# Vimeo Stats

Answer field-ops video questions using live Vimeo data through this repo's CLI.

## Domain (must-know)

- Videos are grouped by **upload date** (`created_time`), not flight date — uploads can lag up to a working day.
- Day boundaries use **Europe/Kyiv**, not UTC.
- Video is **not** paid per minute. These are recording stats only.

## When to use

Any question like: "how many videos were uploaded in May?", "total recorded minutes last week?", "which day had the most uploads?", "longest video this month?".

## How to use

Run the CLI (defaults to the current Kyiv month if you omit the dates):

```bash
npm run vimeo -- --start 2026-05-01 --end 2026-05-31
```

It prints JSON:

- `period` — `{ start, end, timezone }`
- `totals` — `{ videoCount, recordedMinutes }`
- `byDay[]` — `{ date, videoCount, recordedMinutes }` (ascending)
- `videos[]` — `{ date, minutes, name, link }` (ascending by date)

Answer counts/sums from `totals`/`byDay`; derive anything else (busiest day, longest clip) from `videos`. Add `--format table` for a human-readable view.

Dates are inclusive and must be `YYYY-MM-DD`. A missing `VIMEO_TOKEN` makes the CLI exit non-zero with a clear message — tell the user to set it in `.env`.

## Out of scope

Reconciliation and the 50% video-completeness gate need flight-hours data, which is not available to this CLI yet. Do **not** infer pass/fail or "flagged" status from these stats — report only the recording facts.
```

- [ ] **Step 2: Sanity-check the skill renders**

Run:
```bash
cat .claude/skills/vimeo-stats/SKILL.md | head -5
```
Expected: valid YAML frontmatter (`name`, `description`) at the top.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/vimeo-stats/SKILL.md
git commit -m "Add vimeo-stats project skill for Claude Code"
```

---

## Task 5: Document the CLI in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the command under the Commands section**

In `CLAUDE.md`, add to the Commands bullet list (after the `test:watch` line, before the single-test lines):
```markdown
- `npm run vimeo -- --start YYYY-MM-DD --end YYYY-MM-DD` — print Vimeo video stats (counts, recorded minutes, per-day) as JSON for the window; `--format table` for a human view. Defaults to the current Kyiv month. This is the CLI Claude Code uses to answer video-stats questions (see `.claude/skills/vimeo-stats/`).
```

- [ ] **Step 2: Add a short Architecture note**

In `CLAUDE.md`, append this paragraph at the end of the `### Server/client boundary` section:
```markdown
The same server-only client also backs a CLI, `scripts/vimeo.ts` (run via `npm run vimeo`). Because `lib/vimeo.ts` imports `server-only` — whose default export throws — the CLI runs Node with `--conditions=react-server` so that import resolves to its empty module. All shaping lives in the pure, tested `scripts/vimeoStats.ts`; the CLI does not compute reconciliation (no flight-hours source yet).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Document the Vimeo stats CLI in CLAUDE.md"
```

---

## Final verification

- [ ] Run `npm test` — all tests pass (existing + new `scripts/vimeoStats.test.ts`).
- [ ] Run `npm run lint` — clean.
- [ ] Run `VIMEO_TOKEN= npm run vimeo` — exits non-zero with a clear, token-free error message.
- [ ] If a real token is available: `npm run vimeo -- --format table` prints a sensible table for the current month.
- [ ] `git status` is clean (everything committed).
