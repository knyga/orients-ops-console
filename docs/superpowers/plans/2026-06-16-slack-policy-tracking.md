# Slack Policy Execution Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track whether recurring policy obligations announced in Slack are actually executed (right post, right channel, on time), producing committed `reports/policy/<period>.{json,csv}` artifacts a web tab renders.

**Architecture:** Mirror the existing Jira feature exactly. A pure registry of obligations + a pure scheduler turn fetched Slack messages into per-occurrence *deterministic* statuses (`MISSING`/`PENDING`/`NEEDS_REVIEW`); Claude Code sonnet subagents add verdicts (`DONE`/`LATE`/`PARTIAL`/`MISSING`) via the same `--dump-…`/`--verdicts-file` plumbing Jira uses for summaries; the CLI commits JSON+CSV; a hybrid `/api/policy` route + dashboard page render committed reports with a live deterministic refresh.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Vitest, `tsx` CLIs run under `node --conditions=react-server`, Slack Web API.

**Reference files to mirror (read before starting):** `lib/jira.ts`, `lib/jiraStats.ts`, `scripts/jira.ts`, `scripts/jiraReport.ts`, `app/api/jira/route.ts`, `app/(dashboard)/dev-reporting/page.tsx`, `lib/reports.ts`, `lib/period.ts`, `lib/usePeriodReport.ts`, `.claude/skills/jira-dev-reporting/SKILL.md`.

**Spec:** `docs/superpowers/specs/2026-06-15-slack-policy-tracking-design.md`.

**Convention:** every commit message ends with the trailer:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 1: Scaffolding — channels config, env, npm script

**Files:**
- Create: `lib/slackChannels.ts`
- Modify: `.env.example` (append after line 33)
- Modify: `package.json` (scripts block)

- [ ] **Step 1: Create the tracked-channels config**

`lib/slackChannels.ts`:

```ts
/**
 * Committed list of Slack channels the policy tracker reads. Adding a channel is
 * a small PR. `id` is the Slack channel id (e.g. C0123ABCD — Channel → View
 * channel details → bottom of the dialog). `name` is the human handle and is the
 * value an obligation's `channel` field matches against in lib/policyRegistry.
 *
 * Replace the placeholder ids with the workspace's real channel ids before the
 * first run; the names must stay in sync with lib/policyRegistry obligations.
 */
export interface SlackChannel {
  id: string;
  name: string;
}

export const TRACKED_CHANNELS: SlackChannel[] = [
  { id: "C_BUDGETS_REPLACE_ME", name: "budgets" },
  { id: "C_STATS_REPLACE_ME", name: "stats" },
  { id: "C_FIELD_REPORTS_REPLACE_ME", name: "field-reports" },
  { id: "C_FIELD_QA_REPLACE_ME", name: "field-qa" },
  { id: "C_DATASETS_REPLACE_ME", name: "datasets" },
];
```

- [ ] **Step 2: Append Slack env vars to `.env.example`**

Append to `.env.example`:

```bash

# --- Slack (server-side only) ---
# Bot/user token for the Policy Tracking reader. Read exclusively in
# lib/slack.ts / app/api/policy/route.ts via process.env; never sent to the
# browser. Scopes: channels:history + groups:history (private channels) +
# users:read. Without it, GET /api/policy live mode returns 500 and the CLI
# exits 1.
SLACK_TOKEN=
# Workspace subdomain (the "<x>" in https://<x>.slack.com), used to build
# message permalinks in reports. Optional — when unset, permalinks are empty.
SLACK_WORKSPACE=
```

- [ ] **Step 3: Add the `policy` npm script**

In `package.json`, add to `"scripts"` after the `"fieldops"` line:

```json
    "policy": "node --conditions=react-server --import tsx scripts/policy.ts"
```

(Keep the comma placement valid — the line before it gains a trailing comma.)

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/slackChannels.ts .env.example package.json
git commit -m "$(cat <<'EOF'
Add Slack policy tracking scaffolding (channels, env, npm script)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Policy registry (pure)

**Files:**
- Create: `lib/policyRegistry.ts`
- Test: `lib/policyRegistry.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/policyRegistry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { activeObligations, OBLIGATIONS, type Obligation } from "./policyRegistry";

const ob = (over: Partial<Obligation>): Obligation => ({
  id: "x",
  title: "X",
  description: "",
  channel: "budgets",
  responsible: [],
  cadence: { type: "weekly", weekday: 1 },
  gracePeriodWorkingDays: 0,
  effectiveFrom: "2026-01-01",
  ...over,
});

describe("activeObligations", () => {
  it("includes an obligation whose effective range overlaps the period", () => {
    const list = [ob({ id: "a", effectiveFrom: "2026-03-01" })];
    expect(activeObligations({ start: "2026-03-01", end: "2026-03-31" }, list).map((o) => o.id)).toEqual(["a"]);
  });

  it("excludes an obligation effective only after the period", () => {
    const list = [ob({ id: "a", effectiveFrom: "2026-05-01" })];
    expect(activeObligations({ start: "2026-03-01", end: "2026-03-31" }, list)).toEqual([]);
  });

  it("excludes an obligation whose effectiveTo ends before the period", () => {
    const list = [ob({ id: "a", effectiveFrom: "2026-01-01", effectiveTo: "2026-02-28" })];
    expect(activeObligations({ start: "2026-03-01", end: "2026-03-31" }, list)).toEqual([]);
  });

  it("defaults to the committed OBLIGATIONS and yields a non-empty list for a recent month", () => {
    expect(activeObligations({ start: "2026-05-01", end: "2026-05-31" }).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/policyRegistry.test.ts`
Expected: FAIL — cannot find module `./policyRegistry`.

- [ ] **Step 3: Implement the registry**

`lib/policyRegistry.ts`:

