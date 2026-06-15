# Jira Dev Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Jira Cloud integration that powers the Dev Reporting tab with per-user resolved stats (count + story points), period totals, and a sprint-churn list, over a user-selected date range.

**Architecture:** Mirror the existing Vimeo integration. A `server-only` typed client (`lib/jira.ts`) reads credentials from `process.env`, calls Jira's new `/rest/api/3/search/jql` endpoint with `expand=changelog`, and returns typed issues. A pure, unit-tested module (`lib/jiraStats.ts`) aggregates issues into per-user rows + sprint churn. An API route (`app/api/jira/route.ts`) returns finished stats; the Dev Reporting page renders them. The token never reaches the browser.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Tailwind v4, Vitest. HTTP Basic auth against Jira Cloud REST v3.

**Spec:** `docs/superpowers/specs/2026-06-15-jira-dev-reporting-design.md`

---

## File Structure

- **Create `lib/jiraStats.ts`** — pure domain module. Owns the canonical types (`JiraIssue`, `JiraHistory`, `UserRow`, `PeriodTotals`, `SprintChurnRow`, `SprintChange`) and the two pure functions `aggregateByUser` and `sprintChurn`. No React/Next/server imports. (Same role as `lib/reconcile.ts`.)
- **Create `lib/jiraStats.test.ts`** — Vitest unit tests for the pure module.
- **Create `lib/jira.ts`** — `server-only` Jira client. Reads env, Basic auth, paged search with changelog, maps the raw API response into `JiraIssue[]`. I/O only — untested, consistent with `lib/vimeo.ts`.
- **Create `app/api/jira/route.ts`** — `GET /api/jira?start=&end=`. Validates dates, calls the client + aggregators, returns `{ rows, totals, sprintChurn }`.
- **Create `app/(dashboard)/dev-reporting/page.tsx`** — client page (replaces the "Coming soon" stub): date range, fetch, render the two sections.
- **Modify `app/(dashboard)/layout.tsx:9-11`** — flip the Dev Reporting tab to `enabled: true`.
- **Modify `.env.example`** — document the new Jira vars.

Type ownership: `lib/jiraStats.ts` defines `JiraIssue` (and its sub-types). `lib/jira.ts` does `import type { JiraIssue } from "./jiraStats"` and produces values of that type — type-only imports are erased, so the pure module stays free of the `server-only` runtime import. This mirrors how `lib/reconcile.ts` owns `ReconVideo` while the page maps into it.

---

## Task 1: Pure aggregation — types + `aggregateByUser`

**Files:**
- Create: `lib/jiraStats.ts`
- Test: `lib/jiraStats.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/jiraStats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { aggregateByUser, type JiraIssue } from "./jiraStats";

/** A resolved issue with sensible defaults; override per test. */
function issue(over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: "ATP-1",
    summary: "Some issue",
    assignee: { accountId: "u1", displayName: "Alice" },
    storyPoints: null,
    histories: [],
    ...over,
  };
}

describe("aggregateByUser", () => {
  it("sums resolved count and story points per user", () => {
    const { rows } = aggregateByUser([
      issue({ key: "ATP-1", storyPoints: 3 }),
      issue({ key: "ATP-2", storyPoints: 5 }),
      issue({
        key: "MC-1",
        assignee: { accountId: "u2", displayName: "Bob" },
        storyPoints: 2,
      }),
    ]);
    const alice = rows.find((r) => r.accountId === "u1");
    const bob = rows.find((r) => r.accountId === "u2");
    expect(alice).toMatchObject({ resolvedCount: 2, storyPoints: 8 });
    expect(bob).toMatchObject({ resolvedCount: 1, storyPoints: 2 });
  });

  it("treats null/undefined story points as 0", () => {
    const { rows } = aggregateByUser([
      issue({ storyPoints: null }),
      issue({ key: "ATP-2", storyPoints: 4 }),
    ]);
    expect(rows[0].storyPoints).toBe(4);
    expect(rows[0].resolvedCount).toBe(2);
  });

  it("buckets assignee-less issues under Unassigned", () => {
    const { rows } = aggregateByUser([issue({ assignee: null, storyPoints: 1 })]);
    expect(rows[0]).toMatchObject({
      accountId: null,
      displayName: "Unassigned",
      resolvedCount: 1,
      storyPoints: 1,
    });
  });

  it("returns period totals across all users", () => {
    const { totals } = aggregateByUser([
      issue({ key: "ATP-1", storyPoints: 3 }),
      issue({
        key: "MC-1",
        assignee: { accountId: "u2", displayName: "Bob" },
        storyPoints: 5,
      }),
    ]);
    expect(totals).toEqual({ totalResolved: 2, totalStoryPoints: 8 });
  });

  it("sorts rows by resolved count desc, then displayName asc", () => {
    const { rows } = aggregateByUser([
      issue({ key: "ATP-1", assignee: { accountId: "u1", displayName: "Alice" } }),
      issue({ key: "MC-1", assignee: { accountId: "u2", displayName: "Bob" } }),
      issue({ key: "MC-2", assignee: { accountId: "u2", displayName: "Bob" } }),
    ]);
    expect(rows.map((r) => r.displayName)).toEqual(["Bob", "Alice"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/jiraStats.test.ts`
