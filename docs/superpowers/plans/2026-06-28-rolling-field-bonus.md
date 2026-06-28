# Rolling Field-Bonus Notification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** As each flight day's acceptance settles (verdict ≠ PENDING), post that day's per-person bonus breakdown in the day's Slack verdict thread and DM each participant their (provisional) share — dry-run by default, idempotent.

**Architecture:** A thin notifier layered on the **already-shipped** field-bonus recomputation feature. It reuses `computeBonusReport`/`BonusReport.days` (per-day roster + counted/early/weekend + the 700/200/300 constants), the `field-verdict` report (settled gate), and the `published` table (thread root `ts`). New: per-day amount derivation + Ukrainian messages (pure), name→Slack-id resolution, `openDm`, a `bonus_notified` idempotency table, and `--notify`/`--channel` flags on the existing `scripts/field-bonus.ts`.

**Tech Stack:** TypeScript (strict), Vitest, drizzle-orm + Vercel/Neon Postgres, Slack Web API, Next.js 16.

## Global Constraints

- TypeScript `strict`; import alias `@/*` → repo root.
- Pure `lib/` modules: no React/Next/network/`server-only`/fs imports; unit-tested. Network/secret modules import `server-only`. CLIs run under `node --conditions=react-server --import tsx`.
- Money is **integer грн**. Rate constants come from `lib/fieldBonus.ts` (`TRIP=700`, `EARLY=200`, `WEEKEND=300`) — do NOT re-hardcode them; import them.
- Outward Slack writes are **dry-run by default**; a real send needs `--notify --publish --channel <name>`.
- A day/person is **never notified twice** — every send is gated by the `bonus_notified` table.
- Trigger: notify a day only when its `field-verdict` status is **not** `PENDING`.
- Amount is **provisional** (excludes the monthly drone-loss multiplier); every earned message must say so (Ukrainian) and point payout questions to the finance operator (Марина).
- Unmatched name → **skip the DM** and flag; never DM a guessed id.
- Reuse existing helpers: `readReportJson`/`periodKey` (`lib/reports`), `readPublished` (`lib/published`), `TRACKED_CHANNELS` (`lib/slackChannels`), `DayVerdict`/`VerdictStatus` (`lib/fieldDayVerdict`), `DayBonus`/`BonusReport` (`lib/fieldBonus`), `computeBonusReport` (`lib/computeBonuses`).
- See `docs/superpowers/specs/2026-06-28-rolling-field-bonus-design.md`.

---

### Task 1: Per-day amounts + Ukrainian messages — `lib/bonusNotify.ts`

**Files:**
- Create: `lib/bonusNotify.ts`
- Test: `lib/bonusNotify.test.ts`

**Interfaces:**
- Consumes: `DayBonus`, `TRIP`, `EARLY`, `WEEKEND` from `lib/fieldBonus`.
- Produces:
  - `interface PersonAmount { name: string; base: number; early: number; weekend: number; total: number }`
  - `function dayPersonBonuses(day: DayBonus): PersonAmount[]`
  - `function dayTotal(people: PersonAmount[]): number`
  - `function formatThreadBreakdown(date: string, people: PersonAmount[]): string`
  - `function formatDm(date: string, person: PersonAmount): string`
  - `function formatNoBonusNote(date: string, reason: string): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { dayPersonBonuses, dayTotal, formatThreadBreakdown, formatDm, formatNoBonusNote, type PersonAmount } from "./bonusNotify";
import type { DayBonus } from "./fieldBonus";

const counted = (over: Partial<DayBonus> = {}): DayBonus => ({
  date: "2026-06-19", roster: ["Андріан", "Тарас"], deployMin: 240, videoMin: 10,
  counted: true, early: false, weekend: false, reason: "counted", ...over,
});

describe("dayPersonBonuses", () => {
  it("pays base per roster member on a counted day", () => {
    expect(dayPersonBonuses(counted())).toEqual([
      { name: "Андріан", base: 700, early: 0, weekend: 0, total: 700 },
      { name: "Тарас", base: 700, early: 0, weekend: 0, total: 700 },
    ]);
  });
  it("stacks early + weekend", () => {
    const p = dayPersonBonuses(counted({ early: true, weekend: true }))[0];
    expect(p).toMatchObject({ base: 700, early: 200, weekend: 300, total: 1200 });
  });
  it("returns [] for a non-counted day", () => {
    expect(dayPersonBonuses(counted({ counted: false, reason: "deploy<3h" }))).toEqual([]);
  });
});

describe("messages", () => {
  const people: PersonAmount[] = [
    { name: "Андріан", base: 700, early: 200, weekend: 0, total: 900 },
    { name: "Тарас", base: 700, early: 0, weekend: 0, total: 700 },
  ];
  it("thread breakdown lists people, the total, and the provisional caveat", () => {
    const t = formatThreadBreakdown("2026-06-19", people);
    expect(t).toContain("Андріан");
    expect(t).toContain("900");
    expect(t).toContain(String(dayTotal(people))); // 1600
    expect(t).toContain("попередн"); // provisional
  });
  it("DM shows only the recipient + finance pointer, not other names", () => {
    const dm = formatDm("2026-06-19", people[0]);
    expect(dm).toContain("900");
    expect(dm).not.toContain("Тарас");
    expect(dm).toContain("Марин");
  });
  it("no-bonus note carries the reason", () => {
    expect(formatNoBonusNote("2026-06-19", "deploy<3h")).toContain("deploy<3h");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/bonusNotify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/bonusNotify.ts`**

