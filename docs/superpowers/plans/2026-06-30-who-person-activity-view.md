# `who` — person-centric activity view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `who` feature — one CLI (`npm run who`) and one **People** dashboard tab — that joins a single person's Slack timeline with their Jira / GitHub / field-bonus period summaries, all from local committed/DB reads.

**Architecture:** A hardcoded identity registry (`lib/people.ts`, styled like `lib/approvers.ts`) maps one human to their Slack id / Jira account / GitHub login / roster initial. A pure assembler (`lib/who.ts`) takes a `Person` + the period's already-read sources and returns a `PersonView` (Slack-spine timeline + summary blocks). A thin CLI shell and a committed-only API route read the sources and call the assembler. A separate `people:scaffold` command proposes registry entries from live directories for human review.

**Tech Stack:** TypeScript (strict), Next.js 16 App Router, React 19, Vitest, Drizzle/Neon Postgres (via `lib/reports.ts` + `lib/slackMirror.ts`), the `server-only` + `--conditions=react-server` CLI discipline.

## Global Constraints

- **Two interfaces, non-negotiable:** every feature ships a CLI **and** a web surface sharing pure `lib/` logic (CLAUDE.md).
- **Pure `lib/` modules:** `lib/people.ts` and `lib/who.ts` must have **no** `node:fs`, DB, or Next imports — sources are passed in; they are unit-tested in isolation (the `lib/reconcile.ts` discipline).
- **`@/*` import alias** maps to the repo root (`tsconfig.json`).
- **Period key** is canonical via `periodKey(period)` from `lib/period.ts`: `YYYY-MM` for a single month, else `YYYY-MM-DD_YYYY-MM-DD`.
- **Committed-by-default, no live query path:** `who` reads the Slack mirror DB + committed report JSON only; it never fetches live or writes a `reports/` artifact. (Only `people:scaffold` touches a live directory, and only to print proposals.)
- **Default period:** current `Europe/Kyiv` calendar month when bounds are omitted.
- **CLI run line:** scripts that import `server-only`-backed modules run `node --conditions=react-server --import tsx scripts/<x>.ts` (see existing `vimeo`/`field-bonus` scripts).
- **Commit message footer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Confirmed source shapes (read once, reused by every task)

- **Slack** — `readChannelMessages(channel, period): Promise<StoredMessage[]>` from `lib/slackMirror.ts` (DB-backed, already time-sorted). `StoredMessage = { ts, channel, authorId, author, isoTime, text, permalink, files?, thread_ts?, reply_count?, edited?, deleted?, firstSeen, lastSeen }`. Tracked channels: `TRACKED_CHANNELS` from `lib/slackChannels.ts` (`{id,name}[]`; use `.name`).
- **Jira report** (`readReportJson('jira', key)`) — top-level `rows: UserRow[]`, where `UserRow = { accountId: string|null, displayName, resolvedCount, storyPoints, issueKeys: string[] }`.
- **GitHub report** (`readReportJson('github', key)`) — top-level `contributors: { key, login, displayName, isBot, unlinked, commits, additions, deletions, net, prsOpened, prsMerged }[]`.
- **Field-bonus report** (`readReportJson('field-bonus', key)`) — `BonusReport = { period, days: DayBonus[], people: PersonBonus[], penalties, teamZeroed, flags, total }`; `PersonBonus = { name, trips, early, weekend, gross, penaltyPct, net }` (keyed by roster **name**); `DayBonus = { date, roster: string[], deployMin: number|null, videoMin, counted, early, weekend, reason }`.
- **Roster** — `resolveInitial(token, aliases?): { name } | { unknown }` from `lib/fieldRoster.ts` maps a Cyrillic initial to a roster name.
- **Period helpers** — `periodKey`, `parsePeriodKey` from `lib/period.ts`; `Period = { start, end }` (both `YYYY-MM-DD`).

---

### Task 1: `lib/people.ts` — identity registry + pure resolvers

**Files:**
- Create: `lib/people.ts`
- Test: `lib/people.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module; `PEOPLE` is a literal).
- Produces:
  - `interface Person { name: string; role: string; slackId?: string; jiraAccount?: string; githubLogin?: string; rosterInitial?: string }`
  - `const PEOPLE: Person[]`
  - `personByQuery(q: string, people?: Person[]): { person: Person } | { ambiguous: Person[] } | { unknown: string }`
  - `personForSlackId(id: string, people?: Person[]): Person | undefined`
  - `personForGithubLogin(login: string, people?: Person[]): Person | undefined`
  - `personForJiraAccount(acct: string, people?: Person[]): Person | undefined`
  - `personForInitial(initial: string, people?: Person[]): Person | undefined`

- [ ] **Step 1: Write the failing test**

```ts
// lib/people.test.ts
import { describe, it, expect } from "vitest";
import {
  personByQuery,
  personForSlackId,
  personForGithubLogin,
  personForJiraAccount,
  personForInitial,
  type Person,
} from "./people";

const FIX: Person[] = [
  { name: "Oleksandr K", role: "CEO/CTO", slackId: "U1", jiraAccount: "acc-o", githubLogin: "oknyga", rosterInitial: "О" },
  { name: "Bohdan Forostianyi", role: "Head of Engineering", slackId: "U2", githubLogin: "bohdanf" },
  { name: "Bohdana Petrenko", role: "developer", slackId: "U3" },
];

describe("personByQuery", () => {
  it("matches an exact name case-insensitively", () => {
    expect(personByQuery("oleksandr k", FIX)).toEqual({ person: FIX[0] });
  });
  it("matches a unique substring", () => {
    expect(personByQuery("oleks", FIX)).toEqual({ person: FIX[0] });
  });
  it("returns ambiguous when a substring hits more than one", () => {
    const r = personByQuery("bohdan", FIX);
    expect(r).toEqual({ ambiguous: [FIX[1], FIX[2]] });
  });
  it("prefers an exact name over a substring superset", () => {
    // "Bohdana Petrenko" contains no exact tie; exact wins when present
    expect(personByQuery("Bohdana Petrenko", FIX)).toEqual({ person: FIX[2] });
  });
  it("returns unknown when nothing matches", () => {
    expect(personByQuery("zzz", FIX)).toEqual({ unknown: "zzz" });
  });
});