Expected: FAIL — `Failed to resolve import "./jiraStats"` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `lib/jiraStats.ts`:

```ts
/**
 * Pure aggregation for Jira Dev Reporting. No React/Next/server imports —
 * this module is unit-tested, same discipline as lib/reconcile.ts.
 *
 * It owns the canonical issue shape (JiraIssue). lib/jira.ts maps Jira's raw
 * REST response into this type; everything downstream depends only on this.
 */

/** One changelog field-change entry (we only care about `field === "Sprint"`). */
export interface JiraChangeItem {
  field: string;
  fromString: string | null;
  toString: string | null;
}

/** One changelog history group (a single edit event with a timestamp). */
export interface JiraHistory {
  /** ISO 8601 timestamp of the edit. */
  created: string;
  items: JiraChangeItem[];
}

/** A resolved Jira issue, normalized for reporting. */
export interface JiraIssue {
  key: string;
  summary: string;
  assignee: { accountId: string; displayName: string } | null;
  /** Story-point value, or null when unset. */
  storyPoints: number | null;
  /** Changelog history groups (from `expand=changelog`). */
  histories: JiraHistory[];
}

/** Per-user resolved stats over the period. */
export interface UserRow {
  /** Jira accountId, or null for the Unassigned bucket. */
  accountId: string | null;
  displayName: string;
  resolvedCount: number;
  storyPoints: number;
}

/** Period grand totals across all users. */
export interface PeriodTotals {
  totalResolved: number;
  totalStoryPoints: number;
}

const UNASSIGNED_KEY = "__unassigned__";

/**
 * Group resolved issues by assignee. Issues with no assignee land in a single
 * "Unassigned" row (accountId null). Story points null/undefined count as 0.
 * Rows are sorted by resolvedCount desc, then displayName asc, for stable
 * rendering.
 */
export function aggregateByUser(issues: JiraIssue[]): {
  rows: UserRow[];
  totals: PeriodTotals;
} {
  const byUser = new Map<string, UserRow>();

  for (const issue of issues) {
    const key = issue.assignee?.accountId ?? UNASSIGNED_KEY;
    const existing = byUser.get(key);
    const points = issue.storyPoints ?? 0;
    if (existing) {
      existing.resolvedCount += 1;
      existing.storyPoints += points;
    } else {
      byUser.set(key, {
        accountId: issue.assignee?.accountId ?? null,
        displayName: issue.assignee?.displayName ?? "Unassigned",
        resolvedCount: 1,
        storyPoints: points,
      });
    }
  }

  const rows = [...byUser.values()].sort(
    (a, b) =>
      b.resolvedCount - a.resolvedCount ||
      a.displayName.localeCompare(b.displayName),
  );

  const totals: PeriodTotals = {
    totalResolved: issues.length,
    totalStoryPoints: rows.reduce((sum, r) => sum + r.storyPoints, 0),
  };

  return { rows, totals };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/jiraStats.test.ts`
Expected: PASS (5 tests in the `aggregateByUser` describe block).

- [ ] **Step 5: Commit**

```bash
git add lib/jiraStats.ts lib/jiraStats.test.ts
git commit -m "Add aggregateByUser for Jira dev reporting"
```

---

## Task 2: Pure aggregation — `sprintChurn`

**Files:**
- Modify: `lib/jiraStats.ts`
- Test: `lib/jiraStats.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/jiraStats.test.ts` (add `sprintChurn` to the existing import from `./jiraStats`):