```ts
/**
 * Pure per-day rolling-bonus derivation + Ukrainian messages. Derives each
 * roster member's provisional day amount from a counted DayBonus using the
 * existing rate constants (no new calculator), and formats the thread breakdown,
 * the per-person DM, and the no-bonus thread note. Amounts are PROVISIONAL — they
 * exclude the monthly drone-loss multiplier, which only settles at month-end.
 * No fs/network. See docs/superpowers/specs/2026-06-28-rolling-field-bonus-design.md.
 */
import { TRIP, EARLY, WEEKEND, type DayBonus } from "./fieldBonus";

export interface PersonAmount {
  name: string;
  base: number;
  early: number;
  weekend: number;
  total: number;
}

const PROVISIONAL = "Це попередній розрахунок за день — остаточна сума залежить від місячного коригування втрат бортів.";
const FINANCE = "Питання щодо виплат — до фінансового оператора (Марина).";

export function dayPersonBonuses(day: DayBonus): PersonAmount[] {
  if (!day.counted) return [];
  const early = day.early ? EARLY : 0;
  const weekend = day.weekend ? WEEKEND : 0;
  return day.roster.map((name) => ({ name, base: TRIP, early, weekend, total: TRIP + early + weekend }));
}

export function dayTotal(people: PersonAmount[]): number {
  return people.reduce((s, p) => s + p.total, 0);
}

function parts(p: PersonAmount): string {
  const bits = [`база ${p.base}`];
  if (p.early > 0) bits.push(`ранній +${p.early}`);
  if (p.weekend > 0) bits.push(`вихідний +${p.weekend}`);
  return bits.join(", ");
}

export function formatThreadBreakdown(date: string, people: PersonAmount[]): string {
  const lines = [`💰 Бонуси за ${date} (попередньо): разом ${dayTotal(people)} грн`];
  for (const p of people) lines.push(`• ${p.name} — ${p.total} грн (${parts(p)})`);
  lines.push(PROVISIONAL);
  return lines.join("\n");
}

export function formatDm(date: string, person: PersonAmount): string {
  return [
    `💰 Твій польовий бонус за ${date}: ${person.total} грн (${parts(person)}).`,
    PROVISIONAL,
    FINANCE,
  ].join("\n");
}

export function formatNoBonusNote(date: string, reason: string): string {
  return `ℹ️ Бонус за ${date} не нараховано: ${reason}.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/bonusNotify.test.ts`
Expected: PASS (6 tests). (Confirm `TRIP`/`EARLY`/`WEEKEND` are exported from `lib/fieldBonus.ts` — they are, lines 11–13.)

- [ ] **Step 5: Commit**

```bash
git add lib/bonusNotify.ts lib/bonusNotify.test.ts
git commit -m "feat(bonus): pure per-day amount derivation + Ukrainian notify messages"
```

---

### Task 2: Name → Slack id — `lib/fieldSlackIds.ts` + `listUsers`

**Files:**
- Create: `lib/fieldSlackIds.ts`
- Modify: `lib/slack.ts` (add `listUsers`)
- Test: `lib/fieldSlackIds.test.ts`

**Interfaces:**
- Consumes: the live directory shape `{ id: string; name: string }[]`.
- Produces:
  - `const SLACK_ID_OVERRIDES: Record<string, string>`
  - `function matchSlackId(name: string, users: { id: string; name: string }[], overrides?: Record<string, string>): string | null`
  - (`lib/slack.ts`) `async function listUsers(): Promise<{ id: string; name: string }[]>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { matchSlackId } from "./fieldSlackIds";

