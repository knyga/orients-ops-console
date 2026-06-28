# Field Bonus Recomputation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recompute per-person monthly field bonuses (700/200/300 + drone-loss multiplier) from the `#field-qa` Звіт reports and live Vimeo, exposed as a CLI + web tab with a committed artifact.

**Architecture:** Pure `lib/` units (roster map → Звіт parser → bonus calculator) feed a server-only orchestrator that pulls the Slack mirror + live Vimeo + Claude-classified losses. A CLI (`npm run field-bonus`) prints/persists the report; an API route + dashboard tab render the committed artifact via the shared `usePeriodReport` hybrid. Mirrors the existing `field-verdict` feature's shape.

**Tech Stack:** TypeScript (strict), Next.js 16 App Router, React 19, Drizzle/Postgres, Vitest, `@anthropic-ai/sdk`, `tsx` CLIs run with `node --conditions=react-server`.

## Global Constraints

- Pure `lib/` modules (`fieldRoster`, `fieldReports`, `fieldBonus`, `lossExtractPrompt`) have **no** React/Next/`server-only`/`node:fs` imports and are unit-tested. Token/DB/network code lives in server-only modules or at the CLI/route edge.
- Server-only modules (live Vimeo, Claude, DB reads) `import "server-only"`; CLIs run via `node --conditions=react-server --import tsx`.
- Import alias `@/*` → repo root; tests live beside source as `*.test.ts`.
- Period key is canonical (`lib/period.ts`): `YYYY-MM` or `YYYY-MM-DD_YYYY-MM-DD`. Day boundaries use `Europe/Kyiv`.
- Bonus policy (verbatim): `gross = 700×trips + 200×early + 300×weekend`; trip counts iff `deployMin ≥ 180` AND `videoMin ≥ 2`; early iff field arrival `≤ 12:30`; weekend iff Sat/Sun. Loss multiplier per flight group over 12 consecutive trips: 2 losses → −50%, 3 → −100%; team-wide `>3` losses → all nets 0. A found drone is not a loss.
- The web never writes `reports/`; only the CLI `--write` persists (DB-backed report store + flat CSV).
- Commit message footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Roster initial→name map

**Files:**
- Create: `lib/fieldRoster.ts`
- Test: `lib/fieldRoster.test.ts`

**Interfaces:**
- Produces: `type RosterResolution = { name: string } | { unknown: string }`; `resolveInitial(token: string, aliases?: Record<string, string>): RosterResolution`; `SEED_ALIASES: Record<string, string>`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/fieldRoster.test.ts
import { describe, it, expect } from "vitest";
import { resolveInitial } from "./fieldRoster";