```ts
/**
 * Committed registry of recurring policy obligations, parsed from the
 * operational-policy changelog. Pure — no React/Next/server imports, unit-tested
 * (same discipline as lib/jiraStats.ts).
 *
 * Each obligation says who must post what, in which channel, on what cadence,
 * with how much grace, and over which effective date range. Effective ranges are
 * load-bearing because policies evolve over time.
 */
import type { Period } from "./period";

/** How often an obligation comes due. */
export type Cadence =
  | { type: "weekly"; weekday: number } // ISO weekday: 1=Mon … 7=Sun
  | { type: "monthly"; dueDay: number } // due by the Nth calendar day (≤ 28)
  | { type: "monthly-window"; throughDay: number } // due within the first N days
  | { type: "per-event" }; // triggered by an external event — not scheduled in v1

export interface Obligation {
  id: string;
  title: string;
  description: string;
  /** Tracked channel name where the fulfilling post is expected (see lib/slackChannels). */
  channel: string;
  responsible: string[];
  cadence: Cadence;
  gracePeriodWorkingDays: number;
  /** Inclusive YYYY-MM-DD; the obligation does not apply before this date. */
  effectiveFrom: string;
  /** Inclusive YYYY-MM-DD; omitted means open-ended. */
  effectiveTo?: string;
  /** Optional recognition hints for the human/AI verdict step. */
  keywords?: string[];
}

export const OBLIGATIONS: Obligation[] = [
  {
    id: "weekly-budget-status",
    title: "Weekly budget status report",
    description:
      "Maryna publishes the weekly budget status every Monday for the prior week.",
    channel: "budgets",
    responsible: ["Maryna"],
    cadence: { type: "weekly", weekday: 1 },
    gracePeriodWorkingDays: 1,
    effectiveFrom: "2026-03-03",
    keywords: ["budget", "бюджет", "weekly", "тижневий"],
  },
  {
    id: "monthly-budget-status",
    title: "Monthly budget status report",
    description:
      "Maryna publishes the monthly budget status by the 5th calendar day for the prior month.",
    channel: "budgets",
    responsible: ["Maryna"],
    cadence: { type: "monthly", dueDay: 5 },
    gracePeriodWorkingDays: 1,
    effectiveFrom: "2026-03-03",
    keywords: ["budget", "бюджет", "monthly", "місячний"],
  },
  {
    id: "stats-publication",
    title: "Tuesday statistics publication",
    description:
      "Khrystyna and Maryna publish the statistics every Tuesday.",
    channel: "stats",
    responsible: ["Khrystyna", "Maryna"],
    cadence: { type: "weekly", weekday: 2 },
    gracePeriodWorkingDays: 1,
    effectiveFrom: "2026-02-23",
    keywords: ["stats", "статистик"],
  },
  {
    id: "dynamic-budget-publication",
    title: "Dynamic budget publication",
    description:
      "Maryna publishes the dynamic monthly budgets in the first half of each month.",
    channel: "budgets",
    responsible: ["Maryna"],
    cadence: { type: "monthly-window", throughDay: 15 },
    gracePeriodWorkingDays: 1,
    effectiveFrom: "2026-05-01",
    keywords: ["budget", "бюджет", "dynamic", "динамічн"],
  },
  {
    id: "drone-remainder-report",
    title: "Drone-remainder report",
    description:
      "Vlad (or delegate) posts the drone-remainder report within 1 working day of a flight day; without it the day's bonuses are not accrued.",
    channel: "field-reports",
    responsible: ["Vlad"],
    cadence: { type: "per-event" },
    gracePeriodWorkingDays: 1,
    effectiveFrom: "2026-04-01",
    keywords: ["drone", "дрон", "remainder", "залишок"],
  },
];

/**
 * Obligations whose effective range overlaps the period. An obligation applies
 * when it starts on or before the period end AND has no end (or ends on or after
 * the period start). String comparison is valid for YYYY-MM-DD.
 */
export function activeObligations(
  period: Period,
  obligations: Obligation[] = OBLIGATIONS,
): Obligation[] {
  return obligations.filter(
    (o) =>
      o.effectiveFrom <= period.end &&
      (o.effectiveTo === undefined || o.effectiveTo >= period.start),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/policyRegistry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/policyRegistry.ts lib/policyRegistry.test.ts
git commit -m "$(cat <<'EOF'
Add pure policy obligation registry with effective-range filtering

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Policy schedule engine (pure)

**Files:**
- Create: `lib/policySchedule.ts`
- Test: `lib/policySchedule.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/policySchedule.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Obligation } from "./policyRegistry";
import {
  addWorkingDays,
  buildSchedule,
  isWorkingDay,
  type SlackMessage,
} from "./policySchedule";

const msg = (over: Partial<SlackMessage>): SlackMessage => ({
  channel: "budgets",
  authorId: "U1",
  author: "Maryna",
  ts: "1700000000.000100",
  isoTime: "2026-05-04T09:00:00.000Z",
  text: "Weekly budget status for last week",
  permalink: "https://x.slack.com/archives/C/p1",
  ...over,
});

const weekly: Obligation = {
  id: "weekly-budget-status",
  title: "Weekly budget status report",
  description: "",
  channel: "budgets",
  responsible: ["Maryna"],
  cadence: { type: "weekly", weekday: 1 }, // Monday
  gracePeriodWorkingDays: 1,
  effectiveFrom: "2026-01-01",
};

describe("working-day helpers", () => {
  it("isWorkingDay treats Sat/Sun as non-working", () => {
    expect(isWorkingDay("2026-05-04")).toBe(true); // Monday
    expect(isWorkingDay("2026-05-09")).toBe(false); // Saturday
    expect(isWorkingDay("2026-05-10")).toBe(false); // Sunday
  });

  it("addWorkingDays skips the weekend", () => {
    expect(addWorkingDays("2026-05-08", 1)).toBe("2026-05-11"); // Fri +1wd → Mon
    expect(addWorkingDays("2026-05-04", 0)).toBe("2026-05-04");
  });
});