const users = [
  { id: "U1", name: "Андріан" },
  { id: "U2", name: "Тарас Шевченко" },
  { id: "U3", name: "Андрій" },
];

describe("matchSlackId", () => {
  it("uses an override first", () => {
    expect(matchSlackId("Андріан", users, { "Андріан": "UX" })).toBe("UX");
  });
  it("matches an exact display/real name", () => {
    expect(matchSlackId("Андріан", users)).toBe("U1");
  });
  it("returns null when no exact match exists (avoid guessing)", () => {
    expect(matchSlackId("Максим", users)).toBeNull();
  });
  it("returns null on an ambiguous match", () => {
    const dup = [{ id: "U1", name: "Тарас" }, { id: "U2", name: "Тарас" }];
    expect(matchSlackId("Тарас", dup)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/fieldSlackIds.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/fieldSlackIds.ts`**

```ts
/**
 * Resolve a resolved roster NAME (from lib/fieldRoster) to a Slack user id for
 * DMs. Override map first (hand-maintained for nicknames the directory can't
 * match), then an EXACT, UNAMBIGUOUS match against the live directory; otherwise
 * null so the caller skips the DM and flags it — we never DM a guessed id. Pure.
 */
export const SLACK_ID_OVERRIDES: Record<string, string> = {
  // "Constв name": "U0XXXXX",  // fill in as misses surface
};

export function matchSlackId(
  name: string,
  users: { id: string; name: string }[],
  overrides: Record<string, string> = SLACK_ID_OVERRIDES,
): string | null {
  if (overrides[name]) return overrides[name];
  const exact = users.filter((u) => u.name === name);
  if (exact.length === 1) return exact[0].id;
  return null;
}
```

- [ ] **Step 4: Add `listUsers` to `lib/slack.ts`**

Just below the private `userMap()` function, add:

```ts
/** Public directory snapshot [{ id, name }] from a users.list page-walk. */
export async function listUsers(): Promise<{ id: string; name: string }[]> {
  const map = await userMap();
  return [...map.entries()].map(([id, name]) => ({ id, name }));
}
```

- [ ] **Step 5: Run test + type-check**

Run: `npx vitest run lib/fieldSlackIds.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: tests PASS (4); no type errors.

- [ ] **Step 6: Commit**

```bash
git add lib/fieldSlackIds.ts lib/slack.ts lib/fieldSlackIds.test.ts
git commit -m "feat(bonus): name->Slack id resolution (override + exact match) + listUsers"
```

---

### Task 3: Slack DM — `openDm`

**Files:**
- Modify: `lib/slack.ts`

**Interfaces:**
- Consumes: existing `API`/`token`/`SlackError`/`SlackOk` in `lib/slack.ts`.
- Produces: `async function openDm(userId: string): Promise<string>` (DM channel id).

No unit test (network/server-only, consistent with the rest of `lib/slack.ts`); verified via the CLI in Task 6.

- [ ] **Step 1: Add `openDm` near `postMessage`**

```ts
/**
 * Open (or fetch) the bot↔user DM channel via conversations.open and return its
 * channel id for postMessage. SERVER-ONLY; needs `im:write` (+ `chat:write` to
 * post). Throws SlackError on failure.
 */
export async function openDm(userId: string): Promise<string> {
  const res = await fetch(`${API}/conversations.open`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json; charset=utf-8" },
    cache: "no-store",
    body: JSON.stringify({ users: userId }),
  });
  if (!res.ok) throw new SlackError(`Slack conversations.open returned ${res.status} ${res.statusText}`, res.status);
  const body = (await res.json()) as SlackOk & { channel?: { id?: string } };
  if (!body.ok || !body.channel?.id) {
    throw new SlackError(`Slack conversations.open error: ${body.error ?? "unknown"} (is the im:write scope granted?)`, 502);
  }
  return body.channel.id;
}
```

(Match `API`, `token`, `SlackError`, `SlackOk` to the existing identifiers in `lib/slack.ts` — grep `const API`, `function token`, `class SlackError`, `interface SlackOk`. They are already used by `postMessage` just above.)

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/slack.ts
git commit -m "feat(slack): openDm (conversations.open) for per-person DMs"
```

---

### Task 4: `bonus_notified` table + `lib/bonusNotified.ts`

**Files:**
- Modify: `lib/schema.ts` (add `bonusNotified` table)
- Create: drizzle migration via `npm run db:generate`
- Create: `lib/bonusNotified.ts`
- Test: `lib/bonusNotified.test.ts`

**Interfaces:**
- Consumes: `db`/`schema` (`lib/db`), `periodKey`/`Period` (`lib/period`).
- Produces:
  - `interface DmRecord { slackId: string; ts: string; amount: number }`
  - `interface NotifiedEntry { date: string; threadTs?: string; dms: DmRecord[] }`
  - `type NotifiedLog = Record<string, NotifiedEntry>`
  - pure: `isThreadNotified(log,date)`, `isDmSent(log,date,slackId)`, `recordThread(log,date,threadTs)`, `recordDm(log,date,slackId,ts,amount)`
  - DB: `async readNotified(period)`, `async writeNotified(period, log)`

- [ ] **Step 1: Add the table to `lib/schema.ts`** (append after the `published` table)

```ts
/** Rolling field-bonus notifications (idempotency): thread note + per-person DMs. */
export const bonusNotified = pgTable(
  "bonus_notified",
  {
    period: text("period").notNull(),
    date: text("date").notNull(),
    threadTs: text("thread_ts"),
    dms: jsonb("dms").notNull(), // { slackId, ts, amount }[]
  },
  (t) => [primaryKey({ columns: [t.period, t.date] })],
);
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/00NN_*.sql` creating `bonus_notified`. Inspect it — it must only ADD the table.

- [ ] **Step 3: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { isThreadNotified, isDmSent, recordThread, recordDm, type NotifiedLog } from "./bonusNotified";

describe("bonusNotified pure helpers", () => {
  it("records + detects a thread note", () => {
    const log = recordThread({}, "2026-06-19", "111.1");
    expect(isThreadNotified(log, "2026-06-19")).toBe(true);
    expect(isThreadNotified(log, "2026-06-20")).toBe(false);
  });
  it("records + detects a per-person DM", () => {
    let log: NotifiedLog = recordThread({}, "2026-06-19", "111.1");
    log = recordDm(log, "2026-06-19", "U1", "222.2", 900);
    expect(isDmSent(log, "2026-06-19", "U1")).toBe(true);
    expect(isDmSent(log, "2026-06-19", "U2")).toBe(false);
  });
  it("does not mutate the input", () => {
    const a: NotifiedLog = {};
    expect(recordThread(a, "2026-06-19", "1.1")).not.toBe(a);
    expect(a).toEqual({});
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run lib/bonusNotified.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `lib/bonusNotified.ts`** (mirrors `lib/published.ts`)

```ts
/**
 * Committed-in-DB record of which rolling field-bonus notifications have been
 * sent, so a re-run (incl. an unattended cron) never double-notifies a day or a
 * person. One row per (period, date). Pure merge helpers + thin drizzle
 * read/write. NOT server-only (db, no secret literal). Mirrors lib/published.ts.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { periodKey, type Period } from "./period";

export interface DmRecord { slackId: string; ts: string; amount: number }
export interface NotifiedEntry { date: string; threadTs?: string; dms: DmRecord[] }
export type NotifiedLog = Record<string, NotifiedEntry>;

export function isThreadNotified(log: NotifiedLog, date: string): boolean {
  return log[date]?.threadTs != null;
}
export function isDmSent(log: NotifiedLog, date: string, slackId: string): boolean {
  return (log[date]?.dms ?? []).some((d) => d.slackId === slackId);
}
export function recordThread(log: NotifiedLog, date: string, threadTs: string): NotifiedLog {
  const prev = log[date] ?? { date, dms: [] };
  return { ...log, [date]: { ...prev, date, threadTs } };
}
export function recordDm(log: NotifiedLog, date: string, slackId: string, ts: string, amount: number): NotifiedLog {
  const prev = log[date] ?? { date, dms: [] };
  if (prev.dms.some((d) => d.slackId === slackId)) return log;
  return { ...log, [date]: { ...prev, date, dms: [...prev.dms, { slackId, ts, amount }] } };
}

export async function readNotified(period: Period): Promise<NotifiedLog> {
  const key = periodKey(period);
  const rows = await db.select().from(schema.bonusNotified).where(eq(schema.bonusNotified.period, key));
  const log: NotifiedLog = {};
  for (const r of rows) log[r.date] = { date: r.date, threadTs: r.threadTs ?? undefined, dms: (r.dms as DmRecord[]) ?? [] };
  return log;
}
export async function writeNotified(period: Period, log: NotifiedLog): Promise<void> {
  const key = periodKey(period);
  for (const entry of Object.values(log)) {
    const values = { period: key, date: entry.date, threadTs: entry.threadTs ?? null, dms: entry.dms };
    await db.insert(schema.bonusNotified).values(values)
      .onConflictDoUpdate({ target: [schema.bonusNotified.period, schema.bonusNotified.date], set: values });
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run lib/bonusNotified.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/schema.ts drizzle/ lib/bonusNotified.ts lib/bonusNotified.test.ts
git commit -m "feat(bonus): bonus_notified idempotency table + helpers"
```

---

### Task 5: Notify plan + flags in `scripts/fieldBonusReport.ts`

**Files:**
- Modify: `scripts/fieldBonusReport.ts` (extend `BonusArgs`/`parseArgs`; add the notify plan + dry-run)
- Test: `scripts/fieldBonusReport.test.ts` (add cases)

**Interfaces:**
- Consumes: `DayBonus` (`lib/fieldBonus`); `dayPersonBonuses`/`PersonAmount` (`lib/bonusNotify`); `NotifiedLog`/`isThreadNotified`/`isDmSent` (`lib/bonusNotified`); `VerdictStatus` (`lib/fieldDayVerdict`).
- Produces:
  - extend `BonusArgs` with `notify: boolean; channel?: string`
  - `interface NotifyTarget { name: string; amount: PersonAmount; slackId: string | null }`
  - `interface NotifyPlanItem { date: string; earned: boolean; reason: string; people: PersonAmount[]; threadPending: boolean; pendingDms: NotifyTarget[]; unmatched: string[]; published: boolean }`
  - `function buildNotifyPlan(input: { days: DayBonus[]; verdictByDate: Map<string, VerdictStatus>; publishedDates: Set<string>; slackIdByName: Map<string, string | null>; log: NotifiedLog }): NotifyPlanItem[]`
  - `function formatNotifyDryRun(plan: NotifyPlanItem[], channel?: string): string`

- [ ] **Step 1: Write the failing test (append to `scripts/fieldBonusReport.test.ts`)**

```ts
import { parseArgs as parseBonusArgs, buildNotifyPlan, formatNotifyDryRun } from "./fieldBonusReport";
import type { DayBonus } from "../lib/fieldBonus";

const day = (over: Partial<DayBonus> = {}): DayBonus => ({
  date: "2026-06-19", roster: ["Андріан", "Тарас"], deployMin: 240, videoMin: 10,
  counted: true, early: false, weekend: false, reason: "counted", ...over,
});

describe("notify flags + plan", () => {
  it("parses --notify and --channel", () => {
    const a = parseBonusArgs(["--notify", "--channel", "field-qa", "--publish"]);
    expect(a.notify).toBe(true);
    expect(a.channel).toBe("field-qa");
    expect(a.publish).toBe(true);
  });
  it("queues a thread + only matched, unsent DMs for a settled earned day", () => {
    const plan = buildNotifyPlan({
      days: [day()],
      verdictByDate: new Map([["2026-06-19", "ACCEPTED"]]),
      publishedDates: new Set(["2026-06-19"]),
      slackIdByName: new Map([["Андріан", "U1"], ["Тарас", null]]),
      log: {},
    });
    expect(plan[0].threadPending).toBe(true);
    expect(plan[0].pendingDms.map((t) => t.name)).toEqual(["Андріан"]);
    expect(plan[0].unmatched).toEqual(["Тарас"]);
  });
  it("skips a PENDING day entirely", () => {
    const plan = buildNotifyPlan({
      days: [day()], verdictByDate: new Map([["2026-06-19", "PENDING"]]),
      publishedDates: new Set(["2026-06-19"]), slackIdByName: new Map(), log: {},
    });
    expect(plan).toHaveLength(0);
  });
  it("marks a non-counted settled day as no-bonus (thread note, no DMs)", () => {
    const plan = buildNotifyPlan({
      days: [day({ counted: false, reason: "deploy<3h" })],
      verdictByDate: new Map([["2026-06-19", "NEEDS_REVIEW"]]),
      publishedDates: new Set(["2026-06-19"]), slackIdByName: new Map(), log: {},
    });
    expect(plan[0].earned).toBe(false);
    expect(plan[0].threadPending).toBe(true);
    expect(plan[0].pendingDms).toHaveLength(0);
  });
  it("skips an already thread-notified + DMed day", () => {
    const plan = buildNotifyPlan({
      days: [day()], verdictByDate: new Map([["2026-06-19", "ACCEPTED"]]),
      publishedDates: new Set(["2026-06-19"]),
      slackIdByName: new Map([["Андріан", "U1"], ["Тарас", "U2"]]),
      log: { "2026-06-19": { date: "2026-06-19", threadTs: "1.1", dms: [{ slackId: "U1", ts: "2.2", amount: 700 }, { slackId: "U2", ts: "3.3", amount: 700 }] } },
    });
    expect(plan[0].threadPending).toBe(false);
    expect(plan[0].pendingDms).toHaveLength(0);
  });
  it("flags an unpublished day (cannot reply in a missing thread)", () => {
    const plan = buildNotifyPlan({
      days: [day()], verdictByDate: new Map([["2026-06-19", "ACCEPTED"]]),
      publishedDates: new Set(), slackIdByName: new Map([["Андріан", "U1"]]), log: {},
    });
    expect(plan[0].published).toBe(false);
  });
  it("dry-run names the date and says nothing is sent", () => {
    const plan = buildNotifyPlan({
      days: [day()], verdictByDate: new Map([["2026-06-19", "ACCEPTED"]]),
      publishedDates: new Set(["2026-06-19"]), slackIdByName: new Map([["Андріан", "U1"], ["Тарас", null]]), log: {},
    });
    const out = formatNotifyDryRun(plan, "field-qa");
    expect(out).toContain("2026-06-19");
    expect(out).toContain("DRY RUN");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/fieldBonusReport.test.ts`
Expected: FAIL — `notify`/`buildNotifyPlan`/`formatNotifyDryRun` missing.

- [ ] **Step 3: Extend `scripts/fieldBonusReport.ts`**

Add imports at the top:

```ts
import type { DayBonus } from "../lib/fieldBonus";
import { dayPersonBonuses, type PersonAmount } from "../lib/bonusNotify";
import { isThreadNotified, isDmSent, type NotifiedLog } from "../lib/bonusNotified";
import type { VerdictStatus } from "../lib/fieldDayVerdict";
```

Extend `BonusArgs` and `parseArgs` — change the interface to add `notify: boolean; channel?: string`, initialise `notify: false` in `parseArgs`, and add two branches:

```ts
    else if (a === "--notify") args.notify = true;
    else if (a === "--channel") args.channel = argv[++i];
```

Append the plan + dry-run:

```ts
export interface NotifyTarget { name: string; amount: PersonAmount; slackId: string | null }

export interface NotifyPlanItem {
  date: string;
  earned: boolean;
  reason: string;
  people: PersonAmount[];
  threadPending: boolean;
  pendingDms: NotifyTarget[];
  unmatched: string[];
  published: boolean;
}

/**
 * Which settled days still need a thread post and/or DMs. A day is in the plan
 * iff its verdict has settled (≠ PENDING). Earned = the bonus DayBonus is
 * counted. PENDING days and fully-notified days are dropped.
 */
export function buildNotifyPlan(input: {
  days: DayBonus[];
  verdictByDate: Map<string, VerdictStatus>;
  publishedDates: Set<string>;
  slackIdByName: Map<string, string | null>;
  log: NotifiedLog;
}): NotifyPlanItem[] {
  const { days, verdictByDate, publishedDates, slackIdByName, log } = input;
  const plan: NotifyPlanItem[] = [];
  for (const day of days) {
    const status = verdictByDate.get(day.date);
    if (!status || status === "PENDING") continue; // only settled days, rolling
    const people = dayPersonBonuses(day);
    const earned = people.length > 0;
    const threadPending = !isThreadNotified(log, day.date);

    const pendingDms: NotifyTarget[] = [];
    const unmatched: string[] = [];
    if (earned) {
      for (const amount of people) {
        const slackId = slackIdByName.get(amount.name) ?? null;
        if (slackId === null) { unmatched.push(amount.name); continue; }
        if (isDmSent(log, day.date, slackId)) continue;
        pendingDms.push({ name: amount.name, amount, slackId });
      }
    }
    if (!threadPending && pendingDms.length === 0 && unmatched.length === 0) continue;
    plan.push({ date: day.date, earned, reason: day.reason, people, threadPending, pendingDms, unmatched, published: publishedDates.has(day.date) });
  }
  return plan;
}

export function formatNotifyDryRun(plan: NotifyPlanItem[], channel?: string): string {
  const threads = plan.filter((p) => p.threadPending).length;
  const dms = plan.reduce((n, p) => n + p.pendingDms.length, 0);
  const target = channel ? `#${channel}` : "(no channel — pass --channel <name>)";
  const lines = [`DRY RUN — would post ${threads} thread message(s) + ${dms} DM(s) to ${target}`, ""];
  for (const item of plan) {
    const head = item.earned ? `${item.people.reduce((s, p) => s + p.total, 0)} грн` : `no bonus (${item.reason})`;
    lines.push(`${item.date} — ${head}${item.published ? "" : "  [NOT PUBLISHED — thread skipped]"}`);
    for (const t of item.pendingDms) lines.push(`    DM → ${t.name} (${t.slackId}): ${t.amount.total} грн`);
    for (const n of item.unmatched) lines.push(`    ⚠ no Slack id for ${n} — DM skipped, add to SLACK_ID_OVERRIDES`);
  }
  lines.push("", "No messages were sent. Re-run with `--notify --publish --channel <name>` to send for real.");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/fieldBonusReport.test.ts`
Expected: PASS (existing tests + 7 new). (The existing `parseArgs` test must still pass — adding `notify: false` to the returned object is additive; if that test uses `toEqual` on the whole object, update it to include `notify: false`.)

- [ ] **Step 5: Commit**

```bash
git add scripts/fieldBonusReport.ts scripts/fieldBonusReport.test.ts
git commit -m "feat(bonus): notify plan + --notify/--channel flags (settled-day, idempotent)"
```

---

### Task 6: Wire the notifier into `scripts/field-bonus.ts` + docs

**Files:**
- Modify: `scripts/field-bonus.ts`
- Modify: `.claude/skills/field-bonus/SKILL.md` (document `--notify`)
- Modify: `CLAUDE.md` (extend the `field-bonus` command line)

**Interfaces:**
- Consumes: everything above + `readReportJson`/`periodKey` (`lib/reports`), `readPublished` (`lib/published`), `readNotified`/`writeNotified`/`recordThread`/`recordDm` (`lib/bonusNotified`), `listUsers`/`openDm`/`postMessage` (`lib/slack`), `matchSlackId` (`lib/fieldSlackIds`), `TRACKED_CHANNELS` (`lib/slackChannels`), `formatThreadBreakdown`/`formatDm`/`formatNoBonusNote` (`lib/bonusNotify`), `buildNotifyPlan`/`formatNotifyDryRun` (`scripts/fieldBonusReport`).
- Produces: `npm run field-bonus -- --notify [...]`.

No unit test (thin orchestration); verified by the dry-run below.

- [ ] **Step 1: Add the notify branch to `scripts/field-bonus.ts`**

After the existing `report = await computeBonusReport(...)` line and before the format/print block, insert:

```ts
  if (args.notify) {
    const { readReportJson, periodKey } = await import("../lib/reports");
    const { readPublished } = await import("../lib/published");
    const { readNotified, writeNotified, recordThread, recordDm } = await import("../lib/bonusNotified");
    const { listUsers, openDm, postMessage } = await import("../lib/slack");
    const { matchSlackId } = await import("../lib/fieldSlackIds");
    const { TRACKED_CHANNELS } = await import("../lib/slackChannels");
    const { formatThreadBreakdown, formatDm, formatNoBonusNote } = await import("../lib/bonusNotify");
    const { buildNotifyPlan, formatNotifyDryRun } = await import("./fieldBonusReport");

    const key = periodKey(period);
    const verdict = await readReportJson<{ days: { date: string; status: string }[] }>("field-verdict", key);
    if (!verdict) { process.stderr.write(`field-bonus: no field-verdict report for ${key} — run field-verdict --write first.\n`); process.exit(1); }
    const verdictByDate = new Map(verdict.days.map((d) => [d.date, d.status as import("../lib/fieldDayVerdict").VerdictStatus]));

    const published = await readPublished(period);
    const publishedDates = new Set(Object.keys(published));

    // Resolve each roster name once against the live directory.
    const users = await listUsers();
    const names = [...new Set(report.days.flatMap((d) => d.roster))];
    const slackIdByName = new Map(names.map((n) => [n, matchSlackId(n, users)] as const));

    let log = await readNotified(period);
    const plan = buildNotifyPlan({ days: report.days, verdictByDate, publishedDates, slackIdByName, log });

    if (!args.publish) { console.log(formatNotifyDryRun(plan, args.channel)); return; }

    if (!args.channel) { process.stderr.write("field-bonus: --notify --publish requires --channel <name>.\n"); process.exit(1); }
    const channel = TRACKED_CHANNELS.find((c) => c.name === args.channel);
    if (!channel) { process.stderr.write(`field-bonus: unknown channel "${args.channel}".\n`); process.exit(1); }

    for (const item of plan) {
      if (!item.published) { process.stderr.write(`field-bonus: ${item.date} not published yet — skipping thread+DMs.\n`); continue; }
      const rootTs = published[item.date].ts;
      if (item.threadPending) {
        const text = item.earned ? formatThreadBreakdown(item.date, item.people) : formatNoBonusNote(item.date, item.reason);
        const ts = await postMessage(channel.id, text, rootTs);
        log = recordThread(log, item.date, ts);
        await writeNotified(period, log);
        process.stderr.write(`field-bonus: posted ${item.earned ? "breakdown" : "no-bonus note"} for ${item.date}\n`);
      }
      for (const t of item.pendingDms) {
        if (t.slackId === null) continue;
        const dm = await openDm(t.slackId);
        const ts = await postMessage(dm, formatDm(item.date, t.amount));
        log = recordDm(log, item.date, t.slackId, ts, t.amount.total);
        await writeNotified(period, log);
        process.stderr.write(`field-bonus: DMed ${t.name} for ${item.date} (${t.amount.total} грн)\n`);
      }
      for (const n of item.unmatched) process.stderr.write(`field-bonus: no Slack id for ${n} on ${item.date} — DM skipped.\n`);
    }
    process.stderr.write("field-bonus: notify done.\n");
    return;
  }
```

(The existing `--sheet`/`--format` printing stays as the non-notify path. Confirm `report.days` is the `DayBonus[]` on `BonusReport` — it is. `computeBonusReport` already runs even in notify mode, giving fresh amounts; pass `--write` too if you also want the artifact refreshed.)

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Dry-run against a committed period**

Run:
```bash
npm run field-bonus -- --start 2026-06-01 --end 2026-06-18 --notify
```
Expected: a `DRY RUN — would post N thread message(s) + M DM(s)` block listing settled days, per-person DM lines, and `⚠ no Slack id for …` for unmatched names. (Requires a committed `field-verdict` report + a `published` log for the period; needs `VIMEO_TOKEN`/`ANTHROPIC_API_KEY`/`POSTGRES_URL` for `computeBonusReport`, same as the existing CLI.)

- [ ] **Step 4: Update the skill**

In `.claude/skills/field-bonus/SKILL.md`, replace the "in-thread unknown-initial flow … planned but not yet implemented" note (or add under "How to use") a `--notify` section:

```markdown
## Rolling notification (`--notify`)

As each flight day's acceptance settles (verdict ≠ PENDING), post that day's
per-person breakdown in the day's verdict thread and DM each participant their
**provisional** share (the monthly drone-loss multiplier settles separately).

- Dry-run: `npm run field-bonus -- --start … --end … --notify` (prints, sends nothing).
- Send: add `--publish --channel <name>` (needs `chat:write`, `im:write`; use a private test channel first).
- Idempotent via the `bonus_notified` table; only settled, already-`field-publish`ed days are notified; names without a Slack id are skipped and flagged (add them to `SLACK_ID_OVERRIDES` in `lib/fieldSlackIds.ts`).
- Prereqs: run `npm run field-verdict -- --write` and `npm run field-publish -- … --publish` first.
```

- [ ] **Step 5: Update `CLAUDE.md`**

Extend the existing `npm run field-bonus` bullet with a sentence:

```markdown
  Add `--notify` to post each **settled** day's per-person breakdown in its `field-publish` verdict thread and DM each participant their **provisional** share (excludes the monthly drone-loss multiplier); **DRY-RUN by default**, `--publish --channel <name>` sends, idempotent via `bonus_notified`. (See `.claude/skills/field-bonus/`.)
```

- [ ] **Step 6: Commit**

```bash
git add scripts/field-bonus.ts .claude/skills/field-bonus/SKILL.md CLAUDE.md
git commit -m "feat(bonus): rolling --notify (thread breakdown + per-person DMs), dry-run default"
```

---

## Final verification

- [ ] `npm test` → all green (new + existing).
- [ ] `npx tsc --noEmit -p tsconfig.json` → clean.
- [ ] `npm run lint` → clean.
- [ ] `npm run field-bonus -- --start <committed-period> --notify` → dry-run prints amounts, DM targets, and unmatched-name flags; sends nothing.
- [ ] Spec scope still holds: notifier only; reuse the shipped calculator/roster/losses; provisional wording; dry-run default; idempotent.

## Spec coverage map

- Per-day per-person amount from the existing calculator → Task 1.
- Ukrainian thread breakdown + per-person DM + no-bonus note, provisional → Task 1.
- Name → Slack id (no guessing) → Task 2.
- Slack DM capability → Task 3.
- Idempotency (`bonus_notified`) → Task 4.
- Settled-day trigger (≠ PENDING), already-published gate, dry-run plan → Task 5.
- CLI wiring `--notify`/`--channel`/`--publish` + docs → Task 6.
- Manual-first rollout / cron deferred → spec "Rollout" (no task).