describe("resolveInitial", () => {
  it("maps seed initials to full names", () => {
    expect(resolveInitial("А")).toEqual({ name: "Андріан" });
    expect(resolveInitial("Л")).toEqual({ name: "Любомир" });
    expect(resolveInitial("Серж")).toEqual({ name: "Сергій" });
    expect(resolveInitial("сер")).toEqual({ name: "Сергій" }); // case-insensitive prefix
  });
  it("trims surrounding whitespace", () => {
    expect(resolveInitial("  Д ")).toEqual({ name: "Данило" });
  });
  it("flags an unmapped initial", () => {
    expect(resolveInitial("М")).toEqual({ unknown: "М" });
  });
  it("lets a caller alias override an unknown", () => {
    expect(resolveInitial("М", { М: "Максим" })).toEqual({ name: "Максим" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/fieldRoster.test.ts`
Expected: FAIL — `Cannot find module './fieldRoster'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/fieldRoster.ts
/**
 * Pure roster initial→name resolution for the #field-qa "Звіт" reports.
 * Seed map plus caller-supplied alias overrides (durable aliases live in the DB,
 * passed in by the orchestrator). No DB/Next imports — unit-tested in isolation.
 */
export type RosterResolution = { name: string } | { unknown: string };

/** Initials seen in real reports. "Серж"/"Сер…" is a name fragment, not a letter. */
export const SEED_ALIASES: Record<string, string> = {
  А: "Андріан",
  Л: "Любомир",
  Д: "Данило",
  Т: "Тарас",
  В: "Влад",
  Н: "Надія",
  К: "Констянтин",
  О: "Олександр",
};

export function resolveInitial(token: string, aliases: Record<string, string> = {}): RosterResolution {
  const t = token.trim();
  if (!t) return { unknown: token };
  if (t.toLowerCase().startsWith("сер")) return { name: "Сергій" };
  const map = { ...SEED_ALIASES, ...aliases };
  // Exact token first (multi-letter aliases), then first-letter fallback.
  const hit = map[t] ?? map[t[0].toUpperCase()];
  return hit ? { name: hit } : { unknown: t };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/fieldRoster.test.ts`
Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/fieldRoster.ts lib/fieldRoster.test.ts
git commit -m "feat(field-bonus): roster initial→name resolution

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Звіт report parser

**Files:**
- Create: `lib/fieldReports.ts`
- Test: `lib/fieldReports.test.ts`

**Interfaces:**
- Consumes: `resolveInitial`, `RosterResolution` from `lib/fieldRoster` (Task 1).
- Produces:
  ```ts
  interface FieldReport {
    flightDate: string;        // YYYY-MM-DD from the date in the text
    roster: string[];          // resolved names (unknowns excluded here)
    unknownInitials: string[]; // tokens that did not resolve
    start: string | null;      // "HH:MM"
    end: string | null;
    deployMin: number | null;  // end − start (minutes), null if no window
    crashText: string | null;  // free-text body after the header lines
    permalink: string;
    threadTs: string;
  }
  ```
  `parseZvit(text: string, meta: { permalink: string; threadTs: string }, aliases?: Record<string, string>): FieldReport | null` and `parseMonth(messages: { text: string; permalink: string; thread_ts?: string; ts: string; edited?: unknown }[], aliases?: Record<string, string>): FieldReport[]`.

- [ ] **Step 1: Write the failing test** (covers every variance found in the real mirror)

```ts
// lib/fieldReports.test.ts
import { describe, it, expect } from "vitest";
import { parseZvit, parseMonth } from "./fieldReports";

const meta = { permalink: "http://x", threadTs: "1.1" };

describe("parseZvit", () => {
  it("parses the canonical shape", () => {
    const r = parseZvit("Звіт 27.06.2026\nА+Серж 14:40-17:40\nЗнімали датасети", meta);
    expect(r).toMatchObject({ flightDate: "2026-06-27", roster: ["Андріан", "Сергій"], start: "14:40", end: "17:40", deployMin: 180 });
    expect(r?.crashText).toContain("датасети");
  });
  it("accepts a bare date with no 'Звіт' keyword", () => {
    expect(parseZvit("31.05.2026\nА+Д 9:00-12:00", meta)?.flightDate).toBe("2026-05-31");
  });
  it("accepts reversed time-then-roster order", () => {
    const r = parseZvit("30.05.2026\n15:00-20:00 А+Д", meta);
    expect(r).toMatchObject({ roster: ["Андріан", "Данило"], start: "15:00", end: "20:00", deployMin: 300 });
  });
  it("accepts dot time separators and en-dash", () => {
    const r = parseZvit("Звіт 09.06.2026\nЛ+Н 14.00 – 18.45", meta);
    expect(r).toMatchObject({ start: "14:00", end: "18:45", deployMin: 285 });
  });
  it("collects unknown initials without dropping the report", () => {
    const r = parseZvit("27.05.2026\nА+М 12:00-16:20", meta);
    expect(r?.roster).toEqual(["Андріан"]);
    expect(r?.unknownInitials).toEqual(["М"]);
  });
  it("returns null when no date header is present", () => {
    expect(parseZvit("just a chat message", meta)).toBeNull();
  });
  it("returns a report with null window when no time range is found", () => {
    const r = parseZvit("Звіт 01.06.2026\nбез часу", meta);
    expect(r).toMatchObject({ flightDate: "2026-06-01", start: null, deployMin: null });
  });
});

describe("parseMonth", () => {
  it("dedupes by flightDate keeping the later edit (by ts)", () => {
    const msgs = [
      { text: "Звіт 01.06.2026\nА+Д 14:00-17:00", permalink: "a", ts: "100" },
      { text: "Звіт 01.06.2026\nА+Д 14:00-18:00", permalink: "b", ts: "200" },
    ];
    const out = parseMonth(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].deployMin).toBe(240); // the ts=200 edit wins
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/fieldReports.test.ts`
Expected: FAIL — `Cannot find module './fieldReports'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/fieldReports.ts
/**
 * Parse #field-qa "Звіт" reports into structured roster + deployment windows.
 * Pure (no DB/Next). Hardened for the real variances in the mirror: optional
 * "Звіт" keyword, reversed roster/time order, dot-or-colon separators, threads,
 * and a report date in the text that lags the post time.
 */
import { resolveInitial } from "./fieldRoster";

export interface FieldReport {
  flightDate: string;
  roster: string[];
  unknownInitials: string[];
  start: string | null;
  end: string | null;
  deployMin: number | null;
  crashText: string | null;
  permalink: string;
  threadTs: string;
}

const DATE_RE = /(\d{2})\.(\d{2})\.(\d{4})/;
const WINDOW_RE = /(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/;

const pad = (n: number | string) => String(n).padStart(2, "0");
const toMin = (h: string, m: string) => Number(h) * 60 + Number(m);

export function parseZvit(
  text: string,
  meta: { permalink: string; threadTs: string },
  aliases: Record<string, string> = {},
): FieldReport | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const dm = DATE_RE.exec(lines[0]);
  if (!dm) return null;
  const flightDate = `${dm[3]}-${dm[2]}-${dm[1]}`;

  const rosterLine = lines[1] ?? "";
  const wm = WINDOW_RE.exec(rosterLine);
  let start: string | null = null;
  let end: string | null = null;
  let deployMin: number | null = null;
  const roster: string[] = [];
  const unknownInitials: string[] = [];
  if (wm) {
    start = `${pad(wm[1])}:${wm[2]}`;
    end = `${pad(wm[3])}:${wm[4]}`;
    deployMin = toMin(wm[3], wm[4]) - toMin(wm[1], wm[2]);
    // Roster tokens are everything on the line that is not the time window.
    const names = rosterLine.replace(WINDOW_RE, " ");
    for (const tok of names.split(/[+/,&]/).map((s) => s.trim()).filter((s) => s && !/^\d+$/.test(s))) {
      const r = resolveInitial(tok, aliases);
      if ("name" in r) roster.push(r.name);
      else unknownInitials.push(r.unknown);
    }
  }
  const crashText = lines.slice(2).join("\n") || null;
  return { flightDate, roster, unknownInitials, start, end, deployMin, crashText, permalink: meta.permalink, threadTs: meta.threadTs };
}

export function parseMonth(
  messages: { text: string; permalink: string; thread_ts?: string; ts: string }[],
  aliases: Record<string, string> = {},
): FieldReport[] {
  const byDate = new Map<string, { ts: string; report: FieldReport }>();
  for (const m of messages) {
    const r = parseZvit(m.text ?? "", { permalink: m.permalink, threadTs: m.thread_ts ?? m.ts }, aliases);
    if (!r) continue;
    const prev = byDate.get(r.flightDate);
    if (!prev || m.ts.localeCompare(prev.ts) > 0) byDate.set(r.flightDate, { ts: m.ts, report: r });
  }
  return [...byDate.values()].map((v) => v.report).sort((a, b) => a.flightDate.localeCompare(b.flightDate));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/fieldReports.test.ts`
Expected: PASS (8 assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/fieldReports.ts lib/fieldReports.test.ts
git commit -m "feat(field-bonus): parse #field-qa Звіт reports (roster + window)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Bonus calculator

**Files:**
- Create: `lib/fieldBonus.ts`
- Test: `lib/fieldBonus.test.ts`

**Interfaces:**
- Consumes: `FieldReport` from `lib/fieldReports` (Task 2); `Period` from `lib/period`.
- Produces:
  ```ts
  interface LossRecord { date: string; found: boolean; note: string }
  interface DayBonus { date: string; roster: string[]; deployMin: number | null; videoMin: number; counted: boolean; early: boolean; weekend: boolean; reason: string }
  interface PersonBonus { name: string; trips: number; early: number; weekend: number; gross: number; penaltyPct: number; net: number }
  interface Penalty { group: string[]; lossesInWindow: number; pct: number; reason: string }
  interface Flag { kind: "unknown_initial" | "qualifying_unrecorded" | "counted_no_video"; date: string; detail: string }
  interface BonusReport { period: Period; days: DayBonus[]; people: PersonBonus[]; penalties: Penalty[]; teamZeroed: boolean; flags: Flag[]; total: number }
  ```
  `computeBonuses(input: { period: Period; reports: FieldReport[]; videoMinutesByDate: Record<string, number>; losses: LossRecord[] }): BonusReport` and exported constants `TRIP, EARLY, WEEKEND, MIN_DEPLOY_MIN, MIN_VIDEO_MIN, EARLY_CUTOFF_MIN, LOSS_WINDOW, TEAM_LOSS_CUTOFF`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/fieldBonus.test.ts
import { describe, it, expect } from "vitest";
import { computeBonuses } from "./fieldBonus";
import type { FieldReport } from "./fieldReports";

const rep = (o: Partial<FieldReport> & { flightDate: string }): FieldReport => ({
  roster: ["Андріан"], unknownInitials: [], start: "14:00", end: "17:00", deployMin: 180,
  crashText: null, permalink: "p", threadTs: "t", ...o,
});
const period = { start: "2026-05-01", end: "2026-05-31" };

describe("computeBonuses", () => {
  it("pays 700 for a qualifying weekday trip with >=2min video", () => {
    const r = computeBonuses({ period, reports: [rep({ flightDate: "2026-05-01" })], videoMinutesByDate: { "2026-05-01": 5 }, losses: [] });
    expect(r.people).toEqual([{ name: "Андріан", trips: 1, early: 0, weekend: 0, gross: 700, penaltyPct: 0, net: 700 }]);
    expect(r.total).toBe(700);
  });
  it("rejects a trip with <2min video and flags it (the 05-11 anomaly)", () => {
    const r = computeBonuses({ period, reports: [rep({ flightDate: "2026-05-11" })], videoMinutesByDate: {}, losses: [] });
    expect(r.people).toEqual([]);
    expect(r.flags).toContainEqual({ kind: "counted_no_video", date: "2026-05-11", detail: expect.any(String) });
  });
  it("rejects a sub-3h deployment", () => {
    const r = computeBonuses({ period, reports: [rep({ flightDate: "2026-05-02", start: "14:00", end: "16:30", deployMin: 150 })], videoMinutesByDate: { "2026-05-02": 9 }, losses: [] });
    expect(r.total).toBe(0);
  });
  it("adds 200 early at exactly 12:30 and 300 on a weekend", () => {
    // 2026-05-10 is a Sunday; arrival exactly 12:30.
    const r = computeBonuses({ period, reports: [rep({ flightDate: "2026-05-10", start: "12:30", end: "16:00", deployMin: 210 })], videoMinutesByDate: { "2026-05-10": 9 }, losses: [] });
    expect(r.people[0]).toMatchObject({ trips: 1, early: 1, weekend: 1, gross: 1200, net: 1200 });
  });
  it("applies −50% to a flight group with 2 losses in 12 trips", () => {
    const reports = Array.from({ length: 4 }, (_, i) => rep({ flightDate: `2026-05-0${i + 1}`, roster: ["Андріан", "Данило"] }));
    const video = Object.fromEntries(reports.map((r) => [r.flightDate, 9]));
    const r = computeBonuses({ period, reports, videoMinutesByDate: video, losses: [{ date: "2026-05-01", found: false, note: "x" }, { date: "2026-05-02", found: false, note: "y" }] });
    expect(r.people.find((p) => p.name === "Андріан")?.penaltyPct).toBe(0.5);
    expect(r.people.find((p) => p.name === "Андріан")?.net).toBe(700 * 4 * 0.5);
  });
  it("a found drone is not a loss", () => {
    const reports = [rep({ flightDate: "2026-05-01" }), rep({ flightDate: "2026-05-02" })];
    const r = computeBonuses({ period, reports, videoMinutesByDate: { "2026-05-01": 9, "2026-05-02": 9 }, losses: [{ date: "2026-05-01", found: true, note: "found" }] });
    expect(r.people[0].penaltyPct).toBe(0);
  });
  it("zeroes everyone when the team loses >3 drones", () => {
    const reports = [rep({ flightDate: "2026-05-01" })];
    const losses = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04"].map((d) => ({ date: d, found: false, note: "" }));
    const r = computeBonuses({ period, reports, videoMinutesByDate: { "2026-05-01": 9 }, losses });
    expect(r.teamZeroed).toBe(true);
    expect(r.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/fieldBonus.test.ts`
Expected: FAIL — `Cannot find module './fieldBonus'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/fieldBonus.ts
/**
 * Pure field-bonus calculator. Trip counts iff deployMin >= 180 AND video >= 2min
 * (the real policy gate — NOT the 50%-of-airborne reconcile gate). Adds early
 * (arrival <= 12:30) and weekend (Sat/Sun) bonuses, then the drone-loss
 * multiplier per flight group over 12 consecutive trips, and the team-wide
 * >3-loss cutoff. No DB/Next imports — unit-tested in isolation.
 */
import type { FieldReport } from "./fieldReports";
import type { Period } from "./period";

export const TRIP = 700;
export const EARLY = 200;
export const WEEKEND = 300;
export const MIN_DEPLOY_MIN = 180;
export const MIN_VIDEO_MIN = 2;
export const EARLY_CUTOFF_MIN = 12 * 60 + 30; // 12:30
export const LOSS_WINDOW = 12;
export const TEAM_LOSS_CUTOFF = 3;

export interface LossRecord { date: string; found: boolean; note: string }
export interface DayBonus { date: string; roster: string[]; deployMin: number | null; videoMin: number; counted: boolean; early: boolean; weekend: boolean; reason: string }
export interface PersonBonus { name: string; trips: number; early: number; weekend: number; gross: number; penaltyPct: number; net: number }
export interface Penalty { group: string[]; lossesInWindow: number; pct: number; reason: string }
export interface Flag { kind: "unknown_initial" | "qualifying_unrecorded" | "counted_no_video"; date: string; detail: string }
export interface BonusReport { period: Period; days: DayBonus[]; people: PersonBonus[]; penalties: Penalty[]; teamZeroed: boolean; flags: Flag[]; total: number }

const TZ = "Europe/Kyiv";
function isWeekend(date: string): boolean {
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ }).format(new Date(`${date}T12:00:00Z`));
  return wd === "Sat" || wd === "Sun";
}
function startMin(start: string | null): number | null {
  if (!start) return null;
  const [h, m] = start.split(":").map(Number);
  return h * 60 + m;
}

export function computeBonuses(input: {
  period: Period;
  reports: FieldReport[];
  videoMinutesByDate: Record<string, number>;
  losses: LossRecord[];
}): BonusReport {
  const { period, reports, videoMinutesByDate, losses } = input;
  const flags: Flag[] = [];
  const days: DayBonus[] = [];

  for (const r of reports) {
    for (const u of r.unknownInitials) flags.push({ kind: "unknown_initial", date: r.flightDate, detail: u });
    const videoMin = Math.round((videoMinutesByDate[r.flightDate] ?? 0) * 10) / 10;
    const hoursOk = r.deployMin != null && r.deployMin >= MIN_DEPLOY_MIN;
    const videoOk = videoMin >= MIN_VIDEO_MIN;
    const counted = hoursOk && videoOk;
    if (hoursOk && !videoOk) flags.push({ kind: "counted_no_video", date: r.flightDate, detail: `deploy ${r.deployMin}min but video ${videoMin}min < ${MIN_VIDEO_MIN}` });
    const sm = startMin(r.start);
    const early = counted && sm != null && sm <= EARLY_CUTOFF_MIN;
    const weekend = counted && isWeekend(r.flightDate);
    const reason = counted ? "counted" : !hoursOk ? "deploy<3h" : "video<2min";
    days.push({ date: r.flightDate, roster: r.roster, deployMin: r.deployMin, videoMin, counted, early, weekend, reason });
  }

  // Per-person tallies from counted days.
  const tally = new Map<string, { trips: number; early: number; weekend: number; dates: string[] }>();
  for (const d of days) {
    if (!d.counted) continue;
    for (const name of d.roster) {
      const t = tally.get(name) ?? { trips: 0, early: 0, weekend: 0, dates: [] };
      t.trips += 1; if (d.early) t.early += 1; if (d.weekend) t.weekend += 1; t.dates.push(d.date);
      tally.set(name, t);
    }
  }

  // Flight groups = sets of people who fly together on a counted day.
  const groupKeyByDate = new Map<string, string>();
  for (const d of days) if (d.counted) groupKeyByDate.set(d.date, [...d.roster].sort().join("+"));
  const tripsByGroup = new Map<string, string[]>();
  for (const [date, key] of [...groupKeyByDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const arr = tripsByGroup.get(key) ?? []; arr.push(date); tripsByGroup.set(key, arr);
  }
  const lostDates = new Set(losses.filter((l) => !l.found).map((l) => l.date));
  const teamLosses = lostDates.size;
  const teamZeroed = teamLosses > TEAM_LOSS_CUTOFF;

  // Worst penalty per group: max losses inside any window of 12 consecutive trips.
  const penalties: Penalty[] = [];
  const pctByGroup = new Map<string, number>();
  for (const [key, dates] of tripsByGroup.entries()) {
    let worst = 0;
    for (let i = 0; i < dates.length; i++) {
      const window = dates.slice(i, i + LOSS_WINDOW);
      const inWindow = window.filter((d) => lostDates.has(d)).length;
      worst = Math.max(worst, inWindow);
    }
    const pct = worst >= 3 ? 1 : worst >= 2 ? 0.5 : 0;
    if (pct > 0) { pctByGroup.set(key, pct); penalties.push({ group: key.split("+"), lossesInWindow: worst, pct, reason: `${worst} losses within ${LOSS_WINDOW} consecutive trips` }); }
  }

  const people: PersonBonus[] = [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, t]) => {
    const gross = TRIP * t.trips + EARLY * t.early + WEEKEND * t.weekend;
    // A person's penalty = worst penalty among the groups they flew with.
    let penaltyPct = 0;
    for (const [key, pct] of pctByGroup.entries()) if (key.split("+").includes(name)) penaltyPct = Math.max(penaltyPct, pct);
    const net = teamZeroed ? 0 : Math.round(gross * (1 - penaltyPct));
    return { name, trips: t.trips, early: t.early, weekend: t.weekend, gross, penaltyPct, net };
  });

  const total = people.reduce((s, p) => s + p.net, 0);
  return { period, days, people, penalties, teamZeroed, flags, total };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/fieldBonus.test.ts`
Expected: PASS (7 assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/fieldBonus.ts lib/fieldBonus.test.ts
git commit -m "feat(field-bonus): pure 700/200/300 calculator + loss multiplier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Drone-loss extraction (Claude)

**Files:**
- Create: `lib/lossExtractPrompt.ts` (pure), `lib/lossExtract.ts` (server-only)
- Test: `lib/lossExtractPrompt.test.ts`

**Interfaces:**
- Produces: `interface LossExtract { lost: boolean; found: boolean; note: string }`; `LOSS_TOOL: Anthropic.Tool`; `buildLossPrompt(crashText: string): string`; `extractLoss(crashText: string): Promise<LossExtract>`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/lossExtractPrompt.test.ts
import { describe, it, expect } from "vitest";
import { LOSS_TOOL, buildLossPrompt } from "./lossExtractPrompt";

describe("loss extract prompt", () => {
  it("requires lost + found booleans", () => {
    expect(LOSS_TOOL.name).toBe("report_loss");
    expect(LOSS_TOOL.input_schema.required).toEqual(expect.arrayContaining(["lost", "found"]));
  });
  it("embeds the report text and asks about found-vs-lost", () => {
    const p = buildLossPrompt("дрон влетів у паркан, знайшли");
    expect(p).toContain("дрон влетів");
    expect(p.toLowerCase()).toContain("found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/lossExtractPrompt.test.ts`
Expected: FAIL — `Cannot find module './lossExtractPrompt'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/lossExtractPrompt.ts
/** Pure prompt + tool schema for classifying a Звіт's free text for drone loss. */
import type Anthropic from "@anthropic-ai/sdk";

export interface LossExtract { lost: boolean; found: boolean; note: string }

export const LOSS_TOOL: Anthropic.Tool = {
  name: "report_loss",
  description: "Classify whether a field report describes a lost/destroyed drone, and whether it was recovered.",
  input_schema: {
    type: "object",
    properties: {
      lost: { type: "boolean", description: "true if a drone was lost, crashed, or destroyed during this flight day" },
      found: { type: "boolean", description: "true if a lost drone was recovered/found (per the rules, then it is NOT a loss)" },
      note: { type: "string", description: "short quote or paraphrase of the relevant sentence" },
    },
    required: ["lost", "found", "note"],
  },
};

export function buildLossPrompt(crashText: string): string {
  return [
    `This is the free-text body of a Ukrainian field-flight report.`,
    `Decide whether a drone was lost/crashed/destroyed, and whether it was later found.`,
    `A drone reported lost but recovered ("знайшли", "found") counts as found=true.`,
    `Report text:`,
    `"""${crashText}"""`,
    `Call report_loss with lost, found, note.`,
  ].join("\n");
}
```

```ts
// lib/lossExtract.ts
/** Classify a Звіт report's free text for drone loss via Claude. SERVER-ONLY. */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { LOSS_TOOL, buildLossPrompt, type LossExtract } from "./lossExtractPrompt";

const MODEL = "claude-sonnet-4-6";

export async function extractLoss(crashText: string): Promise<LossExtract> {
  if (!crashText.trim()) return { lost: false, found: false, note: "" };
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (needed for field-bonus loss extraction).");
  const client = new Anthropic();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    tools: [LOSS_TOOL],
    tool_choice: { type: "tool", name: LOSS_TOOL.name },
    messages: [{ role: "user", content: [{ type: "text", text: buildLossPrompt(crashText) }] }],
  });
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const input = (block?.input ?? {}) as Partial<LossExtract>;
  return { lost: Boolean(input.lost), found: Boolean(input.found), note: String(input.note ?? "") };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/lossExtractPrompt.test.ts`
Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/lossExtractPrompt.ts lib/lossExtract.ts lib/lossExtractPrompt.test.ts
git commit -m "feat(field-bonus): Claude loss classifier (lost/found)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Roster-alias store (DB)

**Files:**
- Modify: `lib/schema.ts` (add `rosterAliases` table)
- Create: `lib/rosterAliases.ts`
- Test: `lib/rosterAliases.test.ts` (pure merge helper only — DB read/write is exercised via the CLI)
- Run: `npm run db:generate` then `npm run db:migrate`

**Interfaces:**
- Produces: `readAliases(): Promise<Record<string, string>>`; `writeAlias(initial: string, name: string, source: string): Promise<void>`; pure `mergeAliases(seed: Record<string,string>, overrides: Record<string,string>): Record<string,string>`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/rosterAliases.test.ts
import { describe, it, expect } from "vitest";
import { mergeAliases } from "./rosterAliases";

describe("mergeAliases", () => {
  it("overrides win over seed", () => {
    expect(mergeAliases({ А: "Андріан" }, { М: "Максим" })).toEqual({ А: "Андріан", М: "Максим" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/rosterAliases.test.ts`
Expected: FAIL — `Cannot find module './rosterAliases'`.

- [ ] **Step 3: Add the table, then the module**

In `lib/schema.ts`, after the `asks` table, add:

```ts
export const rosterAliases = pgTable("roster_aliases", {
  initial: text("initial").primaryKey(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  recordedAt: text("recorded_at").notNull(),
});
```

Create `lib/rosterAliases.ts`:

```ts
/**
 * Durable roster initial→name aliases (e.g. a resolved "М"→"Максим"), shared by
 * the CLI + web. Backed by the roster_aliases table. mergeAliases is pure.
 */
import { db, schema } from "./db";

export function mergeAliases(seed: Record<string, string>, overrides: Record<string, string>): Record<string, string> {
  return { ...seed, ...overrides };
}

export async function readAliases(): Promise<Record<string, string>> {
  const rows = await db.select().from(schema.rosterAliases);
  return Object.fromEntries(rows.map((r) => [r.initial, r.name]));
}

export async function writeAlias(initial: string, name: string, source: string): Promise<void> {
  const values = { initial, name, source, recordedAt: new Date().toISOString() };
  await db.insert(schema.rosterAliases).values(values).onConflictDoUpdate({ target: schema.rosterAliases.initial, set: values });
}
```

- [ ] **Step 4: Generate + run the migration, then run the test**

Run: `npm run db:generate && npm run db:migrate && npx vitest run lib/rosterAliases.test.ts`
Expected: migration created/applied; test PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/schema.ts lib/rosterAliases.ts lib/rosterAliases.test.ts drizzle/
git commit -m "feat(field-bonus): roster_aliases store

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Report shaping helpers (pure)

**Files:**
- Create: `scripts/fieldBonusReport.ts`
- Test: `scripts/fieldBonusReport.test.ts`

**Interfaces:**
- Consumes: `BonusReport`, `PersonBonus` from `lib/fieldBonus` (Task 3); `Period` from `lib/period`.
- Produces: `parseArgs(argv: string[]): { start?: string; end?: string; format?: string; write: boolean; ask: boolean; publish: boolean; sheet?: string }`; `resolvePeriod(args, today: string): Period`; `toCsv(report: BonusReport): string`; `formatTable(report: BonusReport): string`.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/fieldBonusReport.test.ts
import { describe, it, expect } from "vitest";
import { parseArgs, resolvePeriod, toCsv } from "./fieldBonusReport";
import type { BonusReport } from "../lib/fieldBonus";

const report: BonusReport = {
  period: { start: "2026-05-01", end: "2026-05-31" }, days: [], penalties: [], teamZeroed: false, flags: [], total: 700,
  people: [{ name: "Андріан", trips: 1, early: 0, weekend: 0, gross: 700, penaltyPct: 0, net: 700 }],
};

describe("fieldBonusReport", () => {
  it("parses flags", () => {
    expect(parseArgs(["--start", "2026-05-01", "--end", "2026-05-31", "--write", "--format", "table"]))
      .toMatchObject({ start: "2026-05-01", end: "2026-05-31", write: true, format: "table" });
  });
  it("defaults the period to the current Kyiv month", () => {
    expect(resolvePeriod({ write: false, ask: false, publish: false }, "2026-05-17")).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });
  it("emits a per-person CSV header + rows", () => {
    expect(toCsv(report).split("\n")[0]).toBe("person,trips,early,weekend,gross,penaltyPct,net");
    expect(toCsv(report)).toContain("Андріан,1,0,0,700,0,700");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/fieldBonusReport.test.ts`
Expected: FAIL — `Cannot find module './fieldBonusReport'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/fieldBonusReport.ts
/** Pure CLI helpers for field-bonus: arg parsing, period defaulting, CSV + table. */
import { parsePeriodKey, type Period } from "../lib/period";
import type { BonusReport } from "../lib/fieldBonus";

export interface BonusArgs { start?: string; end?: string; format?: string; write: boolean; ask: boolean; publish: boolean; sheet?: string }

export function parseArgs(argv: string[]): BonusArgs {
  const args: BonusArgs = { write: false, ask: false, publish: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--start") args.start = argv[++i];
    else if (a === "--end") args.end = argv[++i];
    else if (a === "--format") args.format = argv[++i];
    else if (a === "--sheet") args.sheet = argv[++i];
    else if (a === "--write") args.write = true;
    else if (a === "--ask") args.ask = true;
    else if (a === "--publish") args.publish = true;
  }
  return args;
}

export function resolvePeriod(args: BonusArgs, today: string): Period {
  if (args.start && args.end) return { start: args.start, end: args.end };
  const month = today.slice(0, 7);
  return parsePeriodKey(month)!;
}

export function toCsv(report: BonusReport): string {
  const head = "person,trips,early,weekend,gross,penaltyPct,net";
  const rows = report.people.map((p) => [p.name, p.trips, p.early, p.weekend, p.gross, p.penaltyPct, p.net].join(","));
  return [head, ...rows].join("\n");
}

export function formatTable(report: BonusReport): string {
  const lines = [`Field bonuses ${report.period.start}..${report.period.end}${report.teamZeroed ? " — TEAM ZEROED (>3 losses)" : ""}`];
  for (const p of report.people) lines.push(`  ${p.name.padEnd(14)} trips=${p.trips} early=${p.early} wknd=${p.weekend} gross=${p.gross} pen=${p.penaltyPct * 100}% net=${p.net}`);
  lines.push(`  TOTAL net=${report.total}`);
  if (report.flags.length) { lines.push("Flags:"); for (const f of report.flags) lines.push(`  [${f.kind}] ${f.date} ${f.detail}`); }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/fieldBonusReport.test.ts`
Expected: PASS (3 assertions).

- [ ] **Step 5: Commit**

```bash
git add scripts/fieldBonusReport.ts scripts/fieldBonusReport.test.ts
git commit -m "feat(field-bonus): CLI report shaping (args, period, csv, table)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Server-only orchestrator + CLI

**Files:**
- Create: `lib/computeBonuses.ts` (server-only), `scripts/field-bonus.ts`
- Modify: `package.json` (add `field-bonus` script)

**Interfaces:**
- Consumes: `parseMonth` (Task 2), `computeBonuses`/`BonusReport` (Task 3), `extractLoss` (Task 4), `readAliases`/`mergeAliases` (Task 5), `SEED_ALIASES` (Task 1), `parseArgs`/`resolvePeriod`/`toCsv`/`formatTable` (Task 6), plus existing `fetchVideosInPeriod` + `videoFlightDate` + `readChannelMessages` + `writeReport` + `todayInFieldTz`.
- Produces: `computeBonusReport(period: Period, opts: { write?: boolean; onLog?: (m: string) => void }): Promise<BonusReport>`.

- [ ] **Step 1: Write the orchestrator** (no new unit test — it is glue over already-tested pure units and live I/O; verified by the Task 8 reconciliation run)

```ts
// lib/computeBonuses.ts
/**
 * Shared field-bonus computation. SERVER-ONLY (live Vimeo + Claude + DB). Pulls
 * the #field-qa roster reports from the Slack mirror, video minutes from live
 * Vimeo (attributed by name date), and drone losses via Claude, then runs the
 * pure calculator. With write, persists reports/field-bonus/<period>.{json,csv}.
 */
import "server-only";
import { fetchVideosInPeriod } from "./vimeo";
import { videoFlightDate } from "./reconcile";
import { readChannelMessages } from "./slackMirror";
import { writeReport } from "./reports";
import { parseMonth } from "./fieldReports";
import { computeBonuses, type BonusReport, type LossRecord } from "./fieldBonus";
import { extractLoss } from "./lossExtract";
import { readAliases, mergeAliases } from "./rosterAliases";
import { SEED_ALIASES } from "./fieldRoster";
import { todayInFieldTz } from "./syncChannels";
import { toCsv } from "../scripts/fieldBonusReport";
import type { Period } from "./period";

export { todayInFieldTz };

export async function computeBonusReport(
  period: Period,
  opts: { write?: boolean; onLog?: (m: string) => void } = {},
): Promise<BonusReport> {
  const log = opts.onLog ?? (() => {});

  const aliases = mergeAliases(SEED_ALIASES, await readAliases());
  const messages = (await readChannelMessages("field-qa", period)).filter((m) => !m.deleted);
  const reports = parseMonth(messages, aliases);
  log(`field-bonus: parsed ${reports.length} Звіт reports`);

  const videos = await fetchVideosInPeriod(period.start, period.end);
  const videoMinutesByDate: Record<string, number> = {};
  for (const v of videos) {
    const d = videoFlightDate(v.name, v.created_time);
    videoMinutesByDate[d] = (videoMinutesByDate[d] ?? 0) + v.duration / 60;
  }

  const losses: LossRecord[] = [];
  for (const r of reports) {
    if (!r.crashText) continue;
    const cls = await extractLoss(r.crashText);
    if (cls.lost) losses.push({ date: r.flightDate, found: cls.found, note: cls.note });
  }
  log(`field-bonus: ${losses.filter((l) => !l.found).length} unrecovered loss(es)`);

  const report = computeBonuses({ period, reports, videoMinutesByDate, losses });

  if (opts.write) {
    const { key } = await writeReport("field-bonus", period, { json: JSON.stringify(report), csv: toCsv(report) });
    log(`field-bonus: wrote report for ${key}`);
  }
  return report;
}
```

```ts
// scripts/field-bonus.ts
/**
 * CLI: recompute per-person field bonuses for a window.
 * Usage: npm run field-bonus -- --start 2026-05-01 --end 2026-05-31 [--format table] [--write]
 * Defaults to the current Europe/Kyiv month. Runs under --conditions=react-server.
 */
import { computeBonusReport, todayInFieldTz } from "../lib/computeBonuses";
import { parseArgs, resolvePeriod, formatTable } from "./fieldBonusReport";

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }
  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayInFieldTz());
  const report = await computeBonusReport(period, { write: args.write, onLog: (m) => process.stderr.write(`${m}\n`) });
  if (args.format === "table") console.log(formatTable(report));
  else console.log(JSON.stringify(report, null, 2));
}

main().catch((e: unknown) => {
  process.stderr.write(`field-bonus: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
```

In `package.json` `scripts`, after `"field-approvals"`, add:

```json
    "field-bonus": "node --conditions=react-server --import tsx scripts/field-bonus.ts",
```

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 3: Smoke-run against the current month**

Run: `npm run field-bonus -- --start 2026-06-01 --end 2026-06-30 --format table`
Expected: a table of per-person bonuses with no crash (requires `VIMEO_TOKEN`, `ANTHROPIC_API_KEY`, `POSTGRES_URL`, and a synced `#field-qa` mirror).

- [ ] **Step 4: Commit**

```bash
git add lib/computeBonuses.ts scripts/field-bonus.ts package.json
git commit -m "feat(field-bonus): orchestrator + npm run field-bonus CLI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: May reconciliation against the sheet (`--sheet`)

**Files:**
- Create: `lib/fieldBonusDiff.ts` (pure), `lib/fieldBonusDiff.test.ts`
- Modify: `scripts/field-bonus.ts` (wire `--sheet`), `lib/computeBonuses.ts` (no change — diff runs in the CLI)

**Interfaces:**
- Consumes: `BonusReport` (Task 3).
- Produces: `parseSheetTotals(csv: string): Record<string, { trips: number; early: number; weekend: number }>`; `diffAgainstSheet(report: BonusReport, sheet: Record<string, { trips: number; early: number; weekend: number }>): { name: string; field: string; ours: number; theirs: number }[]`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/fieldBonusDiff.test.ts
import { describe, it, expect } from "vitest";
import { diffAgainstSheet } from "./fieldBonusDiff";
import type { BonusReport } from "./fieldBonus";

const report = { people: [{ name: "Андріан", trips: 14, early: 9, weekend: 3, gross: 0, penaltyPct: 0, net: 0 }] } as unknown as BonusReport;

describe("diffAgainstSheet", () => {
  it("flags a weekend-count divergence", () => {
    const out = diffAgainstSheet(report, { Андріан: { trips: 14, early: 9, weekend: 4 } });
    expect(out).toContainEqual({ name: "Андріан", field: "weekend", ours: 3, theirs: 4 });
  });
  it("is empty when everything matches", () => {
    expect(diffAgainstSheet(report, { Андріан: { trips: 14, early: 9, weekend: 3 } })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/fieldBonusDiff.test.ts`
Expected: FAIL — `Cannot find module './fieldBonusDiff'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/fieldBonusDiff.ts
/** Compare computed per-person counts to a sheet export (by_people.csv) to surface divergences. */
import type { BonusReport } from "./fieldBonus";

type Counts = { trips: number; early: number; weekend: number };

export function parseSheetTotals(csv: string): Record<string, Counts> {
  // Expects rows: person,trips,early,weekend (a normalized export). Lossy sheets
  // are normalized by hand before passing; this parser is intentionally simple.
  const out: Record<string, Counts> = {};
  for (const line of csv.split("\n").slice(1)) {
    const [name, trips, early, weekend] = line.split(",");
    if (!name) continue;
    out[name.trim()] = { trips: Number(trips), early: Number(early), weekend: Number(weekend) };
  }
  return out;
}

export function diffAgainstSheet(report: BonusReport, sheet: Record<string, Counts>): { name: string; field: string; ours: number; theirs: number }[] {
  const diffs: { name: string; field: string; ours: number; theirs: number }[] = [];
  for (const p of report.people) {
    const s = sheet[p.name];
    if (!s) { diffs.push({ name: p.name, field: "present", ours: 1, theirs: 0 }); continue; }
    for (const f of ["trips", "early", "weekend"] as const) if (p[f] !== s[f]) diffs.push({ name: p.name, field: f, ours: p[f], theirs: s[f] });
  }
  return diffs;
}
```

In `scripts/field-bonus.ts`, after computing `report` and before printing, add (and import `readFileSync` + the diff helpers):

```ts
  if (args.sheet) {
    const { parseSheetTotals, diffAgainstSheet } = await import("../lib/fieldBonusDiff");
    const { readFileSync } = await import("node:fs");
    const diffs = diffAgainstSheet(report, parseSheetTotals(readFileSync(args.sheet, "utf8")));
    process.stderr.write(diffs.length ? `field-bonus: ${diffs.length} divergence(s) vs sheet:\n${diffs.map((d) => `  ${d.name}.${d.field}: ours=${d.ours} sheet=${d.theirs}`).join("\n")}\n` : "field-bonus: matches sheet exactly\n");
  }
```

- [ ] **Step 4: Run test + the real May reconciliation**

Run: `npx vitest run lib/fieldBonusDiff.test.ts`
Expected: PASS.

Then build a normalized `person,trips,early,weekend` CSV from `docs/Personal Field Metrics May 2026/by_people.csv` (the sheet's per-person counts) and run:
Run: `npm run field-bonus -- --start 2026-05-01 --end 2026-05-31 --sheet /tmp/may_sheet.csv --format table`
Expected: the divergence list names only the known anomaly days/people (05-07/25/30 excluded though qualifying; 05-11 zero-video). Capture this output in the PR description.

- [ ] **Step 5: Commit**

```bash
git add lib/fieldBonusDiff.ts lib/fieldBonusDiff.test.ts scripts/field-bonus.ts
git commit -m "feat(field-bonus): --sheet reconciliation diff

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Unknown-initial thread-ask flow

**Files:**
- Create: `lib/bonusAsks.ts` (server-only thin wrapper over the existing `asks` store + Slack post), `scripts/field-bonus.ts` (extend `--ask`/`--publish`)
- Reuse: the existing Slack post helper used by `field-ask` (locate via `grep -rn "chat.postMessage\|postToThread\|publishToSlack" lib scripts`).

**Interfaces:**
- Consumes: `BonusReport.flags` (Task 3) filtered to `kind === "unknown_initial"`; the existing asks store + Slack poster.
- Produces: `askUnknownInitials(report: BonusReport, reports: FieldReport[], opts: { publish: boolean; onLog }): Promise<{ asked: { date: string; initial: string; threadTs: string }[] }>`.

- [ ] **Step 1: Write the flow** (DRY-RUN by default — prints the Ukrainian question + target thread; `--publish` posts; each (date, initial) asked at most once via the asks store, mirroring `field-ask`)

Question template: `Хто це: «${initial}»? (звіт за ${DD.MM})` posted as a reply to `report.threadTs` for that date.

Wire into `scripts/field-bonus.ts`: when `args.ask`, after computing the report, call `askUnknownInitials(report, reports, { publish: args.publish, onLog })`. (Expose `reports` from `computeBonusReport` by returning `{ report, reports }` or add a thin `parseReportsForPeriod` reader; keep the calculator return shape unchanged for the web.)

- [ ] **Step 2: Type-check + dry-run**

Run: `npx tsc --noEmit && npm run field-bonus -- --start 2026-05-01 --end 2026-05-31 --ask`
Expected: prints `[dry-run] would ask in thread …: Хто це: «М»? (звіт за 27.05)` and posts nothing.

- [ ] **Step 3: Commit**

```bash
git add lib/bonusAsks.ts scripts/field-bonus.ts lib/computeBonuses.ts
git commit -m "feat(field-bonus): ask in-thread for unknown roster initials (dry-run default)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: API route

**Files:**
- Create: `app/api/field-bonus/route.ts`
- Reference: an existing reporting route (`app/api/field-verdict/route.ts` or `app/api/jira/route.ts`) for the exact hybrid shape.

**Interfaces:**
- Consumes: `readReportJson`/`listPeriods` (committed), `computeBonusReport` (live), `parsePeriodKey`.

- [ ] **Step 1: Write the route** (mirror the existing reporting route exactly)

```ts
// app/api/field-bonus/route.ts
import { NextResponse } from "next/server";
import { readReportJson, listPeriods } from "@/lib/reports";
import { parsePeriodKey } from "@/lib/period";
import { computeBonusReport } from "@/lib/computeBonuses";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("periods") === "1") return NextResponse.json({ periods: await listPeriods("field-bonus") });
  const refresh = url.searchParams.get("refresh") === "1";
  if (refresh) {
    const start = url.searchParams.get("start"); const end = url.searchParams.get("end");
    if (!start || !end) return NextResponse.json({ error: "start and end required" }, { status: 400 });
    return NextResponse.json(await computeBonusReport({ start, end }));
  }
  const periodKey = url.searchParams.get("period");
  if (!periodKey || !parsePeriodKey(periodKey)) return NextResponse.json({ error: "valid period required" }, { status: 400 });
  const report = await readReportJson("field-bonus", periodKey);
  if (!report) return NextResponse.json({ error: "no committed report" }, { status: 404 });
  return NextResponse.json(report);
}
```

- [ ] **Step 2: Type-check + verify the committed/refresh/periods paths**

Run: `npx tsc --noEmit`, then `npm run dev` and `curl 'http://localhost:3003/api/field-bonus?period=2026-05'` (expect the committed JSON after Task 7/8 `--write`), `curl 'http://localhost:3003/api/field-bonus?periods=1'`.
Expected: committed JSON; period list; 404 for an un-written period.

- [ ] **Step 3: Commit**

```bash
git add app/api/field-bonus/route.ts
git commit -m "feat(field-bonus): /api/field-bonus hybrid route

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Dashboard tab

**Files:**
- Create: `app/(dashboard)/field-bonus/page.tsx`
- Modify: `app/(dashboard)/layout.tsx` (add the nav entry with `enabled: true`)
- Reference: an existing reporting page (e.g. `app/(dashboard)/dev-reporting/page.tsx`) for the `usePeriodReport` usage.

**Interfaces:**
- Consumes: `usePeriodReport` hook; `/api/field-bonus`.

- [ ] **Step 1: Add the nav entry**

In `app/(dashboard)/layout.tsx`, add to the nav array: `{ href: "/field-bonus", label: "Field Bonus", enabled: true }` (match the existing item shape).

- [ ] **Step 2: Write the page** (client component using the shared hook; per-person table + flags/penalties panel). Model it on `dev-reporting/page.tsx`: period picker → render committed `people[]` as a table (person, trips, early, weekend, gross, penalty %, net), a TOTAL row, and a panel listing `flags` and `penalties`; "Refresh live" for the current month calls `?refresh=1&start=&end=`.

- [ ] **Step 3: Type-check + lint + visual check**

Run: `npx tsc --noEmit && npm run lint`, then `npm run dev` and open `http://localhost:3003/field-bonus`.
Expected: the committed May/June report renders; the flags panel shows the unknown-initial / anomaly entries.

- [ ] **Step 4: Commit**

```bash
git add "app/(dashboard)/field-bonus/page.tsx" "app/(dashboard)/layout.tsx"
git commit -m "feat(field-bonus): dashboard tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Skill + docs

**Files:**
- Create: `.claude/skills/field-bonus/SKILL.md`
- Modify: `CLAUDE.md` (add the `npm run field-bonus` command to the Commands list)

**Interfaces:** none (documentation).

- [ ] **Step 1: Write the skill** describing: when to use (per-person bonus questions, "what did X earn in May"), the CLI (`npm run field-bonus -- --start --end [--format table] [--write] [--ask] [--publish] [--sheet]`), the policy gate (3h + 2min video), the prerequisites (`npm run slack-sync` first; `VIMEO_TOKEN` + `ANTHROPIC_API_KEY`), and the out-of-scope ready-drone fund. Follow the structure of `.claude/skills/vimeo-stats/SKILL.md`.

- [ ] **Step 2: Add the CLAUDE.md command line** under Commands, after the `field-approvals` bullet, summarizing the CLI + that it recomputes per-person bonuses from `#field-qa` + Vimeo with the 3h+2min gate.

- [ ] **Step 3: Run the full suite + lint**

Run: `npm test && npm run lint`
Expected: all tests pass, no lint errors.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/field-bonus/SKILL.md CLAUDE.md
git commit -m "docs(field-bonus): skill + CLAUDE.md command

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Policy (700/200/300, 3h+2min gate, loss multiplier, team cutoff) → Task 3. ✓
- `fieldRoster` → Task 1; `fieldReports` parser variances → Task 2; `fieldBonus` → Task 3; `lossExtract` → Task 4; unknown-initial thread-ask → Task 9. ✓
- Video by date-in-name → Task 7 (reuses `videoFlightDate`). ✓
- CLI (`--write`/`--ask`/`--publish`/`--sheet`/`--format`) → Tasks 6–9. ✓
- Web (`/api/field-bonus` + tab, hybrid) → Tasks 10–11. ✓
- Persistence (DB report store + roster aliases + asks) → Tasks 5, 7, 9. ✓
- Reconcile-don't-force-match (diff vs sheet) → Task 8. ✓
- Testing matrix (parser variances, gate boundaries, loss windows, team cutoff) → Tasks 1–3, 6, 8. ✓
- Out-of-scope (ready-drone fund) → noted in Task 12 skill.

**Placeholder scan:** UI page (Task 11 Step 2) and skill text (Task 12) describe content by reference to concrete existing files rather than inlining markup/prose — acceptable for view/doc layers that must match house styling; all logic-bearing tasks (1–10) carry full code.

**Type consistency:** `FieldReport`, `BonusReport`, `PersonBonus`, `LossRecord`, `LossExtract`, `RosterResolution` names and shapes are used identically across Tasks 1–11; `computeBonuses` input shape matches its caller in Task 7; `videoMinutesByDate` is `Record<string, number>` in both producer (Task 7) and consumer (Task 3).