describe("buildSchedule", () => {
  it("marks a Monday occurrence NEEDS_REVIEW when a candidate exists in the window", () => {
    const schedule = buildSchedule(
      [weekly],
      [msg({ isoTime: "2026-05-04T09:00:00.000Z" })], // Monday 2026-05-04
      { start: "2026-05-04", end: "2026-05-08" },
      "2026-06-16",
    );
    const occ = schedule.occurrences.find((o) => o.dueDate === "2026-05-04");
    expect(occ?.status).toBe("NEEDS_REVIEW");
    expect(occ?.candidates).toHaveLength(1);
    expect(occ?.id).toBe("weekly-budget-status:2026-05-04");
  });

  it("marks a past-due occurrence with no candidate MISSING", () => {
    const schedule = buildSchedule(
      [weekly],
      [],
      { start: "2026-05-04", end: "2026-05-08" },
      "2026-06-16",
    );
    const occ = schedule.occurrences.find((o) => o.dueDate === "2026-05-04");
    expect(occ?.status).toBe("MISSING");
  });

  it("marks a not-yet-due occurrence with no candidate PENDING", () => {
    const schedule = buildSchedule(
      [weekly],
      [],
      { start: "2026-05-04", end: "2026-05-08" },
      "2026-05-04", // today == due date, still within grace
    );
    const occ = schedule.occurrences.find((o) => o.dueDate === "2026-05-04");
    expect(occ?.status).toBe("PENDING");
  });

  it("ignores messages in a different channel", () => {
    const schedule = buildSchedule(
      [weekly],
      [msg({ channel: "stats" })],
      { start: "2026-05-04", end: "2026-05-08" },
      "2026-06-16",
    );
    const occ = schedule.occurrences.find((o) => o.dueDate === "2026-05-04");
    expect(occ?.status).toBe("MISSING");
  });

  it("skips per-event obligations with a logged reason", () => {
    const perEvent: Obligation = { ...weekly, id: "pe", cadence: { type: "per-event" } };
    const schedule = buildSchedule([perEvent], [], { start: "2026-05-01", end: "2026-05-31" }, "2026-06-16");
    expect(schedule.occurrences).toHaveLength(0);
    expect(schedule.skipped).toEqual([
      { obligationId: "pe", reason: "per-event cadence not scheduled in v1" },
    ]);
  });

  it("enumerates a monthly occurrence on its due day", () => {
    const monthly: Obligation = { ...weekly, id: "m", cadence: { type: "monthly", dueDay: 5 } };
    const schedule = buildSchedule([monthly], [], { start: "2026-05-01", end: "2026-05-31" }, "2026-06-16");
    expect(schedule.occurrences.map((o) => o.dueDate)).toEqual(["2026-05-05"]);
    expect(schedule.occurrences[0].windowStart).toBe("2026-05-01");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/policySchedule.test.ts`
Expected: FAIL — cannot find module `./policySchedule`.

- [ ] **Step 3: Implement the scheduler**

`lib/policySchedule.ts`:

```ts
/**
 * Pure scheduler for Policy Execution Tracking. No React/Next/server imports —
 * unit-tested, same discipline as lib/jiraStats.ts.
 *
 * It owns the canonical SlackMessage shape (lib/slack.ts maps Slack's raw
 * response into it), and turns (obligations, messages, period, today) into
 * per-occurrence rows with a DETERMINISTIC status. Verdicts (DONE/LATE/…) are
 * added later by Claude via the CLI's --verdicts-file flow.
 *
 * All calendar math is on YYYY-MM-DD in UTC — consistent with the Jira/GitHub
 * features; public holidays are not modeled (working days = Mon–Fri).
 */
import { activeObligations, type Obligation } from "./policyRegistry";
import type { Period } from "./period";

/** A Slack message normalized for scheduling. */
export interface SlackMessage {
  /** Tracked channel NAME (resolved from the channel id by lib/slack). */
  channel: string;
  authorId: string;
  author: string;
  /** Slack ts, e.g. "1716200000.000200". */
  ts: string;
  /** ISO 8601 timestamp derived from ts. */
  isoTime: string;
  text: string;
  /** Permalink, or "" when SLACK_WORKSPACE is unset. */
  permalink: string;
}

export type OccurrenceStatus = "MISSING" | "PENDING" | "NEEDS_REVIEW";

/** A message attached as evidence for an occurrence. */
export interface CandidateMessage {
  authorId: string;
  author: string;
  isoTime: string;
  excerpt: string;
  permalink: string;
}

/** One expected execution of an obligation within the period. */
export interface Occurrence {
  /** Stable id: `${obligationId}:${dueDate}`. */
  id: string;
  obligationId: string;
  title: string;
  channel: string;
  dueDate: string;
  windowStart: string;
  windowEnd: string;
  status: OccurrenceStatus;
  candidates: CandidateMessage[];
}

export interface SkippedObligation {
  obligationId: string;
  reason: string;
}

export interface PolicySchedule {
  period: Period;
  occurrences: Occurrence[];
  skipped: SkippedObligation[];
}

const EXCERPT_LEN = 200;

function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function fmtDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** ISO weekday: 1=Mon … 7=Sun. */
function isoWeekday(day: string): number {
  const dow = parseDay(day).getUTCDay(); // 0=Sun … 6=Sat
  return dow === 0 ? 7 : dow;
}

export function isWorkingDay(day: string): boolean {
  const wd = isoWeekday(day);
  return wd >= 1 && wd <= 5;
}

/** Add `n` working days (Mon–Fri) to a YYYY-MM-DD date; n=0 returns the input. */
export function addWorkingDays(day: string, n: number): string {
  const date = parseDay(day);
  let added = 0;
  while (added < n) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isWorkingDay(fmtDay(date))) added += 1;
  }
  return fmtDay(date);
}

/** Inclusive list of YYYY-MM-DD dates from start to end. */
function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  const date = parseDay(start);
  const last = parseDay(end);
  while (date <= last) {
    out.push(fmtDay(date));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return out;
}

/** Distinct YYYY-MM month prefixes touched by the period, in order. */
function monthsInPeriod(period: Period): string[] {
  const seen = new Set<string>();
  for (const day of eachDate(period.start, period.end)) seen.add(day.slice(0, 7));
  return [...seen];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

interface Window {
  dueDate: string;
  windowStart: string;
}

/** Expected occurrence windows (dueDate + windowStart) for an obligation in the period. */
function occurrenceWindows(ob: Obligation, period: Period): Window[] {
  const within = (day: string): boolean =>
    day >= period.start &&
    day <= period.end &&
    day >= ob.effectiveFrom &&
    (ob.effectiveTo === undefined || day <= ob.effectiveTo);

  if (ob.cadence.type === "weekly") {
    const weekday = ob.cadence.weekday;
    return eachDate(period.start, period.end)
      .filter((day) => isoWeekday(day) === weekday && within(day))
      .map((day) => ({ dueDate: day, windowStart: day }));
  }

  if (ob.cadence.type === "monthly" || ob.cadence.type === "monthly-window") {
    const day = ob.cadence.type === "monthly" ? ob.cadence.dueDay : ob.cadence.throughDay;
    return monthsInPeriod(period)
      .map((month) => ({ dueDate: `${month}-${pad2(day)}`, windowStart: `${month}-01` }))
      .filter((w) => within(w.dueDate));
  }

  return []; // per-event — handled as skipped by the caller
}

function toCandidate(m: SlackMessage): CandidateMessage {
  return {
    authorId: m.authorId,
    author: m.author,
    isoTime: m.isoTime,
    excerpt: m.text.length > EXCERPT_LEN ? `${m.text.slice(0, EXCERPT_LEN)}…` : m.text,
    permalink: m.permalink,
  };
}

/**
 * Build the deterministic schedule. For each active, schedulable obligation,
 * enumerate occurrences, attach candidate messages (same channel, posted within
 * [windowStart, windowEnd] where windowEnd = dueDate + grace working days), and
 * assign a status. Per-event obligations are recorded in `skipped`.
 */
export function buildSchedule(
  obligations: Obligation[],
  messages: SlackMessage[],
  period: Period,
  today: string,
): PolicySchedule {
  const occurrences: Occurrence[] = [];
  const skipped: SkippedObligation[] = [];

  for (const ob of activeObligations(period, obligations)) {
    if (ob.cadence.type === "per-event") {
      skipped.push({ obligationId: ob.id, reason: "per-event cadence not scheduled in v1" });
      continue;
    }
    for (const w of occurrenceWindows(ob, period)) {
      const windowEnd = addWorkingDays(w.dueDate, ob.gracePeriodWorkingDays);
      const candidates = messages
        .filter((m) => {
          const day = m.isoTime.slice(0, 10);
          return m.channel === ob.channel && day >= w.windowStart && day <= windowEnd;
        })
        .map(toCandidate);
      const status: OccurrenceStatus =
        candidates.length > 0 ? "NEEDS_REVIEW" : today > windowEnd ? "MISSING" : "PENDING";
      occurrences.push({
        id: `${ob.id}:${w.dueDate}`,
        obligationId: ob.id,
        title: ob.title,
        channel: ob.channel,
        dueDate: w.dueDate,
        windowStart: w.windowStart,
        windowEnd,
        status,
        candidates,
      });
    }
  }

  occurrences.sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.obligationId.localeCompare(b.obligationId),
  );

  return { period, occurrences, skipped };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/policySchedule.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/policySchedule.ts lib/policySchedule.test.ts
git commit -m "$(cat <<'EOF'
Add pure policy schedule engine (occurrences, evidence, deterministic status)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Slack client (server-only fetcher)

**Files:**
- Create: `lib/slack.ts`

No unit test (network-bound, like `lib/jira.ts`). Verified via `tsc` + the live CLI run in Task 6.

- [ ] **Step 1: Implement the client**

`lib/slack.ts`:

```ts
/**
 * Typed Slack Web API client. SERVER-ONLY.
 *
 * SLACK_TOKEN (+ optional SLACK_WORKSPACE) are read from process.env and never
 * exposed to the browser — only this module and app/api/policy/route.ts touch
 * them. The `server-only` import makes an accidental client import a build error.
 *
 * Fetches conversations.history for every tracked channel over [start, end],
 * resolving author ids → display names via one users.list call. Mirrors the
 * shape/discipline of lib/jira.ts.
 */
import "server-only";
import type { Period } from "./period";
import { TRACKED_CHANNELS } from "./slackChannels";
import type { SlackMessage } from "./policySchedule";

const API = "https://slack.com/api";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class SlackError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SlackError";
  }
}

function token(): string {
  const value = process.env.SLACK_TOKEN;
  if (!value) throw new SlackError("SLACK_TOKEN is not set on the server.");
  return value;
}

interface SlackOk {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

/** GET a Slack Web API method with bearer auth; throws SlackError on transport or API error. */
async function call<T extends SlackOk>(method: string, params: URLSearchParams): Promise<T> {
  const res = await fetch(`${API}/${method}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token()}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new SlackError(`Slack ${method} returned ${res.status} ${res.statusText}`, res.status);
  }
  const body = (await res.json()) as T;
  if (!body.ok) {
    // 502: the request reached Slack but it rejected it (auth/scope/etc.).
    throw new SlackError(`Slack ${method} error: ${body.error ?? "unknown"}`, 502);
  }
  return body;
}