```ts
import { aggregateByUser, sprintChurn, type JiraIssue } from "./jiraStats";

describe("sprintChurn", () => {
  it("omits issues with no Sprint changelog entry", () => {
    const result = sprintChurn([
      issue({
        key: "ATP-1",
        histories: [
          {
            created: "2026-06-01T10:00:00.000+0000",
            items: [{ field: "status", fromString: "To Do", toString: "Done" }],
          },
        ],
      }),
    ]);
    expect(result).toEqual([]);
  });

  it("extracts a single sprint move", () => {
    const result = sprintChurn([
      issue({
        key: "ATP-1630",
        summary: "Telemetry fix",
        histories: [
          {
            created: "2026-06-09T08:00:00.000+0000",
            items: [{ field: "Sprint", fromString: "ATP 37", toString: "ATP 38" }],
          },
        ],
      }),
    ]);
    expect(result).toEqual([
      {
        issueKey: "ATP-1630",
        summary: "Telemetry fix",
        changes: [{ from: "ATP 37", to: "ATP 38", when: "2026-06-09T08:00:00.000+0000" }],
      },
    ]);
  });

  it("collects multiple moves ordered by time, ignoring non-Sprint items", () => {
    const result = sprintChurn([
      issue({
        key: "ATP-2",
        histories: [
          {
            created: "2026-06-10T00:00:00.000+0000",
            items: [{ field: "Sprint", fromString: "ATP 38", toString: "ATP 39" }],
          },
          {
            created: "2026-06-05T00:00:00.000+0000",
            items: [
              { field: "assignee", fromString: "Alice", toString: "Bob" },
              { field: "Sprint", fromString: "ATP 37", toString: "ATP 38" },
            ],
          },
        ],
      }),
    ]);
    expect(result[0].changes).toEqual([
      { from: "ATP 37", to: "ATP 38", when: "2026-06-05T00:00:00.000+0000" },
      { from: "ATP 38", to: "ATP 39", when: "2026-06-10T00:00:00.000+0000" },
    ]);
  });

  it("renders null from/to (added to / removed from a sprint) as empty strings", () => {
    const result = sprintChurn([
      issue({
        key: "ATP-3",
        histories: [
          {
            created: "2026-06-02T00:00:00.000+0000",
            items: [{ field: "Sprint", fromString: null, toString: "ATP 38" }],
          },
        ],
      }),
    ]);
    expect(result[0].changes).toEqual([
      { from: "", to: "ATP 38", when: "2026-06-02T00:00:00.000+0000" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/jiraStats.test.ts`
Expected: FAIL — `sprintChurn is not a function` / no matching export.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/jiraStats.ts`:

```ts
/** One sprint move read from an issue's changelog. */
export interface SprintChange {
  /** Sprint(s) the issue moved from; "" when added from no sprint. */
  from: string;
  /** Sprint(s) the issue moved to; "" when removed from all sprints. */
  to: string;
  /** ISO 8601 timestamp of the move. */
  when: string;
}

/** An issue that changed sprints, with each move. */
export interface SprintChurnRow {
  issueKey: string;
  summary: string;
  changes: SprintChange[];
}

/**
 * For each issue, extract every changelog entry where the Sprint field changed,
 * ordered oldest-first by timestamp. Issues with no sprint change are omitted.
 *
 * Sprint `fromString`/`toString` are comma-separated sprint names as Jira
 * records them (e.g. "ATP 37" -> "ATP 38"); we surface them verbatim. A null
 * side (added to / removed from a sprint) is rendered as an empty string.
 */