describe("reverse lookups", () => {
  it("finds by slack id", () => {
    expect(personForSlackId("U2", FIX)).toBe(FIX[1]);
  });
  it("finds by github login", () => {
    expect(personForGithubLogin("oknyga", FIX)).toBe(FIX[0]);
  });
  it("finds by jira account", () => {
    expect(personForJiraAccount("acc-o", FIX)).toBe(FIX[0]);
  });
  it("finds by roster initial", () => {
    expect(personForInitial("О", FIX)).toBe(FIX[0]);
  });
  it("returns undefined when no person carries that identity", () => {
    expect(personForSlackId("U9", FIX)).toBeUndefined();
    expect(personForJiraAccount("none", FIX)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/people.test.ts`
Expected: FAIL — `Cannot find module './people'` / exports not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/people.ts
/**
 * Hardcoded, auditable people registry — the one place that joins a single
 * human across the console's identity namespaces (Slack id, Jira account,
 * GitHub login, #field-qa Cyrillic initial). Styled like lib/approvers.ts and
 * lib/slackChannels.ts: membership is a deliberate, version-controlled decision,
 * not runtime config and not name-matched on the fly (name guessing across
 * sources silently mis-joins people — the failure mode this registry prevents).
 *
 * Every external-id field is optional: field operators carry rosterInitial
 * (+ slackId); developers carry jiraAccount/githubLogin. Seed below with what is
 * known in-repo; fill the rest from `npm run people:scaffold` proposals after a
 * human review. Pure — no DB/Next imports; PEOPLE is a literal.
 */
export interface Person {
  /** Canonical display name (NOT the Cyrillic roster name). */
  name: string;
  role: string;
  slackId?: string;
  jiraAccount?: string;
  githubLogin?: string;
  rosterInitial?: string;
}

export const PEOPLE: Person[] = [
  { name: "Oleksandr K", role: "CEO/CTO", slackId: "U08G4EC244X", rosterInitial: "О" },
  { name: "Bohdan Forostianyi", role: "Head of Engineering", slackId: "U08G4HZQTTR" },
];

/** Resolve a CLI `--person` query: exact (case-insensitive) name first, then a
 *  unique case-insensitive substring; >1 substring hit is ambiguous. */
export function personByQuery(
  q: string,
  people: Person[] = PEOPLE,
): { person: Person } | { ambiguous: Person[] } | { unknown: string } {
  const needle = q.trim().toLowerCase();
  if (!needle) return { unknown: q };
  const exact = people.find((p) => p.name.toLowerCase() === needle);
  if (exact) return { person: exact };
  const hits = people.filter((p) => p.name.toLowerCase().includes(needle));
  if (hits.length === 1) return { person: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };
  return { unknown: q };
}

export function personForSlackId(id: string, people: Person[] = PEOPLE): Person | undefined {
  return people.find((p) => p.slackId === id);
}
export function personForGithubLogin(login: string, people: Person[] = PEOPLE): Person | undefined {
  return people.find((p) => p.githubLogin === login);
}
export function personForJiraAccount(acct: string, people: Person[] = PEOPLE): Person | undefined {
  return people.find((p) => p.jiraAccount === acct);
}
export function personForInitial(initial: string, people: Person[] = PEOPLE): Person | undefined {
  return people.find((p) => p.rosterInitial === initial);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/people.test.ts`
Expected: PASS (11 assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/people.ts lib/people.test.ts
git commit -m "feat(who): people registry + pure identity resolvers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `lib/who.ts` — pure PersonView assembler + unlinked detector

**Files:**
- Create: `lib/who.ts`
- Test: `lib/who.test.ts`

**Interfaces:**
- Consumes: `Person` from Task 1 (`@/lib/people`); `resolveInitial` from `@/lib/fieldRoster`; `Period` from `@/lib/period`; `StoredMessage` from `@/lib/slackMirror`.
- Produces:
  - `interface TimelineEntry { ts: string; isoTime: string; channel: string; text: string; permalink: string }`
  - `interface JiraSummary { issueKeys: string[]; count: number; points: number }`
  - `interface GithubSummary { commits: number; additions: number; deletions: number; prsOpened: number; prsMerged: number }`
  - `interface FieldSummary { trips: number; flightDays: number; flightMinutes: number; netUah: number }`
  - `interface WhoSources { messages: StoredMessage[]; jira: { rows: { accountId: string | null; issueKeys: string[]; storyPoints: number }[] } | null; github: { contributors: { login: string; commits: number; additions: number; deletions: number; prsOpened: number; prsMerged: number }[] } | null; bonus: { people: { name: string; trips: number; net: number }[]; days: { date: string; roster: string[]; deployMin: number | null }[] } | null }`
  - `interface PersonView { person: Person; period: Period; timeline: TimelineEntry[]; summary: { jira?: JiraSummary; github?: GithubSummary; field?: FieldSummary } }`
  - `interface UnlinkedReport { slack: string[]; jira: string[]; github: string[]; roster: string[] }`
  - `buildPersonView(person: Person, period: Period, sources: WhoSources): PersonView`
  - `findUnlinked(sources: WhoSources, people: Person[]): UnlinkedReport`

- [ ] **Step 1: Write the failing test**

```ts
// lib/who.test.ts
import { describe, it, expect } from "vitest";
import { buildPersonView, findUnlinked, type WhoSources } from "./who";
import type { Person } from "./people";
import type { StoredMessage } from "./slackMirror";

const PERIOD = { start: "2026-06-01", end: "2026-06-30" };

function msg(over: Partial<StoredMessage>): StoredMessage {
  return {
    ts: "1", channel: "general", authorId: "U1", author: "X",
    isoTime: "2026-06-02T09:00:00.000Z", text: "hi", permalink: "p",
    firstSeen: "x", lastSeen: "x", ...over,
  };
}

const OLEKS: Person = {
  name: "Oleksandr K", role: "CEO/CTO",
  slackId: "U1", jiraAccount: "acc-o", githubLogin: "oknyga", rosterInitial: "О",
};

describe("buildPersonView timeline", () => {
  it("keeps only this person's messages, sorted by ts, dropping tombstones", () => {
    const sources: WhoSources = {
      messages: [
        msg({ ts: "3", authorId: "U1", channel: "datasets", isoTime: "2026-06-03T10:00:00.000Z", text: "c" }),
        msg({ ts: "1", authorId: "U1", channel: "general", isoTime: "2026-06-01T08:00:00.000Z", text: "a" }),
        msg({ ts: "2", authorId: "U2", text: "not mine" }),
        msg({ ts: "4", authorId: "U1", text: "deleted", deleted: true }),
      ],
      jira: null, github: null, bonus: null,
    };
    const view = buildPersonView(OLEKS, PERIOD, sources);
    expect(view.timeline.map((t) => t.text)).toEqual(["a", "c"]);
    expect(view.timeline[0]).toMatchObject({ channel: "general", permalink: "p" });
  });
});

describe("buildPersonView summary", () => {
  it("attaches jira/github/field blocks when identity + report present", () => {
    const sources: WhoSources = {
      messages: [],
      jira: { rows: [
        { accountId: "acc-o", issueKeys: ["ORI-1", "ORI-2"], storyPoints: 5 },
        { accountId: "other", issueKeys: ["X-9"], storyPoints: 1 },
      ] },
      github: { contributors: [
        { login: "oknyga", commits: 12, additions: 900, deletions: 120, prsOpened: 4, prsMerged: 3 },
      ] },
      bonus: {
        people: [{ name: "Олександр", trips: 2, net: 900 }],
        days: [
          { date: "2026-06-05", roster: ["Олександр", "Андріан"], deployMin: 200 },
          { date: "2026-06-06", roster: ["Андріан"], deployMin: 180 },
          { date: "2026-06-07", roster: ["Олександр"], deployMin: 150 },
        ],
      },
    };
    const view = buildPersonView(OLEKS, PERIOD, sources);
    expect(view.summary.jira).toEqual({ issueKeys: ["ORI-1", "ORI-2"], count: 2, points: 5 });
    expect(view.summary.github).toEqual({ commits: 12, additions: 900, deletions: 120, prsOpened: 4, prsMerged: 3 });
    // field: roster name "Олександр" resolved from rosterInitial "О"; flightDays/minutes
    // summed over days whose roster includes that name.
    expect(view.summary.field).toEqual({ trips: 2, flightDays: 2, flightMinutes: 350, netUah: 900 });
  });

  it("omits a block when the person lacks that identity", () => {
    const noGh: Person = { name: "Op", role: "field operator", slackId: "U1", rosterInitial: "А" };
    const sources: WhoSources = {
      messages: [],
      jira: { rows: [{ accountId: "acc-o", issueKeys: ["ORI-1"], storyPoints: 1 }] },
      github: { contributors: [{ login: "oknyga", commits: 1, additions: 1, deletions: 0, prsOpened: 0, prsMerged: 0 }] },
      bonus: null,
    };
    const view = buildPersonView(noGh, PERIOD, sources);
    expect(view.summary.jira).toBeUndefined();   // no jiraAccount
    expect(view.summary.github).toBeUndefined();  // no githubLogin
    expect(view.summary.field).toBeUndefined();   // no bonus report
  });

  it("omits a block when the report is present but has no matching row", () => {
    const sources: WhoSources = {
      messages: [],
      jira: { rows: [{ accountId: "someone-else", issueKeys: ["X-1"], storyPoints: 1 }] },
      github: null, bonus: null,
    };
    expect(buildPersonView(OLEKS, PERIOD, sources).summary.jira).toBeUndefined();
  });
});

describe("findUnlinked", () => {
  it("lists identities present in data but claimed by no person", () => {
    const people: Person[] = [OLEKS];
    const sources: WhoSources = {
      messages: [msg({ authorId: "U1" }), msg({ authorId: "U_unknown" })],
      jira: { rows: [{ accountId: "acc-o", issueKeys: [], storyPoints: 0 }, { accountId: "acc-x", issueKeys: [], storyPoints: 0 }] },
      github: { contributors: [{ login: "oknyga", commits: 0, additions: 0, deletions: 0, prsOpened: 0, prsMerged: 0 }, { login: "petro-x", commits: 0, additions: 0, deletions: 0, prsOpened: 0, prsMerged: 0 }] },
      bonus: { people: [{ name: "Олександр", trips: 0, net: 0 }, { name: "Невідомий", trips: 0, net: 0 }], days: [] },
    };
    const r = findUnlinked(sources, people);
    expect(r.slack).toEqual(["U_unknown"]);
    expect(r.jira).toEqual(["acc-x"]);
    expect(r.github).toEqual(["petro-x"]);
    expect(r.roster).toEqual(["Невідомий"]); // "Олександр" is linked via О; "Невідомий" is not
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/who.test.ts`
Expected: FAIL — `Cannot find module './who'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/who.ts
/**
 * Pure assembler for the `who` person-centric view. The Slack mirror is the
 * timestamped spine; Jira / GitHub / field-bonus attach as period summaries.
 * No fs/DB/Next imports — the orchestrator (CLI / API route) reads the sources
 * and passes them in (the lib/reconcile.ts discipline).
 */
import type { Person } from "./people";
import { personForSlackId, personForJiraAccount, personForGithubLogin, personForInitial } from "./people";
import { resolveInitial } from "./fieldRoster";
import type { Period } from "./period";
import type { StoredMessage } from "./slackMirror";

export interface TimelineEntry { ts: string; isoTime: string; channel: string; text: string; permalink: string }
export interface JiraSummary { issueKeys: string[]; count: number; points: number }
export interface GithubSummary { commits: number; additions: number; deletions: number; prsOpened: number; prsMerged: number }
export interface FieldSummary { trips: number; flightDays: number; flightMinutes: number; netUah: number }

export interface WhoSources {
  messages: StoredMessage[];
  jira: { rows: { accountId: string | null; issueKeys: string[]; storyPoints: number }[] } | null;
  github: { contributors: { login: string; commits: number; additions: number; deletions: number; prsOpened: number; prsMerged: number }[] } | null;
  bonus: { people: { name: string; trips: number; net: number }[]; days: { date: string; roster: string[]; deployMin: number | null }[] } | null;
}

export interface PersonView {
  person: Person;
  period: Period;
  timeline: TimelineEntry[];
  summary: { jira?: JiraSummary; github?: GithubSummary; field?: FieldSummary };
}

export interface UnlinkedReport { slack: string[]; jira: string[]; github: string[]; roster: string[] }

/** Roster (Cyrillic) name for a person via their rosterInitial, or undefined. */
function rosterName(person: Person): string | undefined {
  if (!person.rosterInitial) return undefined;
  const r = resolveInitial(person.rosterInitial);
  return "name" in r ? r.name : undefined;
}

export function buildPersonView(person: Person, period: Period, sources: WhoSources): PersonView {
  const timeline: TimelineEntry[] = sources.messages
    .filter((m) => !m.deleted && person.slackId && m.authorId === person.slackId)
    .map((m) => ({ ts: m.ts, isoTime: m.isoTime, channel: m.channel, text: m.text, permalink: m.permalink }))
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const summary: PersonView["summary"] = {};

  if (person.jiraAccount && sources.jira) {
    const row = sources.jira.rows.find((r) => r.accountId === person.jiraAccount);
    if (row) summary.jira = { issueKeys: row.issueKeys, count: row.issueKeys.length, points: row.storyPoints };
  }

  if (person.githubLogin && sources.github) {
    const c = sources.github.contributors.find((c) => c.login === person.githubLogin);
    if (c) summary.github = { commits: c.commits, additions: c.additions, deletions: c.deletions, prsOpened: c.prsOpened, prsMerged: c.prsMerged };
  }

  const rname = rosterName(person);
  if (rname && sources.bonus) {
    const pb = sources.bonus.people.find((p) => p.name === rname);
    if (pb) {
      const myDays = sources.bonus.days.filter((d) => d.roster.includes(rname));
      const flightMinutes = myDays.reduce((sum, d) => sum + (d.deployMin ?? 0), 0);
      summary.field = { trips: pb.trips, flightDays: myDays.length, flightMinutes, netUah: pb.net };
    }
  }

  return { person, period, timeline, summary };
}

export function findUnlinked(sources: WhoSources, people: Person[]): UnlinkedReport {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const slack = uniq(sources.messages.map((m) => m.authorId).filter((id) => !personForSlackId(id, people)));
  const jira = uniq((sources.jira?.rows ?? [])
    .map((r) => r.accountId)
    .filter((a): a is string => a !== null && !personForJiraAccount(a, people)));
  const github = uniq((sources.github?.contributors ?? [])
    .map((c) => c.login)
    .filter((l) => !personForGithubLogin(l, people)));
  // A roster name is "linked" if some person's rosterInitial resolves to it.
  const linkedRosterNames = new Set(
    people
      .map((p) => (p.rosterInitial ? resolveInitial(p.rosterInitial) : null))
      .filter((r): r is { name: string } => !!r && "name" in r)
      .map((r) => r.name),
  );
  const roster = uniq((sources.bonus?.people ?? [])
    .map((p) => p.name)
    .filter((n) => !linkedRosterNames.has(n)));
  return { slack, jira, github, roster };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/who.test.ts`
Expected: PASS. (If the "field" assertion fails on roster name, confirm `resolveInitial("О")` returns `Олександр` in `lib/fieldRoster.ts` SEED_ALIASES — it does; the fixture roster names must match that seed.)

- [ ] **Step 5: Commit**

```bash
git add lib/who.ts lib/who.test.ts
git commit -m "feat(who): pure PersonView assembler + unlinked-identity detector

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `scripts/whoReport.ts` — pure CLI helpers (args, period default, formatting)

**Files:**
- Create: `scripts/whoReport.ts`
- Test: `scripts/whoReport.test.ts`

**Interfaces:**
- Consumes: `Period`, `periodKey` from `@/lib/period`; `PersonView` from `@/lib/who`; `UnlinkedReport` from `@/lib/who`.
- Produces:
  - `interface WhoArgs { person?: string; start?: string; end?: string; format?: string; unlinked: boolean }`
  - `parseArgs(argv: string[]): WhoArgs`
  - `resolvePeriod(args: WhoArgs, today: string): Period` (today = `YYYY-MM-DD` in Kyiv; defaults to that month)
  - `formatTable(view: PersonView): string`
  - `formatUnlinkedTable(report: UnlinkedReport): string`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/whoReport.test.ts
import { describe, it, expect } from "vitest";
import { parseArgs, resolvePeriod, formatTable, formatUnlinkedTable } from "./whoReport";
import type { PersonView } from "../lib/who";

describe("parseArgs", () => {
  it("parses person, bounds, format and unlinked flag", () => {
    expect(parseArgs(["--person", "bohdan", "--start", "2026-06-01", "--end", "2026-06-30", "--format", "table"]))
      .toEqual({ person: "bohdan", start: "2026-06-01", end: "2026-06-30", format: "table", unlinked: false });
    expect(parseArgs(["--unlinked"]).unlinked).toBe(true);
  });
});

describe("resolvePeriod", () => {
  it("uses explicit bounds when given", () => {
    expect(resolvePeriod({ start: "2026-05-02", end: "2026-05-20", unlinked: false }, "2026-06-15"))
      .toEqual({ start: "2026-05-02", end: "2026-05-20" });
  });
  it("defaults to the current Kyiv calendar month", () => {
    expect(resolvePeriod({ unlinked: false }, "2026-06-15"))
      .toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });
});

describe("formatTable", () => {
  it("renders the person header, timeline rows and present summary blocks", () => {
    const view: PersonView = {
      person: { name: "Oleksandr K", role: "CEO/CTO", slackId: "U1" },
      period: { start: "2026-06-01", end: "2026-06-30" },
      timeline: [{ ts: "1", isoTime: "2026-06-03T09:12:00.000Z", channel: "datasets", text: "dataset за 02.06", permalink: "p" }],
      summary: { jira: { issueKeys: ["ORI-1"], count: 1, points: 3 } },
    };
    const out = formatTable(view);
    expect(out).toContain("Oleksandr K");
    expect(out).toContain("datasets");
    expect(out).toContain("dataset за 02.06");
    expect(out).toContain("jira");
    expect(out).not.toContain("github"); // absent block not printed
  });
});

describe("formatUnlinkedTable", () => {
  it("lists each namespace's unlinked identities", () => {
    const out = formatUnlinkedTable({ slack: ["U_x"], jira: [], github: ["petro-x"], roster: ["Невідомий"] });
    expect(out).toContain("U_x");
    expect(out).toContain("petro-x");
    expect(out).toContain("Невідомий");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/whoReport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/whoReport.ts
/** Pure CLI helpers for `who`: arg parsing, period defaulting, table rendering. */
import type { Period } from "../lib/period";
import type { PersonView, UnlinkedReport } from "../lib/who";

export interface WhoArgs { person?: string; start?: string; end?: string; format?: string; unlinked: boolean }

export function parseArgs(argv: string[]): WhoArgs {
  const args: WhoArgs = { unlinked: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--unlinked") args.unlinked = true;
    else if (a === "--person") args.person = argv[++i];
    else if (a === "--start") args.start = argv[++i];
    else if (a === "--end") args.end = argv[++i];
    else if (a === "--format") args.format = argv[++i];
  }
  return args;
}

/** End-of-month day for the month containing `today` (YYYY-MM-DD). */
function monthBounds(today: string): Period {
  const [y, m] = today.split("-").map(Number);
  const start = `${today.slice(0, 7)}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based → day 0 of next month
  const end = `${today.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

export function resolvePeriod(args: WhoArgs, today: string): Period {
  if (args.start && args.end) return { start: args.start, end: args.end };
  return monthBounds(today);
}

export function formatTable(view: PersonView): string {
  const lines: string[] = [];
  lines.push(`PERSON: ${view.person.name} (${view.person.role})`);
  lines.push(`PERIOD: ${view.period.start} .. ${view.period.end}`);
  lines.push("── Slack timeline ──");
  if (view.timeline.length === 0) lines.push("  (no messages)");
  for (const t of view.timeline) {
    lines.push(`  ${t.isoTime.slice(0, 16).replace("T", " ")}  #${t.channel}  ${t.text.replace(/\s+/g, " ").slice(0, 80)}`);
  }
  lines.push("── Summary ──");
  if (view.summary.jira) lines.push(`  jira:   ${view.summary.jira.count} issues, ${view.summary.jira.points} pts  [${view.summary.jira.issueKeys.join(", ")}]`);
  if (view.summary.github) {
    const g = view.summary.github;
    lines.push(`  github: ${g.commits} commits, +${g.additions} -${g.deletions}, ${g.prsOpened} PRs opened / ${g.prsMerged} merged`);
  }
  if (view.summary.field) {
    const f = view.summary.field;
    lines.push(`  field:  ${f.trips} trips, ${f.flightDays} flight days, ${f.flightMinutes} min, ₴${f.netUah}`);
  }
  return lines.join("\n");
}

export function formatUnlinkedTable(report: UnlinkedReport): string {
  const lines = ["UNLINKED IDENTITIES (claimed by no person):"];
  const section = (label: string, xs: string[]) => { for (const x of xs) lines.push(`  ${label}: ${x}`); };
  section("slack ", report.slack);
  section("jira  ", report.jira);
  section("github", report.github);
  section("roster", report.roster);
  if (lines.length === 1) lines.push("  (none — every identity in the data is registered)");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/whoReport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/whoReport.ts scripts/whoReport.test.ts
git commit -m "feat(who): pure CLI helpers — args, period default, table render

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `scripts/who.ts` CLI shell + `npm run who` wiring

**Files:**
- Create: `scripts/who.ts`
- Modify: `package.json` (add `"who"` script)

**Interfaces:**
- Consumes: Task 1 (`personByQuery`, `PEOPLE`), Task 2 (`buildPersonView`, `findUnlinked`, `WhoSources`), Task 3 (`parseArgs`, `resolvePeriod`, `formatTable`, `formatUnlinkedTable`); `readChannelMessages` from `@/lib/slackMirror`; `TRACKED_CHANNELS` from `@/lib/slackChannels`; `readReportJson` + `periodKey` from `@/lib/reports` / `@/lib/period`.
- Produces: a runnable CLI; no exported API.

- [ ] **Step 1: Write the CLI shell**

```ts
// scripts/who.ts
/**
 * CLI: person-centric activity view for a window.
 *
 * Usage: npm run who -- --person <query> --start 2026-06-01 --end 2026-06-30 [--format table]
 *        npm run who -- --unlinked --start 2026-06-01 --end 2026-06-30
 * Defaults to the current Europe/Kyiv calendar month when bounds are omitted.
 *
 * Read-only: the Slack mirror DB + committed Jira/GitHub/field-bonus report JSON.
 * No live fetch, no --write. Runs under Node with --conditions=react-server so
 * server-only-backed imports resolve to their empty module.
 */
import { readChannelMessages } from "../lib/slackMirror";
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { readReportJson } from "../lib/reports";
import { periodKey } from "../lib/period";
import { PEOPLE, personByQuery } from "../lib/people";
import { buildPersonView, findUnlinked, type WhoSources } from "../lib/who";
import { parseArgs, resolvePeriod, formatTable, formatUnlinkedTable } from "./whoReport";

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function loadSources(period: { start: string; end: string }): Promise<WhoSources> {
  const perChannel = await Promise.all(TRACKED_CHANNELS.map((c) => readChannelMessages(c.name, period)));
  const key = periodKey(period);
  const [jira, github, bonus] = await Promise.all([
    readReportJson<WhoSources["jira"]>("jira", key),
    readReportJson<WhoSources["github"]>("github", key),
    readReportJson<WhoSources["bonus"]>("field-bonus", key),
  ]);
  return { messages: perChannel.flat(), jira, github, bonus };
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }
  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayInFieldTz());
  const sources = await loadSources(period);

  if (args.unlinked) {
    const report = findUnlinked(sources, PEOPLE);
    if (args.format === "table") console.log(formatUnlinkedTable(report));
    else console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (!args.person) {
    console.error("Provide --person <query> (or --unlinked).");
    process.exit(1);
  }
  const resolved = personByQuery(args.person);
  if ("unknown" in resolved) {
    console.error(`Unknown person "${resolved.unknown}". Known: ${PEOPLE.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }
  if ("ambiguous" in resolved) {
    console.error(`Ambiguous "${args.person}". Matches: ${resolved.ambiguous.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }
  const view = buildPersonView(resolved.person, period, sources);
  if (args.format === "table") console.log(formatTable(view));
  else console.log(JSON.stringify(view, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts`, add (next to `field-bonus`):

```json
"who": "node --conditions=react-server --import tsx scripts/who.ts",
```

- [ ] **Step 3: Run the CLI against the current month**

Run: `npm run who -- --unlinked --format table`
Expected: prints the `UNLINKED IDENTITIES` block (or "(none …)"), exit 0. Then:

Run: `npm run who -- --person oleksandr --format table`
Expected: a `PERSON: Oleksandr K (CEO/CTO)` header, a Slack timeline section, and a Summary section (blocks present only where a committed report + identity exist). Exit 0.

Run: `npm run who -- --person zzz`
Expected: stderr `Unknown person "zzz". Known: …`, exit 1.

- [ ] **Step 4: Commit**

```bash
git add scripts/who.ts package.json
git commit -m "feat(who): CLI shell + npm run who (read-only, committed sources)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `GET /api/who` route

**Files:**
- Create: `app/api/who/route.ts`

**Interfaces:**
- Consumes: Task 1 (`PEOPLE`, `personByQuery`), Task 2 (`buildPersonView`, `WhoSources`); `readChannelMessages`, `TRACKED_CHANNELS`, `readReportJson`, `parsePeriodKey`, `periodKey`.
- Produces: the HTTP contract `?people=1` → `{ people: string[] }`; `?person=&period=` → `PersonView`; errors per below.

- [ ] **Step 1: Write the route**

```ts
// app/api/who/route.ts
import { NextResponse } from "next/server";
import { readChannelMessages } from "@/lib/slackMirror";
import { TRACKED_CHANNELS } from "@/lib/slackChannels";
import { readReportJson } from "@/lib/reports";
import { parsePeriodKey } from "@/lib/period";
import { PEOPLE, personByQuery } from "@/lib/people";
import { buildPersonView, type WhoSources } from "@/lib/who";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/who — committed-only person view:
 *   ?people=1                 → { people } registry display names (for the picker)
 *   ?person=<query>&period=<key> → PersonView JSON (Slack timeline + summaries)
 * No live mode: reads the Slack mirror DB + committed Jira/GitHub/field-bonus.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("people")) {
    return NextResponse.json({ people: PEOPLE.map((p) => p.name) });
  }

  const personQ = searchParams.get("person");
  const periodKeyParam = searchParams.get("period");
  if (!personQ || !periodKeyParam) {
    return NextResponse.json({ error: "Provide `person` and `period`, or `people=1`." }, { status: 400 });
  }
  const period = parsePeriodKey(periodKeyParam);
  if (!period) {
    return NextResponse.json({ error: "`period` must be YYYY-MM or YYYY-MM-DD_YYYY-MM-DD." }, { status: 400 });
  }
  const resolved = personByQuery(personQ);
  if ("unknown" in resolved) {
    return NextResponse.json({ error: `Unknown person "${resolved.unknown}".` }, { status: 404 });
  }
  if ("ambiguous" in resolved) {
    return NextResponse.json({ error: "Ambiguous person.", candidates: resolved.ambiguous.map((p) => p.name) }, { status: 400 });
  }

  const perChannel = await Promise.all(TRACKED_CHANNELS.map((c) => readChannelMessages(c.name, period)));
  const [jira, github, bonus] = await Promise.all([
    readReportJson<WhoSources["jira"]>("jira", periodKeyParam),
    readReportJson<WhoSources["github"]>("github", periodKeyParam),
    readReportJson<WhoSources["bonus"]>("field-bonus", periodKeyParam),
  ]);
  const view = buildPersonView(resolved.person, period, { messages: perChannel.flat(), jira, github, bonus });
  return NextResponse.json(view);
}
```

- [ ] **Step 2: Verify the route compiles and responds**

Run: `npm run dev` (separate shell), then:
`curl -s 'http://localhost:3003/api/who?people=1'` → `{"people":[...]}`
`curl -s 'http://localhost:3003/api/who?person=oleksandr&period=2026-06'` → a `PersonView` JSON object (200), or 404/400 for bad input.

Alternatively rely on `npm run build` to type-check the route in Step 3 below.

- [ ] **Step 3: Commit**

```bash
git add app/api/who/route.ts
git commit -m "feat(who): GET /api/who committed-only route (people list + person view)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: **People** dashboard tab

**Files:**
- Create: `app/(dashboard)/people/page.tsx`
- Modify: `app/(dashboard)/layout.tsx` (add the nav tab)

**Interfaces:**
- Consumes: `GET /api/who` (Task 5). Reuses the repo's period-picker conventions; render-only.
- Produces: the `/people` page.

- [ ] **Step 1: Add the nav tab**

In `app/(dashboard)/layout.tsx`, add to the `TABS` array (after the GitHub/Field entries, before "Policy Tracking" is fine):

```ts
  { href: "/people", label: "People", enabled: true },
```

- [ ] **Step 2: Write the page**

```tsx
// app/(dashboard)/people/page.tsx
"use client";

import { useEffect, useState } from "react";
import type { PersonView } from "@/lib/who";

function currentKyivMonthKey(): string {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return ymd.slice(0, 7);
}

export default function PeoplePage() {
  const [people, setPeople] = useState<string[]>([]);
  const [person, setPerson] = useState<string>("");
  const [period, setPeriod] = useState<string>(currentKyivMonthKey());
  const [view, setView] = useState<PersonView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/who?people=1")
      .then((r) => r.json())
      .then((d: { people: string[] }) => {
        setPeople(d.people);
        if (d.people.length && !person) setPerson(d.people[0]);
      })
      .catch(() => setError("Failed to load people."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!person) return;
    setError(null);
    setView(null);
    fetch(`/api/who?person=${encodeURIComponent(person)}&period=${encodeURIComponent(period)}`)
      .then(async (r) => {
        if (!r.ok) { setError((await r.json()).error ?? `HTTP ${r.status}`); return; }
        setView(await r.json());
      })
      .catch(() => setError("Failed to load view."));
  }, [person, period]);

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">People</h1>
      <div className="flex gap-3 items-center">
        <select className="border rounded px-2 py-1" value={person} onChange={(e) => setPerson(e.target.value)}>
          {people.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input className="border rounded px-2 py-1" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="YYYY-MM" />
      </div>

      {error && <p className="text-red-600">{error}</p>}

      {view && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <section className="md:col-span-2">
            <h2 className="font-medium mb-2">Timeline</h2>
            <ul className="space-y-1 text-sm">
              {view.timeline.length === 0 && <li className="text-gray-500">No messages.</li>}
              {view.timeline.map((t) => (
                <li key={t.ts} className="flex gap-2">
                  <span className="text-gray-500 tabular-nums">{t.isoTime.slice(0, 16).replace("T", " ")}</span>
                  <a className="text-blue-600 shrink-0" href={t.permalink} target="_blank" rel="noreferrer">#{t.channel}</a>
                  <span>{t.text}</span>
                </li>
              ))}
            </ul>
          </section>

          <aside className="space-y-3">
            <h2 className="font-medium">Summary</h2>
            {view.summary.jira && (
              <div className="border rounded p-3 text-sm">
                <div className="font-medium">Jira</div>
                <div>{view.summary.jira.count} issues · {view.summary.jira.points} pts</div>
                <div className="text-gray-500 break-words">{view.summary.jira.issueKeys.join(", ")}</div>
              </div>
            )}
            {view.summary.github && (
              <div className="border rounded p-3 text-sm">
                <div className="font-medium">GitHub</div>
                <div>{view.summary.github.commits} commits · +{view.summary.github.additions} −{view.summary.github.deletions}</div>
                <div>{view.summary.github.prsOpened} PRs opened · {view.summary.github.prsMerged} merged</div>
              </div>
            )}
            {view.summary.field && (
              <div className="border rounded p-3 text-sm">
                <div className="font-medium">Field</div>
                <div>{view.summary.field.trips} trips · {view.summary.field.flightDays} days · {view.summary.field.flightMinutes} min</div>
                <div>₴{view.summary.field.netUah}</div>
              </div>
            )}
            {!view.summary.jira && !view.summary.github && !view.summary.field && (
              <p className="text-gray-500 text-sm">No committed summaries for this period.</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build to type-check the page + route together**

Run: `npm run build`
Expected: build succeeds (no type errors in the new route/page). If `next` complains about importing `PersonView` types into a client component, the type is import-only (erased at build) so it is safe; if a lint rule flags it, switch to `import type`.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no errors in the new files.

- [ ] **Step 5: Commit**

```bash
git add "app/(dashboard)/people/page.tsx" "app/(dashboard)/layout.tsx"
git commit -m "feat(who): People dashboard tab (timeline + summary cards)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `people:scaffold` — assisted registry seeding (live directories → reviewed proposals)

**Files:**
- Create: `lib/peopleScaffold.ts` (pure matching)
- Create: `lib/peopleScaffold.test.ts`
- Create: `scripts/people.ts` (thin live shell)
- Modify: `package.json` (add `"people:scaffold"`)

**Interfaces:**
- Consumes: `Person` from `@/lib/people`; roster `SEED_ALIASES` from `@/lib/fieldRoster`.
- Produces:
  - `interface Candidate { source: "slack" | "jira" | "github" | "roster"; externalId: string; displayName: string }`
  - `interface Proposal { name: string; matches: Candidate[]; confidence: "name" }`
  - `proposeMatches(candidates: Candidate[]): Proposal[]` — groups candidates whose `displayName` matches case-insensitively across sources into one proposal.
  - `formatProposals(proposals: Proposal[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// lib/peopleScaffold.test.ts
import { describe, it, expect } from "vitest";
import { proposeMatches, formatProposals, type Candidate } from "./peopleScaffold";

describe("proposeMatches", () => {
  it("groups candidates across sources by case-insensitive display name", () => {
    const cands: Candidate[] = [
      { source: "slack", externalId: "U2", displayName: "Bohdan Forostianyi" },
      { source: "github", externalId: "bohdanf", displayName: "bohdan forostianyi" },
      { source: "jira", externalId: "acc-x", displayName: "Someone Else" },
    ];
    const props = proposeMatches(cands);
    const bohdan = props.find((p) => p.name.toLowerCase() === "bohdan forostianyi")!;
    expect(bohdan.matches.map((m) => m.source).sort()).toEqual(["github", "slack"]);
    expect(bohdan.confidence).toBe("name");
    expect(props.some((p) => p.name === "Someone Else")).toBe(true);
  });
});

describe("formatProposals", () => {
  it("renders a reviewable block per proposal with the warning", () => {
    const out = formatProposals([
      { name: "Bohdan Forostianyi", confidence: "name", matches: [
        { source: "slack", externalId: "U2", displayName: "Bohdan Forostianyi" },
        { source: "github", externalId: "bohdanf", displayName: "Bohdan Forostianyi" },
      ] },
    ]);
    expect(out).toContain("Bohdan Forostianyi");
    expect(out).toContain("slack U2");
    expect(out).toContain("github bohdanf");
    expect(out.toLowerCase()).toContain("review");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/peopleScaffold.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/peopleScaffold.ts
/**
 * Pure matching for `npm run people:scaffold`. Groups external identities from
 * live Slack / committed Jira+GitHub / roster by case-insensitive display name
 * into reviewable proposals. This ONLY proposes — a human pastes confirmed
 * entries into lib/people.ts. Name matching is the silent mis-join risk the
 * registry exists to prevent, so every proposal is flagged for review.
 */
export interface Candidate { source: "slack" | "jira" | "github" | "roster"; externalId: string; displayName: string }
export interface Proposal { name: string; matches: Candidate[]; confidence: "name" }

export function proposeMatches(candidates: Candidate[]): Proposal[] {
  const byName = new Map<string, { display: string; matches: Candidate[] }>();
  for (const c of candidates) {
    const key = c.displayName.trim().toLowerCase();
    if (!key) continue;
    const entry = byName.get(key) ?? { display: c.displayName.trim(), matches: [] };
    entry.matches.push(c);
    byName.set(key, entry);
  }
  return [...byName.values()].map((e) => ({ name: e.display, matches: e.matches, confidence: "name" as const }));
}

export function formatProposals(proposals: Proposal[]): string {
  const lines = ["people:scaffold proposals — ⚠ review before pasting into lib/people.ts (name match may mis-join):", ""];
  for (const p of proposals) {
    lines.push(`${p.name}  (confidence: ${p.confidence})`);
    for (const m of p.matches) lines.push(`  ${m.source} ${m.externalId}`);
    lines.push("");
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/peopleScaffold.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the live shell `scripts/people.ts`**

```ts
// scripts/people.ts
/**
 * CLI: propose people-registry entries by reconciling live Slack users.list with
 * committed Jira/GitHub reports and the roster. PRINTS proposals only — never
 * writes lib/people.ts (a human reviews and pastes). Read the warning in output.
 *
 * Usage: npm run people:scaffold -- [--period YYYY-MM]
 * Runs under --conditions=react-server (lib/slack imports server-only).
 */
import { listUsers } from "../lib/slack";
import { readReportJson } from "../lib/reports";
import { SEED_ALIASES } from "../lib/fieldRoster";
import { proposeMatches, formatProposals, type Candidate } from "../lib/peopleScaffold";

function currentKyivMonthKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).slice(0, 7);
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }
  const periodArg = process.argv.indexOf("--period");
  const key = periodArg >= 0 ? process.argv[periodArg + 1] : currentKyivMonthKey();

  const candidates: Candidate[] = [];

  // Slack directory (live).
  const users = await listUsers(); // [{ id, name }]
  for (const u of users) candidates.push({ source: "slack", externalId: u.id, displayName: u.name });

  // Committed Jira rows.
  const jira = await readReportJson<{ rows: { accountId: string | null; displayName: string }[] }>("jira", key);
  for (const r of jira?.rows ?? []) if (r.accountId) candidates.push({ source: "jira", externalId: r.accountId, displayName: r.displayName });

  // Committed GitHub contributors.
  const gh = await readReportJson<{ contributors: { login: string; displayName: string }[] }>("github", key);
  for (const c of gh?.contributors ?? []) candidates.push({ source: "github", externalId: c.login, displayName: c.displayName });

  // Roster seed initials.
  for (const [initial, name] of Object.entries(SEED_ALIASES)) candidates.push({ source: "roster", externalId: initial, displayName: name });

  console.log(formatProposals(proposeMatches(candidates)));
}

main().catch((err) => { console.error(err); process.exit(1); });
```

> **Pre-implementation check:** confirm `lib/slack.ts` exports a `listUsers()` (or equivalent `users.list` wrapper) returning `{ id, name }[]`. If the export name differs, adapt the import; if no such helper exists, add a thin one in `lib/slack.ts` mirroring its existing `chat.write` call style (a `users.list` GET with the bot token). Do not invent a token path — reuse `lib/slack.ts`'s existing auth.

- [ ] **Step 6: Add the npm script + smoke-run**

In `package.json` `scripts`:

```json
"people:scaffold": "node --conditions=react-server --import tsx scripts/people.ts",
```

Run: `npm run people:scaffold` (needs Slack bot token in env)
Expected: prints the `⚠ review` proposals block. (Without a token it errors on `listUsers` — acceptable; the pure matching is covered by tests.)

- [ ] **Step 7: Commit**

```bash
git add lib/peopleScaffold.ts lib/peopleScaffold.test.ts scripts/people.ts package.json
git commit -m "feat(who): people:scaffold — assisted registry seeding (proposals only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Docs — CLAUDE.md command + `.claude/skills/who/`

**Files:**
- Modify: `CLAUDE.md` (Commands section)
- Create: `.claude/skills/who/SKILL.md`

**Interfaces:** documentation only.

- [ ] **Step 1: Add the CLAUDE.md command entry**

In `CLAUDE.md`, in the `## Commands` list (after the `field-bonus` entry), add:

```markdown
- `npm run who -- --person <query> --start YYYY-MM-DD --end YYYY-MM-DD [--format table] [--unlinked]` — person-centric activity view: a Slack-spine timeline of one person's messages (all tracked channels, from the mirror) plus their Jira / GitHub / field-bonus period summaries. **Read-only** (Slack mirror DB + committed reports; no live fetch, no `--write`). `--person` resolves against the hardcoded `lib/people.ts` registry (ambiguous/unknown → error listing candidates); `--unlinked` lists Slack/Jira/GitHub/roster identities in the data claimed by no person. Defaults to the current Kyiv month. Backs the **People** web tab (`GET /api/who`). Seed the registry with `npm run people:scaffold` (proposals only — a human pastes reviewed entries into `lib/people.ts`). (See `.claude/skills/who/` and `docs/superpowers/specs/2026-06-30-who-person-activity-view-design.md`.)
```

- [ ] **Step 2: Write the skill**

```markdown
<!-- .claude/skills/who/SKILL.md -->
---
name: who
description: Use when asked what a specific person has been doing or saying for a period — assembles their Slack timeline plus Jira/GitHub/field-bonus summaries from the local mirror + committed reports.
---

# who — person-centric activity view

Answer "what has <person> been doing/saying this period?" in one command.

## Run it

```
npm run who -- --person <query> --start YYYY-MM-DD --end YYYY-MM-DD [--format table]
```

- `--person` matches a name in `lib/people.ts` (exact, then unique substring). Ambiguous or unknown queries print the candidates — pick a more specific query.
- Omit `--start`/`--end` for the current Kyiv month.
- `--format table` for a human view; default is JSON (same shape as `GET /api/who`).
- `--unlinked` lists identities present in the data but registered to no person — the to-do list for `lib/people.ts`.

## What it reads (all local, no live fetch)

- Slack timeline: the mirror DB (`schema.slackMessages`), filtered to the person's `slackId` across all tracked channels.
- Jira / GitHub / field summaries: the committed `jira` / `github` / `field-bonus` reports for the period. A summary block appears only when the person carries that identity AND the report is committed. Run the relevant `npm run <feature> -- --write` first if a block is missing.

## Identity

`lib/people.ts` is the hardcoded registry joining a human across Slack id / Jira account / GitHub login / roster initial. To add someone, run `npm run people:scaffold` (it proposes matches from live Slack + committed reports + roster) and paste the **reviewed** entry into `lib/people.ts` — name matches can mis-join, so a human confirms.
```

- [ ] **Step 3: Verify the full suite + commit**

Run: `npm test`
Expected: the whole Vitest suite passes (including `people`, `who`, `whoReport`, `peopleScaffold`).

```bash
git add CLAUDE.md .claude/skills/who/SKILL.md
git commit -m "docs(who): CLAUDE.md command + who skill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §1 purpose / Slack-spine + summaries / committed-only / Kyiv default → Tasks 2, 4, 5, Global Constraints. ✓
- §2 identity registry (`lib/people.ts`, pure resolvers) → Task 1. ✓
- §2 scaffold (live → reviewed proposals, never writes the registry) → Task 7. ✓
- §2 `--unlinked` hygiene → Task 2 (`findUnlinked`) + Tasks 3/4 (render/CLI). ✓
- §3 pure `lib/who.ts`, `PersonView`, identity→source matching table, field-from-bonus-by-roster-name → Task 2. ✓
- §4 CLI `npm run who` (JSON/table, ambiguous/unknown, `--unlinked`, no `--write`) → Tasks 3, 4. ✓
- §5 web: nav tab + `GET /api/who` (`?people=1`, `?person=&period=`, committed-only) + page → Tasks 5, 6. ✓
- §6 testing (people, who, scaffold pure tests; thin shells untested) → Tasks 1, 2, 3, 7. ✓
- §7 files touched → covered across Tasks 1–8. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The one flagged unknown — `lib/slack.ts`'s `users.list` helper name — is called out explicitly in Task 7 Step 5 as a pre-implementation check with a concrete fallback, not a silent placeholder. ✓

**Type consistency:** `WhoSources` shape is defined once in Task 2 and consumed verbatim by Tasks 4 and 5 (`readReportJson<WhoSources["jira"]>` etc.). `PersonView` / `TimelineEntry` / summary block field names (`netUah`, `flightMinutes`, `prsMerged`, `issueKeys`/`count`/`points`) are identical across Tasks 2, 3, 5, 6. `personByQuery`'s `{ person } | { ambiguous } | { unknown }` union is handled the same way in Tasks 4 and 5. ✓