interface UsersListResponse extends SlackOk {
  members: { id: string; profile?: { display_name?: string; real_name?: string }; real_name?: string }[];
}

/** Build an id → display-name map from a single users.list page-walk. */
async function userMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const page = await call<UsersListResponse>("users.list", params);
    for (const u of page.members ?? []) {
      const name = u.profile?.display_name || u.profile?.real_name || u.real_name || u.id;
      map.set(u.id, name);
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return map;
}

interface HistoryResponse extends SlackOk {
  messages: { user?: string; bot_id?: string; ts: string; text?: string }[];
}

function permalink(channelId: string, ts: string): string {
  const workspace = process.env.SLACK_WORKSPACE;
  if (!workspace) return "";
  return `https://${workspace}.slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
}

/** Inclusive day → Unix epoch seconds at UTC midnight (Slack `oldest`/`latest` bounds). */
function epoch(day: string, endOfDay = false): string {
  const ms = new Date(`${day}T00:00:00.000Z`).getTime() + (endOfDay ? 86_399_000 : 0);
  return String(Math.floor(ms / 1000));
}

/**
 * Fetch messages from every tracked channel within [period.start, period.end]
 * (inclusive), normalized to SlackMessage with the channel NAME and resolved
 * author display names. Pages conversations.history via cursor until exhausted.
 */
export async function fetchMessages(period: Period): Promise<SlackMessage[]> {
  if (!DATE_RE.test(period.start) || !DATE_RE.test(period.end)) {
    throw new SlackError(`Period bounds must be YYYY-MM-DD: start=${period.start} end=${period.end}`);
  }

  const users = await userMap();
  const oldest = epoch(period.start);
  const latest = epoch(period.end, true);
  const collected: SlackMessage[] = [];

  for (const channel of TRACKED_CHANNELS) {
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({
        channel: channel.id,
        oldest,
        latest,
        inclusive: "true",
        limit: "200",
      });
      if (cursor) params.set("cursor", cursor);
      const page = await call<HistoryResponse>("conversations.history", params);
      for (const m of page.messages ?? []) {
        if (!m.user) continue; // skip bot/system messages with no human author
        collected.push({
          channel: channel.name,
          authorId: m.user,
          author: users.get(m.user) ?? m.user,
          ts: m.ts,
          isoTime: new Date(Number(m.ts) * 1000).toISOString(),
          text: m.text ?? "",
          permalink: permalink(channel.id, m.ts),
        });
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  return collected;
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/slack.ts
git commit -m "$(cat <<'EOF'
Add server-only Slack client for policy tracking

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: CLI shaping (pure)

**Files:**
- Create: `scripts/policyReport.ts`
- Test: `scripts/policyReport.test.ts`

- [ ] **Step 1: Write the failing test**

`scripts/policyReport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PolicySchedule } from "../lib/policySchedule";
import { applyVerdicts, parseArgs, resolvePeriod, toCsv } from "./policyReport";