export function sprintChurn(issues: JiraIssue[]): SprintChurnRow[] {
  const rows: SprintChurnRow[] = [];

  for (const issue of issues) {
    const changes: SprintChange[] = [];
    for (const history of issue.histories) {
      for (const item of history.items) {
        if (item.field === "Sprint") {
          changes.push({
            from: item.fromString ?? "",
            to: item.toString ?? "",
            when: history.created,
          });
        }
      }
    }
    if (changes.length > 0) {
      changes.sort((a, b) => a.when.localeCompare(b.when));
      rows.push({ issueKey: issue.key, summary: issue.summary, changes });
    }
  }

  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/jiraStats.test.ts`
Expected: PASS (all `aggregateByUser` + `sprintChurn` tests).

- [ ] **Step 5: Commit**

```bash
git add lib/jiraStats.ts lib/jiraStats.test.ts
git commit -m "Add sprintChurn extraction for Jira dev reporting"
```

---

## Task 3: Server-only Jira client

**Files:**
- Create: `lib/jira.ts`

No unit test (I/O module, consistent with `lib/vimeo.ts`). Verified manually via the route in Task 4.

- [ ] **Step 1: Write the client**

Create `lib/jira.ts`:

```ts
/**
 * Typed Jira Cloud client. SERVER-ONLY.
 *
 * Credentials are read from process.env and never exposed to the browser —
 * only this module and app/api/jira/route.ts touch them. The `server-only`
 * import makes an accidental client import a build error.
 *
 * Uses the current search endpoint `/rest/api/3/search/jql` (the classic
 * `/rest/api/3/search` with startAt/total paging is deprecated on Jira Cloud);
 * it returns { issues, isLast, nextPageToken } with no total.
 */
import "server-only";
import type { JiraIssue } from "./jiraStats";

const API_VERSION = "application/json";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKeys: string[];
  storyPointsField: string;
}

function config(): JiraConfig {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  const projectKeys = (process.env.JIRA_PROJECT_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const storyPointsField = process.env.JIRA_STORY_POINTS_FIELD;

  if (!baseUrl) throw new JiraError("JIRA_BASE_URL is not set on the server.");
  if (!email) throw new JiraError("JIRA_EMAIL is not set on the server.");
  if (!apiToken) throw new JiraError("JIRA_API_TOKEN is not set on the server.");
  if (projectKeys.length === 0)
    throw new JiraError("JIRA_PROJECT_KEYS is not set on the server.");
  if (!storyPointsField)
    throw new JiraError("JIRA_STORY_POINTS_FIELD is not set on the server.");

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    email,
    apiToken,
    projectKeys,
    storyPointsField,
  };
}

function authHeader(cfg: JiraConfig): string {
  const basic = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64");
  return `Basic ${basic}`;
}

/** Raw shape of one issue in the search response (only the fields we request). */
interface RawIssue {
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    assignee?: { accountId: string; displayName: string } | null;
  };
  changelog?: {
    histories?: {
      created: string;
      items: { field: string; fromString: string | null; toString: string | null }[];
    }[];
  };
}

interface SearchResponse {
  issues: RawIssue[];
  isLast?: boolean;
  nextPageToken?: string;
}

function mapIssue(raw: RawIssue, storyPointsField: string): JiraIssue {
  const sp = raw.fields[storyPointsField];
  return {
    key: raw.key,
    summary: raw.fields.summary ?? "",
    assignee: raw.fields.assignee
      ? {
          accountId: raw.fields.assignee.accountId,
          displayName: raw.fields.assignee.displayName,
        }
      : null,
    storyPoints: typeof sp === "number" ? sp : null,
    histories: (raw.changelog?.histories ?? []).map((h) => ({
      created: h.created,
      items: h.items.map((it) => ({
        field: it.field,
        fromString: it.fromString,
        toString: it.toString,
      })),
    })),
  };
}

/**
 * Fetch all issues resolved within [start, end] (inclusive) across the
 * configured projects, with sprint changelog. Pages via nextPageToken until
 * the server reports the last page.
 *
 * @param start inclusive period start, `YYYY-MM-DD`.
 * @param end   inclusive period end, `YYYY-MM-DD`.
 */
export async function fetchResolvedIssues(
  start: string,
  end: string,
): Promise<JiraIssue[]> {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new JiraError(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }

  const cfg = config();
  // `resolved <= "end"` alone means end-of-day-00:00, which would drop issues
  // resolved during the end day; "<end> 23:59" makes the bound inclusive.
  const jql =
    `project in (${cfg.projectKeys.join(",")}) ` +
    `AND resolved >= "${start}" AND resolved <= "${end} 23:59" ` +
    `ORDER BY resolved ASC`;

  const collected: JiraIssue[] = [];
  let nextPageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      jql,
      maxResults: "100",
      fields: ["summary", "assignee", "resolutiondate", "status", cfg.storyPointsField].join(","),
      expand: "changelog",
    });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);

    const url = `${cfg.baseUrl}/rest/api/3/search/jql?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Accept: API_VERSION, Authorization: authHeader(cfg) },
      // Always hit Jira live; reporting must reflect current truth.
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new JiraError(
        `Jira API returned ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`,
        res.status,
      );
    }

    const page = (await res.json()) as SearchResponse;
    for (const raw of page.issues ?? []) {
      collected.push(mapIssue(raw, cfg.storyPointsField));
    }
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
  } while (nextPageToken);

  return collected;
}
```