const schedule: PolicySchedule = {
  period: { start: "2026-05-01", end: "2026-05-31" },
  occurrences: [
    {
      id: "weekly-budget-status:2026-05-04",
      obligationId: "weekly-budget-status",
      title: "Weekly budget status report",
      channel: "budgets",
      dueDate: "2026-05-04",
      windowStart: "2026-05-04",
      windowEnd: "2026-05-05",
      status: "NEEDS_REVIEW",
      candidates: [
        {
          authorId: "U1",
          author: "Maryna",
          isoTime: "2026-05-04T09:00:00.000Z",
          excerpt: "Weekly budget, all good",
          permalink: "https://x.slack.com/archives/C/p1",
        },
      ],
    },
  ],
  skipped: [{ obligationId: "drone-remainder-report", reason: "per-event cadence not scheduled in v1" }],
};

describe("parseArgs", () => {
  it("parses bounds, --write, --dump-occurrences and --verdicts-file", () => {
    const args = parseArgs([
      "--start", "2026-05-01", "--end", "2026-05-31",
      "--write", "--dump-occurrences", "--verdicts-file", "v.json", "--format", "table",
    ]);
    expect(args).toMatchObject({
      start: "2026-05-01", end: "2026-05-31", write: true,
      dumpOccurrences: true, verdictsFile: "v.json", format: "table",
    });
  });
});

describe("resolvePeriod", () => {
  it("uses explicit bounds when both present", () => {
    expect(resolvePeriod(parseArgs(["--start", "2026-05-01", "--end", "2026-05-31"]), "2026-06-16"))
      .toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });

  it("falls back to the current month when a bound is missing", () => {
    expect(resolvePeriod(parseArgs(["--start", "2026-05-01"]), "2026-06-16"))
      .toEqual({ start: "2026-06-01", end: "2026-06-16" });
  });
});

describe("applyVerdicts", () => {
  it("merges a verdict onto its occurrence by id and leaves others bare", () => {
    const report = applyVerdicts(schedule, "2026-06-16", {
      "weekly-budget-status:2026-05-04": { verdict: "DONE", rationale: "Posted on time." },
    });
    expect(report.runDate).toBe("2026-06-16");
    expect(report.occurrences[0].verdict).toBe("DONE");
    expect(report.occurrences[0].rationale).toBe("Posted on time.");
    expect(report.skipped).toHaveLength(1);
  });
});

describe("toCsv", () => {
  it("emits one row per occurrence with a stable header and quotes free text", () => {
    const report = applyVerdicts(schedule, "2026-06-16", {
      "weekly-budget-status:2026-05-04": { verdict: "DONE", rationale: "On time, no issues" },
    });
    const csv = toCsv(report);
    expect(csv.split("\n")[0]).toBe(
      "obligation,channel,dueDate,status,verdict,rationale,evidenceCount",
    );
    expect(csv).toContain("Weekly budget status report,budgets,2026-05-04,NEEDS_REVIEW,DONE,");
    expect(csv).toContain('"On time, no issues"');
    expect(csv.endsWith("\n")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/policyReport.test.ts`
Expected: FAIL — cannot find module `./policyReport`.

- [ ] **Step 3: Implement the shaping module**

`scripts/policyReport.ts`:

```ts
/**
 * Pure CLI shaping for Policy Execution Tracking: arg parsing, period
 * resolution, verdict merging, and the table/CSV views. No server/Next imports —
 * unit-tested, mirrors scripts/jiraReport.ts. The domain logic lives in
 * ../lib/policySchedule.
 */
import type {
  Occurrence,
  PolicySchedule,
  SkippedObligation,
} from "../lib/policySchedule";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OutputFormat = "json" | "table";
export type Verdict = "DONE" | "LATE" | "PARTIAL" | "MISSING";

export interface Period {
  start: string;
  end: string;
}

export interface ParsedArgs {
  start?: string;
  end?: string;
  format: OutputFormat;
  /** Persist the report under reports/policy/. */
  write: boolean;
  /** Print the NEEDS_REVIEW occurrences (with candidates) as JSON and exit. */
  dumpOccurrences: boolean;
  /** Read verdicts (occurrenceId → {verdict,rationale}) from this JSON file; implies --write. */
  verdictsFile?: string;
}

export interface VerdictEntry {
  verdict: Verdict;
  rationale: string;
}

/** Map of occurrenceId → verdict, as produced by the classification subagents. */
export type VerdictMap = Record<string, VerdictEntry>;

/** An occurrence with the (optional) Claude-assigned verdict merged in. */
export interface OccurrenceReport extends Occurrence {
  verdict?: Verdict;
  rationale?: string;
}

/** The committed report — same shape `GET /api/policy?period=…` returns. */
export interface PolicyReport {
  period: Period;
  runDate: string;
  occurrences: OccurrenceReport[];
  skipped: SkippedObligation[];
}

/** Parse the supported flags from raw CLI args. Unknown flags ignored. */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    start: undefined,
    end: undefined,
    format: "json",
    write: false,
    dumpOccurrences: false,
    verdictsFile: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") {
      args.start = value;
      i += 1;
    } else if (flag === "--end") {
      args.end = value;
      i += 1;
    } else if (flag === "--format") {
      args.format = value === "table" ? "table" : "json";
      i += 1;
    } else if (flag === "--write") {
      args.write = true;
    } else if (flag === "--dump-occurrences") {
      args.dumpOccurrences = true;
    } else if (flag === "--verdicts-file") {
      args.verdictsFile = value;
      i += 1;
    }
  }
  return args;
}

/** First day of `today`'s month through `today` (both YYYY-MM-DD). */
export function defaultMonthWindow(today: string): Period {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

/**
 * Resolve the reporting window: explicit `--start`/`--end` only when BOTH are
 * present; otherwise the current month. Throws on a malformed explicit bound.
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
  return { start, end };
}

/** Merge verdicts onto the schedule's occurrences (by id) → the committed report. */
export function applyVerdicts(
  schedule: PolicySchedule,
  runDate: string,
  verdicts?: VerdictMap,
): PolicyReport {
  const occurrences: OccurrenceReport[] = schedule.occurrences.map((o) => {
    const v = verdicts?.[o.id];
    return v ? { ...o, verdict: v.verdict, rationale: v.rationale } : { ...o };
  });
  return { period: schedule.period, runDate, occurrences, skipped: schedule.skipped };
}

/** Render a PolicyReport as a compact human-readable table. */
export function formatTable(report: PolicyReport): string {
  const lines: string[] = [];
  lines.push(`Policy execution   ${report.period.start} … ${report.period.end}   (as of ${report.runDate})`);
  lines.push("");
  lines.push("Due date     Status        Verdict   Ev  Obligation");
  lines.push("----------   -----------   -------   --  ----------");
  if (report.occurrences.length === 0) {
    lines.push("(no scheduled occurrences in this period)");
  } else {
    for (const o of report.occurrences) {
      lines.push(
        `${o.dueDate}   ${o.status.padEnd(11)}   ${(o.verdict ?? "—").padEnd(7)}   ${String(o.candidates.length).padStart(2)}  ${o.title}`,
      );
    }
  }
  if (report.skipped.length > 0) {
    lines.push("");
    lines.push("Skipped (not scheduled in v1):");
    for (const s of report.skipped) lines.push(`  ${s.obligationId} — ${s.reason}`);
  }
  return lines.join("\n");
}

/** Quote a CSV field per RFC 4180 only when it contains `,`, `"`, or newline. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Flat per-occurrence CSV (`obligation,channel,dueDate,status,verdict,rationale,
 * evidenceCount`), one row per occurrence, trailing newline. Lossy: the evidence
 * detail (authors, excerpts, permalinks) and the skipped list live only in the
 * JSON/table views.
 */
export function toCsv(report: PolicyReport): string {
  const lines = ["obligation,channel,dueDate,status,verdict,rationale,evidenceCount"];
  for (const o of report.occurrences) {
    lines.push(
      [
        csvField(o.title),
        csvField(o.channel),
        o.dueDate,
        o.status,
        o.verdict ?? "",
        csvField(o.rationale ?? ""),
        String(o.candidates.length),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/policyReport.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/policyReport.ts scripts/policyReport.test.ts
git commit -m "$(cat <<'EOF'
Add pure policy CLI shaping (args, verdict merge, table, CSV)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: CLI runner

**Files:**
- Create: `scripts/policy.ts`

No unit test (I/O + network wiring, like `scripts/jira.ts`). Verified by running it.

- [ ] **Step 1: Implement the CLI**

`scripts/policy.ts`:

```ts
/**
 * CLI: fetch tracked Slack channels for a window, build the deterministic policy
 * schedule, and print/persist it.
 *
 * Usage:
 *   npm run policy -- --start 2026-05-01 --end 2026-05-31 [--format table]
 *   npm run policy -- --start … --end … --dump-occurrences   (JSON for the classifier subagents; exits)
 *   npm run policy -- --start … --end … --verdicts-file v.json   (merge verdicts + write artifacts)
 * Defaults to the current calendar month (UTC) when bounds are omitted.
 *
 * `--write` persists reports/policy/<period>.{json,csv}. `--verdicts-file` reads
 * a JSON object (occurrenceId → {verdict, rationale}) produced by Claude Code
 * sonnet subagents and implies `--write`. `--dump-occurrences` prints the
 * NEEDS_REVIEW occurrences (with candidate evidence + obligation description)
 * those subagents consume, then exits — no write.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so the
 * `server-only` import in ../lib/slack resolves to its empty module.
 */
import { readFileSync } from "node:fs";
import { fetchMessages } from "../lib/slack";
import { buildSchedule } from "../lib/policySchedule";
import { OBLIGATIONS } from "../lib/policyRegistry";
import { writeReport } from "../lib/reports";
import {
  applyVerdicts,
  formatTable,
  parseArgs,
  resolvePeriod,
  toCsv,
  type VerdictMap,
} from "./policyReport";

/** Today's date (YYYY-MM-DD) in UTC. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadVerdictsFile(path: string): VerdictMap {
  return JSON.parse(readFileSync(path, "utf8")) as VerdictMap;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayUtc());

  const messages = await fetchMessages(period);
  const schedule = buildSchedule(OBLIGATIONS, messages, period, todayUtc());

  // --dump-occurrences: emit the occurrences needing a verdict (with evidence +
  // obligation description) for the classifier subagents, then exit.
  if (args.dumpOccurrences) {
    const byId = new Map(OBLIGATIONS.map((o) => [o.id, o]));
    const dump = schedule.occurrences
      .filter((o) => o.status === "NEEDS_REVIEW")
      .map((o) => ({ ...o, description: byId.get(o.obligationId)?.description ?? "" }));
    console.log(JSON.stringify(dump, null, 2));
    return;
  }

  const verdicts = args.verdictsFile ? loadVerdictsFile(args.verdictsFile) : undefined;
  if (verdicts) {
    process.stderr.write(
      `policy: loaded ${Object.keys(verdicts).length} verdicts from ${args.verdictsFile}\n`,
    );
  }
  const report = applyVerdicts(schedule, todayUtc(), verdicts);

  if (args.format === "table") {
    console.log(formatTable(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  if (args.write || args.verdictsFile) {
    const { jsonPath, csvPath } = writeReport("policy", period, {
      json: JSON.stringify(report, null, 2),
      csv: toCsv(report),
    });
    process.stderr.write(
      `policy: wrote ${jsonPath} and ${csvPath} (${report.occurrences.length} occurrences, ${report.skipped.length} skipped)\n`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`policy: ${message}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it errors cleanly without a token**

Run: `npm run policy -- --start 2026-05-01 --end 2026-05-31`
Expected: exits non-zero printing `policy: SLACK_TOKEN is not set on the server.` (when `.env` has no `SLACK_TOKEN`). If a valid token + real channel ids are configured, it instead prints the report JSON.

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/policy.ts
git commit -m "$(cat <<'EOF'
Add policy CLI runner (fetch, schedule, dump/verdicts/write)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Hybrid API route

**Files:**
- Create: `app/api/policy/route.ts`

- [ ] **Step 1: Implement the route**

`app/api/policy/route.ts`:

```ts
import { NextResponse } from "next/server";
import { fetchMessages, SlackError } from "@/lib/slack";
import { buildSchedule } from "@/lib/policySchedule";
import { OBLIGATIONS } from "@/lib/policyRegistry";
import { listPeriods, parsePeriodKey, readReportJson } from "@/lib/reports";

// Token + Slack calls live only on the server; never statically cache.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FEATURE = "policy";

/**
 * GET /api/policy — hybrid read path:
 *   ?periods=1            → { periods } committed period keys (newest first)
 *   ?period=<key>         → the committed PolicyReport JSON (with verdicts), or 404
 *   ?start=&end=[&refresh]→ live deterministic schedule (no verdicts; the only
 *                           network path)
 *
 * Committing artifacts is the CLI's job (`npm run policy -- --write`); this route
 * only reads them. The live path never classifies — verdicts come only from
 * committed reports.
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

  const start = searchParams.get("start");
  const end = searchParams.get("end");
  if (!start || !end) {
    return NextResponse.json(
      { error: "Provide `period`, `periods`, or both `start` and `end`." },
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
    return NextResponse.json({ error: "`start` must be on or before `end`." }, { status: 400 });
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const messages = await fetchMessages({ start, end });
    const schedule = buildSchedule(OBLIGATIONS, messages, { start, end }, today);
    // Live shape mirrors PolicyReport but carries no verdicts.
    return NextResponse.json({
      period: schedule.period,
      runDate: today,
      occurrences: schedule.occurrences,
      skipped: schedule.skipped,
    });
  } catch (error) {
    if (error instanceof SlackError) {
      const status = error.status ? 502 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/policy/route.ts
git commit -m "$(cat <<'EOF'
Add hybrid /api/policy route (committed reports + live schedule)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Web page + nav tab

**Files:**
- Create: `app/(dashboard)/policy-tracking/page.tsx`
- Modify: `app/(dashboard)/layout.tsx:8-12` (TABS array)

- [ ] **Step 1: Implement the page**

`app/(dashboard)/policy-tracking/page.tsx`:

```tsx
"use client";

import { usePeriodReport } from "@/lib/usePeriodReport";
import type { CandidateMessage, OccurrenceStatus, SkippedObligation } from "@/lib/policySchedule";

type Verdict = "DONE" | "LATE" | "PARTIAL" | "MISSING";

interface OccurrenceReport {
  id: string;
  obligationId: string;
  title: string;
  channel: string;
  dueDate: string;
  windowStart: string;
  windowEnd: string;
  status: OccurrenceStatus;
  candidates: CandidateMessage[];
  verdict?: Verdict;
  rationale?: string;
}

interface PolicyReport {
  period: { start: string; end: string };
  runDate: string;
  occurrences: OccurrenceReport[];
  skipped: SkippedObligation[];
}

const BADGE: Record<string, string> = {
  DONE: "bg-emerald-100 text-emerald-800",
  LATE: "bg-amber-100 text-amber-800",
  PARTIAL: "bg-amber-100 text-amber-800",
  MISSING: "bg-rose-100 text-rose-800",
  NEEDS_REVIEW: "bg-slate-100 text-slate-700",
  PENDING: "bg-slate-100 text-slate-500",
};

export default function PolicyTrackingPage() {
  const {
    periods,
    currentKey,
    selected,
    report,
    loading,
    error,
    canRefresh,
    select,
    refreshLive,
  } = usePeriodReport<PolicyReport>({
    feature: "policy",
    mapCommitted: (body) => body as PolicyReport,
    mapLive: (body) => body as PolicyReport,
    liveQuery: ({ start, end }) => `start=${start}&end=${end}`,
  });

  const options = periods.includes(currentKey) ? periods : [currentKey, ...periods];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          Policy Tracking
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Per-obligation execution status from the tracked Slack channels. Renders
          the committed report (with verdicts) for the selected period; the current
          month can be refreshed against live Slack (deterministic status only).
        </p>
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Period
            <select
              value={selected ?? currentKey}
              onChange={(e) => select(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums"
            >
              {options.map((key) => (
                <option key={key} value={key}>
                  {key}
                  {key === currentKey ? " (current)" : ""}
                  {!periods.includes(key) ? " — not committed" : ""}
                </option>
              ))}
            </select>
          </label>
          {canRefresh && (
            <button
              type="button"
              onClick={refreshLive}
              disabled={loading}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Loading…" : "Refresh live"}
            </button>
          )}
          {loading && <span className="text-xs text-slate-400">Loading…</span>}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {error}
        </div>
      )}

      {report && (
        <>
          <p className="text-xs text-slate-400">
            As of {report.runDate} · {report.period.start} … {report.period.end}
          </p>

          {report.occurrences.length === 0 ? (
            <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
              No scheduled occurrences in this period.
            </p>
          ) : (
            <ul className="space-y-2">
              {report.occurrences.map((o) => (
                <li key={o.id} className="rounded-md border border-slate-200 bg-white px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[o.verdict ?? o.status] ?? "bg-slate-100 text-slate-700"}`}
                    >
                      {o.verdict ?? o.status}
                    </span>
                    <span className="font-mono text-xs text-slate-500">{o.dueDate}</span>
                    <span className="text-sm font-medium text-slate-900">{o.title}</span>
                    <span className="text-xs text-slate-400">#{o.channel}</span>
                  </div>
                  {o.rationale && (
                    <p className="mt-1 text-xs text-slate-600">{o.rationale}</p>
                  )}
                  {o.candidates.length > 0 && (
                    <ul className="mt-2 space-y-1 border-l border-slate-100 pl-3">
                      {o.candidates.map((c, i) => (
                        <li key={i} className="text-xs text-slate-500">
                          <span className="font-medium text-slate-700">{c.author}</span>{" "}
                          <span className="text-slate-400">{c.isoTime.slice(0, 16).replace("T", " ")}</span>
                          {" — "}
                          {c.permalink ? (
                            <a href={c.permalink} className="text-sky-600 hover:underline" target="_blank" rel="noreferrer">
                              {c.excerpt}
                            </a>
                          ) : (
                            c.excerpt
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}

          {report.skipped.length > 0 && (
            <section className="space-y-1">
              <h2 className="text-sm font-semibold text-slate-900">Not scheduled (v1)</h2>
              <ul className="text-xs text-slate-500">
                {report.skipped.map((s) => (
                  <li key={s.obligationId}>
                    {s.obligationId} — {s.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {!report && !error && !loading && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
          No committed reports yet. Select the current month and Refresh live.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the nav tab**

In `app/(dashboard)/layout.tsx`, change the `TABS` array (lines 8–12) to add a fourth entry:

```tsx
const TABS: { href: string; label: string; enabled: boolean }[] = [
  { href: "/field-ops", label: "Field Ops", enabled: true },
  { href: "/dev-reporting", label: "Dev Reporting", enabled: true },
  { href: "/github-reporting", label: "GitHub Activity", enabled: true },
  { href: "/policy-tracking", label: "Policy Tracking", enabled: true },
];
```

- [ ] **Step 3: Verify build + lint + types**

Run: `npx tsc --noEmit && npm run lint`
Expected: no type errors; lint clean.

- [ ] **Step 4: Commit**

```bash
git add "app/(dashboard)/policy-tracking/page.tsx" "app/(dashboard)/layout.tsx"
git commit -m "$(cat <<'EOF'
Add Policy Tracking dashboard page and nav tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Feature skill

**Files:**
- Create: `.claude/skills/policy-tracking/SKILL.md`

- [ ] **Step 1: Write the skill**

`.claude/skills/policy-tracking/SKILL.md`:

```markdown
---
name: policy-tracking
description: Use when answering whether operational policies are being executed in Slack — did the weekly/monthly budget status, the Tuesday stats publication, or another required post actually happen on time, by the right person, over a date range. Pulls live data from the tracked Slack channels via the repo's CLI, and persists a period as a committed JSON+CSV report with per-occurrence verdicts.
---

# Policy Execution Tracking

Answer "is this policy actually being followed?" using live Slack data through this repo's CLI, then commit a reviewed monthly report.

## Domain (must-know)

- An **obligation** (lib/policyRegistry.ts) is a recurring requirement: who must post what, in which channel, on what cadence, with how many working days of grace, effective over a date range. Policies evolve, so each obligation has `effectiveFrom`/`effectiveTo` and only contributes occurrences while effective.
- The deterministic CLI assigns each occurrence a **status**: `MISSING` (past due + grace, zero candidate posts), `PENDING` (not yet due / still within grace), `NEEDS_REVIEW` (a candidate post exists — needs a judgement). Calendar math is UTC; working days are Mon–Fri (holidays not modeled).
- The **verdict** (`DONE`/`LATE`/`PARTIAL`/`MISSING`) is a human/AI judgement layered on the `NEEDS_REVIEW` occurrences. It is NOT computed — it comes only from a committed report. The web's live Refresh shows status only, never verdicts.
- **Per-event** obligations (drone-remainder report, unrecorded-video/-dataset explanations) are not scheduled in v1 — they appear in `skipped`, not as occurrences.

## When to use

Questions like: "did Maryna post the weekly budget status every Monday in May?", "was the Tuesday stats publication missed last month?", "show this month's policy compliance so far", "which required reports are missing?".

## How to use

Run the CLI (defaults to the current month, UTC, if you omit the dates):

```bash
npm run policy -- --start 2026-05-01 --end 2026-05-31 --format table
```

It prints the report (same shape as `GET /api/policy?period=<key>`): `period`, `runDate`, `occurrences[]` (`{ id, obligationId, title, channel, dueDate, windowStart, windowEnd, status, candidates[], verdict?, rationale? }`), and `skipped[]`. Answer compliance questions from `occurrences` (status, and verdict when present).

To persist a period as a committed report, add `--write` — it writes two sidecars under `reports/policy/` keyed by period (`2026-05` for a single month): a lossless `<period>.json` (the web's render source) and a flat `<period>.csv` (`obligation,channel,dueDate,status,verdict,rationale,evidenceCount`; the evidence detail lives only in the JSON). The web renders the committed JSON via `GET /api/policy?period=<key>` (period list at `?periods=1`); the current month can be refreshed against live Slack (`?refresh=1&start=&end=`), showing deterministic status without verdicts.

### Monthly compliance requests → classify NEEDS_REVIEW via sonnet subagents, then commit

When asked to produce a month's compliance record, classify the `NEEDS_REVIEW` occurrences with **Claude Code sonnet subagents** (one per month), then feed the verdicts back through the CLI so the committed report carries them:

1. `npm run policy -- --start <YYYY-MM-01> --end <YYYY-MM-DD> --dump-occurrences` → the `NEEDS_REVIEW` occurrences as JSON, each with its `id`, obligation `title`/`description`, the candidate Slack posts (author, time, excerpt, permalink), and the `windowStart`/`windowEnd`/`dueDate`. Save one file per month.
2. Dispatch one **sonnet** subagent per month (`Agent` tool, `model: sonnet`). It reads that file and, for each occurrence, decides a verdict against the obligation:
   - `DONE` — a candidate from a responsible person fulfils the obligation on time (within the window).
   - `LATE` — fulfilled, but the qualifying post lands after the due date (still within the window the scheduler allowed).
   - `PARTIAL` — partially fulfilled (e.g. some but not all required content), or fulfilled by a non-responsible person.
   - `MISSING` — the candidates do not actually fulfil the obligation (off-topic chatter).
   It writes a JSON object `{ "<occurrenceId>": { "verdict": "...", "rationale": "<one line>" } }` to a file. Use the obligation `description` + `keywords` as the rubric; keep Ukrainian proper nouns; rationale is one short English line.
3. `npm run policy -- --start … --end … --verdicts-file <path> --format table` → the CLI merges the verdicts (no Claude call), prints the table, and writes `reports/policy/<period>.{json,csv}` with verdicts filled. `--verdicts-file` implies `--write`.

Then present each obligation's occurrences with their verdict + rationale. Review the verdicts before committing the artifacts — the committed report is the auditable record.

Dates are inclusive and must be `YYYY-MM-DD`. A missing `SLACK_TOKEN` makes the CLI exit non-zero — tell the user to set it (and the tracked channel ids in `lib/slackChannels.ts`) in `.env` (see `.env.example`).

## Out of scope

This reports whether required posts happened, on the deterministic schedule + a reviewed verdict. It does not judge the *quality* of the work described, enforce penalties, or schedule per-event obligations (drone-remainder, unrecorded-video explanations) — those are surfaced in `skipped`. Report the facts.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/policy-tracking/SKILL.md
git commit -m "$(cat <<'EOF'
Add policy-tracking skill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all suites pass, including `lib/policyRegistry.test.ts`, `lib/policySchedule.test.ts`, `scripts/policyReport.test.ts`.

- [ ] **Step 2: Lint + types**

Run: `npm run lint && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Confirm no client file imports server/fs paths**

Run: `grep -rn "lib/slack\b\|node:fs\|lib/reports" "app/(dashboard)/policy-tracking/page.tsx"`
Expected: no matches (the page only imports `usePeriodReport` and types).

- [ ] **Step 4: (If Slack is configured) end-to-end smoke**

With a valid `SLACK_TOKEN` and real channel ids in `lib/slackChannels.ts`:

Run: `npm run policy -- --start 2026-05-01 --end 2026-05-31 --write`
Expected: writes `reports/policy/2026-05.json` and `reports/policy/2026-05.csv`; re-running is idempotent. Then `npm run dev`, open `/policy-tracking`, confirm the committed period renders and "Refresh live" works for the current month.

---

## Notes for the executor

- **Mirror, don't invent.** Each module has a named twin in the Jira feature; when unsure about a convention (error mapping, JSON shape, hook usage), open the twin.
- **Channel ids are real config, not placeholders.** `lib/slackChannels.ts` ships with `*_REPLACE_ME` ids the operator fills in; the obligation `channel` names must match the channel `name`s.
- **Verdicts never come from the server.** The route's live path returns status only; verdicts exist solely in committed reports written by the CLI.