- [ ] **Step 2: Verify it type-checks and lints**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors. (Functional verification happens in Task 4 against live Jira.)

- [ ] **Step 3: Commit**

```bash
git add lib/jira.ts
git commit -m "Add server-only Jira client (search/jql + changelog)"
```

---

## Task 4: API route

**Files:**
- Create: `app/api/jira/route.ts`

- [ ] **Step 1: Write the route**

Create `app/api/jira/route.ts`:

```ts
import { NextResponse } from "next/server";
import { fetchResolvedIssues, JiraError } from "@/lib/jira";
import { aggregateByUser, sprintChurn } from "@/lib/jiraStats";

// Token + Jira calls live only on the server; never statically cache.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/jira?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * The browser calls this route (never Jira directly). We fetch the period's
 * resolved issues server-side, aggregate per-user stats + sprint churn, and
 * return them as JSON.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  if (!start || !end) {
    return NextResponse.json(
      { error: "Both `start` and `end` query params are required." },
      { status: 400 },
    );
  }
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return NextResponse.json(
      { error: "`start` and `end` must be YYYY-MM-DD dates." },
      { status: 400 },
    );
  }
  if (start > end) {
    return NextResponse.json(
      { error: "`start` must be on or before `end`." },
      { status: 400 },
    );
  }

  try {
    const issues = await fetchResolvedIssues(start, end);
    const { rows, totals } = aggregateByUser(issues);
    return NextResponse.json({ rows, totals, sprintChurn: sprintChurn(issues) });
  } catch (error) {
    if (error instanceof JiraError) {
      // Upstream failures: 502; missing config/token: 500.
      const status = error.status ? 502 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    const message =
      error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify against live Jira**

Start the dev server in one shell: `npm run dev`
In another shell, request a recent range:

Run: `curl -s "http://localhost:3003/api/jira?start=2026-05-01&end=2026-06-15" | head -c 600`
Expected: JSON beginning `{"rows":[...],"totals":{"totalResolved":<n>,...},"sprintChurn":[...]}` with a non-zero `totalResolved` (ATP has resolved issues with story points). No `error` key.

Also verify validation:
Run: `curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3003/api/jira?start=bad&end=2026-06-15"`
Expected: `400`

Stop the dev server when done.

- [ ] **Step 3: Commit**

```bash
git add app/api/jira/route.ts
git commit -m "Add /api/jira route returning dev-reporting stats"
```

---

## Task 5: Dev Reporting page + enable tab

**Files:**
- Create: `app/(dashboard)/dev-reporting/page.tsx` (replaces the "Coming soon" stub)
- Modify: `app/(dashboard)/layout.tsx:9-11`

- [ ] **Step 1: Enable the tab**

In `app/(dashboard)/layout.tsx`, change the Dev Reporting entry (currently `enabled: false`):

```ts
const TABS: { href: string; label: string; enabled: boolean }[] = [
  { href: "/field-ops", label: "Field Ops", enabled: true },
  { href: "/dev-reporting", label: "Dev Reporting", enabled: true },
];
```

- [ ] **Step 2: Write the page**

Replace the contents of `app/(dashboard)/dev-reporting/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import type {
  PeriodTotals,
  SprintChurnRow,
  UserRow,
} from "@/lib/jiraStats";

interface JiraReport {
  rows: UserRow[];
  totals: PeriodTotals;
  sprintChurn: SprintChurnRow[];
}

/** First day of the current month, in `YYYY-MM-DD`. */
function defaultStart(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}-01`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function DevReportingPage() {
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(todayIso);
  const [report, setReport] = useState<JiraReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchReport() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ start, end });
      const res = await fetch(`/api/jira?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setReport(body as JiraReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch report.");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          Dev Reporting — Jira
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Per-user issues resolved (count and story points) over the selected
          period, plus issues that changed sprints. Read-only; reflects live Jira.
        </p>
      </div>

      {/* Controls */}
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-900">Period</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Start
            <input
              type="date"
              value={start}
              max={end}
              onChange={(e) => setStart(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            End
            <input
              type="date"
              value={end}
              min={start}
              onChange={(e) => setEnd(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums"
            />
          </label>
          <button
            type="button"
            onClick={fetchReport}
            disabled={loading || !start || !end}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Fetching…" : "Fetch report"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {report && (
        <>
          {/* Period totals */}
          <div className="grid gap-3 sm:grid-cols-2">
            <SummaryCard label="Total resolved" value={String(report.totals.totalResolved)} />
            <SummaryCard
              label="Total story points"
              value={String(report.totals.totalStoryPoints)}
            />
          </div>

          {/* Per-user table */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-900">Resolved by user</h2>
            {report.rows.length === 0 ? (
              <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
                No issues resolved in this period.
              </p>
            ) : (
              <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-4 py-2">User</th>
                      <th className="px-4 py-2 text-right">Resolved</th>
                      <th className="px-4 py-2 text-right">Story points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.rows.map((row) => (
                      <tr key={row.accountId ?? "unassigned"}>
                        <td className="px-4 py-2 text-slate-900">{row.displayName}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                          {row.resolvedCount}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                          {row.storyPoints}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Sprint churn */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-900">Sprint changes</h2>
            {report.sprintChurn.length === 0 ? (
              <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
                No issues changed sprints in this period.
              </p>
            ) : (
              <ul className="space-y-2">
                {report.sprintChurn.map((item) => (
                  <li
                    key={item.issueKey}
                    className="rounded-md border border-slate-200 bg-white px-4 py-3"
                  >
                    <div className="text-sm font-medium text-slate-900">
                      <span className="font-mono text-slate-500">{item.issueKey}</span>{" "}
                      {item.summary}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {item.changes.map((c, i) => (
                        <span
                          key={i}
                          className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                        >
                          {c.from || "—"} → {c.to || "—"}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {!report && !error && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
          Pick a period and fetch the report to begin.
        </p>
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
        {value}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build, lint, and the page in a browser**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

Start the dev server (`npm run dev`), open `http://localhost:3003/dev-reporting`, pick a range (e.g. 2026-05-01 → 2026-06-15), click **Fetch report**.
Expected: the "Dev Reporting" tab is clickable in the nav; the per-user table and totals populate; sprint changes list shows moves like `ATP 37 → ATP 38`. Stop the server when done.

- [ ] **Step 4: Commit**

```bash
git add "app/(dashboard)/dev-reporting/page.tsx" "app/(dashboard)/layout.tsx"
git commit -m "Add Dev Reporting page and enable its nav tab"
```

---

## Task 6: Document env vars

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append the Jira vars**

Add to `.env.example` (below the existing `VIMEO_TOKEN` block):

```
# --- Jira Cloud (server-side only) ---
# Read-only Dev Reporting integration. The browser never receives these — they
# are read exclusively in lib/jira.ts / app/api/jira/route.ts via process.env.
# JIRA_API_TOKEN is an Atlassian API token (id.atlassian.com → Security → API
# tokens). Note: a token carries the full permissions of the account that owns
# it; for hard read-only, use a service account with only "Browse Projects".
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_EMAIL=service-account@your-org.com
JIRA_API_TOKEN=
# Comma-separated project keys to report on (the prefix on issue keys).
JIRA_PROJECT_KEYS=DEV,OPS
# Story-points custom field id. Instances may expose more than one such field;
# pin the correct one. Find ids at: GET /rest/api/3/field
JIRA_STORY_POINTS_FIELD=customfield_10016
```

- [ ] **Step 2: Verify the example file parses (no secret committed)**

Run: `grep -c "^JIRA_" .env.example`
Expected: `5` (five JIRA_ vars documented, none with a real token value).

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "Document Jira env vars in .env.example"
```

---

## Final verification

- [ ] **Run the full test suite and lint:**

Run: `npm test && npm run lint && npx tsc --noEmit`
Expected: all Vitest tests pass (including the existing `reconcile` suite and the new `jiraStats` suite), no lint errors, no type errors.

---

## Notes / accepted limitations (from the spec)

- The API token inherits the owning account's permissions; the *code* is read-only but the token is not scoped. Swap to a Browse-only service account for hard enforcement.
- Only the most recent 100 changelog entries per issue are returned inline; issues exceeding that lose older sprint moves. Accepted for v1.
- `resolved` filtering uses Jira's own date/timezone handling (the token account's timezone), not Europe/Kyiv. The end bound is made inclusive with `<end> 23:59`.
- No persistence: every request reads live Jira (`cache: "no-store"`).
- Story points are summed as-is per resolved issue (no parent/sub-task roll-up); null → 0.
