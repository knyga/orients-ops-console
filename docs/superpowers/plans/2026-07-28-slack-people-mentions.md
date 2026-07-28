# Slack People @mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every bot message posted to Slack that names a known person renders that person as a `<@SLACK_ID>` mention (so Slack pings them), resolved deterministically from the curated `lib/people.ts` registry.

**Architecture:** One new pure module `lib/mention.ts` builds a name→slackId index from `PEOPLE` (canonical name + aliases + roster first-name via `resolveInitial`), drops ambiguous keys, and exposes `mentionize(name)`, `mention(person)`, `dementionText(text)`. Every Slack-post render site calls it. Web/CSV/report surfaces never do — the drone helper gains a gated `mention` flag (default off) because it is shared with the web page and CSV.

**Tech Stack:** TypeScript (strict), Vitest, Next.js 16. Pure `lib/` modules stay free of `server-only`/`node:*` imports.

## Global Constraints

- Import alias `@/*` maps to the repo root; inside `lib/` use relative imports (`./people`) to match neighbors.
- `lib/mention.ts` MUST be pure: imports only `./people` and `./fieldRoster`. No `server-only`, no `node:*`, no React/Next — it is consumed by CLI, server, and (transitively) client-bundle code.
- Mentions appear ONLY in text posted to Slack. Web pages, CSV artifacts, and report JSON must keep plain names.
- Ambiguous name (resolves to 2+ people) or a person with no `slackId` → render the plain name unchanged, never a guessed mention.
- Unresolved person-like name → plain name + a single `console.warn` (best-effort telemetry; never throw, never block a post).
- Run the full suite with `npm test` after each task; run a single file with `npx vitest run <path>`.
- Commit after each task. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Core `lib/mention.ts` + registry helper

**Files:**
- Create: `lib/mention.ts`
- Create: `lib/mention.test.ts`
- Modify: `lib/people.ts` (add `personForJiraAccountId`)

**Interfaces:**
- Consumes: `PEOPLE`, `Person`, `resolveInitial`, `SEED_ALIASES`.
- Produces:
  - `mentionize(name: string): string` — `<@ID>` or plain `name`.
  - `mention(person: Person): string` — `<@ID>` when `slackId` set, else `person.name`.
  - `dementionText(text: string): string` — rewrite `<@ID>` → canonical name (unknown id left intact).
  - `personForJiraAccountId(accountId: string, people?: Person[]): Person | undefined` (in `people.ts`).

- [ ] **Step 1: Add the Jira-accountId lookup to `lib/people.ts`**

Append next to the other `personFor*` helpers at the end of `lib/people.ts`:

```ts
export function personForJiraAccountId(id: string, people: Person[] = PEOPLE): Person | undefined {
  return people.find((p) => p.jiraAccountId === id);
}
```

- [ ] **Step 2: Write the failing test `lib/mention.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { mentionize, mention, dementionText } from "./mention";
import { PEOPLE } from "./people";

const taras = PEOPLE.find((p) => p.name === "Taras Panasyuk")!; // slackId U09LT4HM9PY, rosterInitial "Т"
const serhiy = PEOPLE.find((p) => p.name === "Serhiy Shainyuk")!; // slackId, rosterInitial "Сер"
const noSlack = PEOPLE.find((p) => p.name === "Andrii Svidnytskyi")!; // has slackId though

describe("mentionize", () => {
  it("resolves the roster first-name form", () => {
    expect(mentionize("Тарас")).toBe(`<@${taras.slackId}>`);
  });
  it("resolves the canonical name form", () => {
    expect(mentionize("Taras Panasyuk")).toBe(`<@${taras.slackId}>`);
  });
  it("resolves an alias form", () => {
    expect(mentionize("Влад")).toBe("<@U09UA5J6CHH>");
  });
  it("resolves the 'Сер' prefix roster name", () => {
    expect(mentionize("Сергій")).toBe(`<@${serhiy.slackId}>`);
  });
  it("is case- and whitespace-insensitive", () => {
    expect(mentionize("  тарас ")).toBe(`<@${taras.slackId}>`);
  });
  it("leaves an unknown person-like name plain and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(mentionize("Незнайомець")).toBe("Незнайомець");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
  it("leaves a drone category plain without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(mentionize("15ка")).toBe("15ка");
    expect(mentionize("інші")).toBe("інші");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("mention", () => {
  it("mentions a person with a slackId", () => {
    expect(mention(taras)).toBe(`<@${taras.slackId}>`);
  });
  it("falls back to the name when no slackId", () => {
    expect(mention({ name: "Nobody", role: "x" })).toBe("Nobody");
  });
});

describe("dementionText", () => {
  it("rewrites a known id back to the canonical name", () => {
    expect(dementionText(`👥 У полі: <@${taras.slackId}>, <@${serhiy.slackId}>.`))
      .toBe("👥 У полі: Taras Panasyuk, Serhiy Shainyuk.");
  });
  it("leaves an unknown id token intact", () => {
    expect(dementionText("<@U000UNKNOWN>")).toBe("<@U000UNKNOWN>");
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `npx vitest run lib/mention.test.ts`
Expected: FAIL — `Cannot find module './mention'`.

- [ ] **Step 4: Implement `lib/mention.ts`**

```ts
/**
 * Resolve a person NAME (or a Person) to a Slack `<@ID>` mention for text the bot
 * POSTS TO SLACK, so people get pinged. Pure — a deterministic function of the
 * curated lib/people.ts registry; no live Slack fetch. Never guesses: an
 * ambiguous name (2+ people) or a person without a slackId renders the plain
 * name. Web/CSV/report surfaces must NOT use this — they keep plain names.
 */
import { PEOPLE, type Person } from "./people";
import { resolveInitial } from "./fieldRoster";

/** Category-ish tokens that legitimately are not people — never warn on these. */
function isLikelyPersonName(token: string): boolean {
  const t = token.trim();
  if (t.length < 2) return false;
  if (/\d/.test(t)) return false; // "15ка", counts, dates
  if (t.toLowerCase() === "інші") return false;
  return /\p{L}/u.test(t);
}

/** lower-cased name key → slackId, ambiguous keys dropped. Built once. */
const NAME_TO_ID: Map<string, string> = (() => {
  const seen = new Map<string, Set<string>>();
  const add = (key: string, id: string) => {
    const k = key.trim().toLowerCase();
    if (!k) return;
    (seen.get(k) ?? seen.set(k, new Set()).get(k)!).add(id);
  };
  for (const p of PEOPLE) {
    if (!p.slackId) continue;
    add(p.name, p.slackId);
    for (const a of p.aliases ?? []) add(a, p.slackId);
    if (p.rosterInitial) {
      const r = resolveInitial(p.rosterInitial);
      if ("name" in r) add(r.name, p.slackId);
    }
  }
  const out = new Map<string, string>();
  for (const [k, ids] of seen) if (ids.size === 1) out.set(k, [...ids][0]);
  return out;
})();

/** slackId → canonical display name, for dementionText. */
const ID_TO_NAME: Map<string, string> = new Map(
  PEOPLE.filter((p) => p.slackId).map((p) => [p.slackId!, p.name]),
);

/** "<@ID>" if `name` resolves to exactly one person with a slackId; else the
 *  plain name (with a warn for an unresolved person-like name). */
export function mentionize(name: string): string {
  const id = NAME_TO_ID.get(name.trim().toLowerCase());
  if (id) return `<@${id}>`;
  if (isLikelyPersonName(name)) {
    console.warn(`[mention] no unique Slack id for "${name.trim()}" — add an alias/slackId to lib/people.ts`);
  }
  return name;
}

/** "<@ID>" when the Person has a slackId, else the person's name. */
export function mention(person: Person): string {
  return person.slackId ? `<@${person.slackId}>` : person.name;
}

/** Rewrite every "<@ID>" token back to the person's canonical name (unknown id
 *  tokens left intact). For parse/display surfaces that must stay name-based. */
export function dementionText(text: string): string {
  return text.replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (whole, id) => ID_TO_NAME.get(id) ?? whole);
}
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `npx vitest run lib/mention.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add lib/mention.ts lib/mention.test.ts lib/people.ts
git commit -m "feat(mention): pure name→<@id> resolver from people registry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Verdict crew line (`👥 У полі:`) + de-mention on parse

**Files:**
- Modify: `lib/verdictPublish.ts` (`withRosterSuffix`, `parseRosterSuffix`)
- Test: `lib/verdictPublish.test.ts` (update crew assertions)

**Interfaces:**
- Consumes: `mentionize`, `dementionText` from `./mention`.
- Produces: `withRosterSuffix` now emits `<@ID>` for resolvable crew; `parseRosterSuffix` returns human names (de-mentioned).

`withRosterSuffix` is Slack-post-only (verified: no `app/` caller), so mentionizing inline is web-safe.

- [ ] **Step 1: Update the crew assertions in `lib/verdictPublish.test.ts`**

At the top of the file add:

```ts
import { mentionize } from "./mention";
```

Replace each hardcoded crew expectation so it is built from the resolver (registry-driven, stays correct if ids change):

- Line ~77 and ~94: `expect(msg).toContain(`👥 У полі: ${mentionize("Андріан")}, ${mentionize("Сергій")}.`);`
- Line ~239: `expect(msg).toContain(`\n👥 У полі: ${mentionize("Влад")}, ${mentionize("Тарас")}.`);`
- Line ~269 and ~287: `expect(rosterLine).toBe(`👥 У полі: ${mentionize("Влад")}, ${mentionize("Тарас")}.`);`
- Line ~303: `expect(msg).toContain(`👥 У полі: ${mentionize("Влад")}, ${mentionize("Любомир")}.`);`

Leave the drone-line assertions (Task 3) and the `445` ordering assertion (`👥 У полі:` substring — still present) unchanged.

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run lib/verdictPublish.test.ts`
Expected: FAIL — actual still shows plain `Андріан` etc. while expected now shows `<@…>`.

- [ ] **Step 3: Mentionize in `withRosterSuffix`; de-mention in `parseRosterSuffix`**

Add the import near the top of `lib/verdictPublish.ts`:

```ts
import { mentionize, dementionText } from "./mention";
```

Change `withRosterSuffix` to mentionize each crew name:

```ts
export function withRosterSuffix(body: string, roster: string[]): string {
  if (roster.length === 0) return body;
  return `${body}\n${ROSTER_MARKER}${roster.map(mentionize).join(", ")}.`;
}
```

Change `parseRosterSuffix` so it returns human names even when the stored suffix holds mentions — de-mention the line before splitting:

```ts
export function parseRosterSuffix(text: string): string[] {
  const { rosterLine } = splitRosterSuffix(text);
  if (!rosterLine) return [];
  return dementionText(rosterLine)
    .slice(ROSTER_MARKER.length)
    .replace(/\.\s*$/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run lib/verdictPublish.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/verdictPublish.ts lib/verdictPublish.test.ts
git commit -m "feat(mention): @mention crew in verdict 👥 line; de-mention on parse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Drone line (`🛸 Дрони:`) — gated mention flag

**Files:**
- Modify: `lib/droneReport.ts` (`droneTerms`, `formatDroneLine`)
- Modify: `lib/verdictPublish.ts` (`withDroneLine`, `withDroneRegion` pass `mention: true`)
- Test: `lib/droneReport.test.ts`, `lib/verdictPublish.test.ts` (drone assertions)

**Interfaces:**
- Consumes: `mentionize` from `./mention`.
- Produces: `formatDroneLine(entries, opts?: { mention?: boolean })` — mentions person terms only when `opts.mention === true`. `formatDroneCsv` and the web page keep the default (`false`, plain names).

The mention flag is REQUIRED here because `formatDroneLine` is also called by the web page (`app/(dashboard)/field-verdict/page.tsx`) and `formatDroneCsv` shares `droneTerms` — both must stay plain.

- [ ] **Step 1: Update drone assertions**

In `lib/droneReport.test.ts`, the existing tests call `formatDroneLine(entries)` with no options → they must stay plain (no mention). Leave them unchanged (they assert plain names, which is now the default). Add one new test:

```ts
import { mentionize } from "../lib/mention"; // adjust to "./mention" per file location

it("mentions person entries when opts.mention is set", () => {
  const line = formatDroneLine([E("Андріан", true, 2)], { mention: true });
  expect(line).toBe(`🛸 Дрони: ${mentionize("Андріан")} 2 (усього 2)`);
});
```

(Use the file's existing `E(...)` helper. Import path is `./mention` since `droneReport.test.ts` sits in `lib/`.)

In `lib/verdictPublish.test.ts`, the drone line now goes through the Slack render path, so it MUST be mentioned. Update:
- Line ~240 and ~260: `expect(msg).toContain(`\n🛸 Дрони: ${mentionize("Андріан")} 2, інші 8 (усього 10)`);` (line ~260 without the leading `\n`).
- Line ~270: `expect(droneLine).toBe(`🛸 Дрони: ${mentionize("Андріан")} 2, інші 8 (усього 10)`);`
- Lines ~248, ~255 (`звіт не подано.`) unchanged — no names.

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run lib/droneReport.test.ts lib/verdictPublish.test.ts`
Expected: FAIL — new drone test + updated verdict drone assertions see plain names.

- [ ] **Step 3: Thread the mention flag through `droneReport.ts`**

Add the import at the top of `lib/droneReport.ts`:

```ts
import { mentionize } from "./mention";
```

Change `droneTerms` and `formatDroneLine` (leave `formatDroneCsv` as-is, calling `droneTerms` with the default):

```ts
/** Ordered "<name> <count>" people terms + an optional folded "інші <n>" term.
 *  When `mention` is true, person names render as Slack `<@id>` mentions. */
function droneTerms(merged: DroneEntry[], mention = false): string[] {
  const { otherTotal } = droneTotals(merged);
  const terms = merged
    .filter((e) => e.isPerson)
    .map((e) => `${mention ? mentionize(e.name) : e.name} ${e.count}`);
  if (otherTotal > 0) terms.push(`інші ${otherTotal}`);
  return terms;
}

export function formatDroneLine(
  entries: DroneEntry[],
  opts: { mention?: boolean } = {},
): string | null {
  const merged = mergeDroneEntries(entries).filter((e) => e.count > 0);
  if (merged.length === 0) return null;
  return `🛸 Дрони: ${droneTerms(merged, opts.mention).join(", ")} (усього ${droneTotals(merged).grandTotal})`;
}
```

- [ ] **Step 4: Pass `mention: true` from the Slack render path in `lib/verdictPublish.ts`**

```ts
export function withDroneLine(text: string, entries: DroneEntry[] | undefined): string {
  const line = entries ? formatDroneLine(entries, { mention: true }) : null;
  return line ? `${text}\n${line}` : text;
}

export function withDroneRegion(text: string, day: DayVerdict): string {
  const counts = formatDroneLine(day.droneReport ?? [], { mention: true });
  if (counts) return `${text}\n${counts}`;
  if (day.droneReportPresent === false) return `${text}\n${DRONE_MARKER}звіт не подано.`;
  return text;
}
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `npx vitest run lib/droneReport.test.ts lib/verdictPublish.test.ts`
Expected: PASS. Confirm the web page + CSV are untouched (they call `formatDroneLine`/`formatDroneCsv` with the default and stay plain).

- [ ] **Step 6: Commit**

```bash
git add lib/droneReport.ts lib/droneReport.test.ts lib/verdictPublish.ts lib/verdictPublish.test.ts
git commit -m "feat(mention): @mention people in 🛸 drone line (Slack path only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Approver acks (crew ack + override `by`)

**Files:**
- Modify: `lib/applyRosterCorrection.ts` (crew list + not-counted list + `by` in `replyText`)
- Modify: `lib/verdictPublish.ts` (`formatOverride` — mentionize `by`)
- Test: `lib/verdictPublish.test.ts` (formatOverride `by` assertion, if present)

**Interfaces:**
- Consumes: `mentionize` from `./mention`.
- `applyApproval` / `applyInstruction` route the day/dataset axes through `formatOverride` and the crew axis through `applyRosterCorrection`, so mentionizing those two functions covers all ack surfaces. `applyInstructionReply`'s echo is an LLM paraphrase (not a clean name list) — left plain by design.

- [ ] **Step 1: Update the crew ack in `lib/applyRosterCorrection.ts`**

Add the import:

```ts
import { mentionize } from "./mention";
```

Change the ack construction (currently `outcome.roster.join(", ")` and `notCounted.join(", ")`):

```ts
  const notCounted = Object.entries(outcome.eligibility)
    .filter(([, v]) => v === "not_counted")
    .map(([n]) => mentionize(n));
  const tail = notCounted.length ? ` (не рахується: ${notCounted.join(", ")})` : "";
  const replyText = `👥 Зафіксовано склад: ${outcome.roster.map(mentionize).join(", ")}${tail} — ${mentionize(outcome.by)}.`;
```

(The crew-suffix EDIT itself already goes through `withRosterSuffix` from Task 2 — no change needed there.)

- [ ] **Step 2: Mentionize `by` in `formatOverride` (`lib/verdictPublish.ts`)**

```ts
export function formatOverride(
  originalText: string,
  decision: "accepted_exception" | "rejected",
  by: string,
  reason: string,
): OverrideMessages {
  const icon = decision === "accepted_exception" ? "🟡" : "⛔";
  const label = decision === "accepted_exception" ? "прийнято (виняток)" : "відхилено";
  const who = mentionize(by);
  return {
    updatedText: `~${originalText}~\n${icon} Оновлено → ${label}, ${who}: ${reason}`,
    replyText: `${icon} Зафіксовано: ${label}, ${who}. Причина: ${reason}`,
  };
}
```

- [ ] **Step 3: Check for a `formatOverride` test asserting `by`**

Run: `grep -n "formatOverride\|Оновлено →" lib/verdictPublish.test.ts`
If a test asserts the approver name literally (e.g. `"Oleksandr K"`), wrap it: `${mentionize("Oleksandr K")}`. If none exists, add one:

```ts
it("mentions the approver in an override", () => {
  const { replyText } = formatOverride("✅ 2026-06-13 — прийнято (…).", "rejected", "Oleksandr K", "no dataset");
  expect(replyText).toContain(mentionize("Oleksandr K"));
});
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run lib/verdictPublish.test.ts lib/applyRosterCorrection.test.ts`
Expected: PASS (skip the second path if that test file does not exist).

- [ ] **Step 5: Commit**

```bash
git add lib/applyRosterCorrection.ts lib/verdictPublish.ts lib/verdictPublish.test.ts
git commit -m "feat(mention): @mention crew + approver in verdict acks/overrides

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Sprint posts (grouped by assignee)

**Files:**
- Modify: `lib/sprintReport.ts` (`formatCommittedMessage`, `formatCompletedMessage`)
- Test: `lib/sprintReport.test.ts`

**Interfaces:**
- Consumes: `mention` from `./mention`, `personForJiraAccountId` from `./people`.
- Produces: assignee group headers render `*<@ID>*` when the assignee's Jira accountId maps to a person with a slackId; else the plain `*displayName*`.

`sprintReport.ts` is pure; `mention.ts` + `people.ts` are pure, so the import keeps it pure.

- [ ] **Step 1: Add a failing test to `lib/sprintReport.test.ts`**

Use a known person's Jira accountId (Volodymyr Pavliukevych, `712020:2c9fa200-866c-4d8b-b00a-bd7d434220b0`, slackId `U09526J29AL`):

```ts
import { mention } from "./mention";
import { personForJiraAccountId } from "./people";

it("mentions a known assignee in the committed message", () => {
  const acc = "712020:2c9fa200-866c-4d8b-b00a-bd7d434220b0";
  const snapshot = {
    sprintName: "ATP 42",
    issues: [{ key: "ATP-1", summary: "x", status: "Done", statusCategory: "Done",
               assignee: { accountId: acc, displayName: "Volodymyr Pavliukevych" } }],
  } as any; // shape per SprintSnapshot in this file
  const msg = formatCommittedMessage(snapshot);
  expect(msg).toContain(`*${mention(personForJiraAccountId(acc)!)}*`);
});
```

(Match `SprintSnapshot`/`SprintIssue` field names exactly as declared at the top of `lib/sprintReport.ts`; adjust the literal if the real shape differs.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run lib/sprintReport.test.ts`
Expected: FAIL — header still `*Volodymyr Pavliukevych*`.

- [ ] **Step 3: Resolve the mention in both formatters**

Add near the top of `lib/sprintReport.ts`:

```ts
import { mention } from "./mention";
import { personForJiraAccountId } from "./people";

/** Bold Slack label for an assignee group: a mention when the Jira accountId
 *  maps to a person with a slackId, else the plain display name. */
function assigneeLabel(group: { accountId: string | null; displayName: string }): string {
  const p = group.accountId ? personForJiraAccountId(group.accountId) : undefined;
  return p ? mention(p) : group.displayName;
}
```

Replace both `` `*${group.displayName}*` `` header lines (in `formatCommittedMessage` ~line 163 and `formatCompletedMessage` ~line 197) with:

```ts
    lines.push(`*${assigneeLabel(group)}*`);
```

Leave the unassigned bucket alone — its `accountId` is `null`, so `assigneeLabel` returns the Ukrainian `UNASSIGNED_LABEL` unchanged.

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run lib/sprintReport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sprintReport.ts lib/sprintReport.test.ts
git commit -m "feat(mention): @mention assignees in sprint commit/report posts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Bonus thread breakdown

**Files:**
- Modify: `lib/bonusNotify.ts` (`formatThreadBreakdown`)
- Test: `lib/bonusNotify.test.ts`

**Interfaces:**
- Consumes: `mentionize` from `./mention`.
- Produces: the per-report thread breakdown lists each person as `<@ID>`. The per-person DM (`formatDm`) already targets a `slackId` recipient and names only "Твій" — left unchanged.

- [ ] **Step 1: Add a failing test to `lib/bonusNotify.test.ts`**

```ts
import { mentionize } from "./mention";

it("mentions people in the thread breakdown", () => {
  const people = [{ name: "Андріан", base: 700, early: 0, weekend: 0, total: 700 }];
  const msg = formatThreadBreakdown("2026-06-19", people);
  expect(msg).toContain(`• ${mentionize("Андріан")} — 700 грн`);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run lib/bonusNotify.test.ts`
Expected: FAIL — line still `• Андріан — …`.

- [ ] **Step 3: Mentionize the breakdown line in `lib/bonusNotify.ts`**

Add the import:

```ts
import { mentionize } from "./mention";
```

Change the per-person line in `formatThreadBreakdown`:

```ts
  for (const p of people) lines.push(`• ${mentionize(p.name)} — ${p.total} грн (${parts(p)})`);
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run lib/bonusNotify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/bonusNotify.ts lib/bonusNotify.test.ts
git commit -m "feat(mention): @mention people in bonus thread breakdown

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Loss ack `by` (`proposalExecutor`)

**Files:**
- Modify: `lib/proposalExecutor.ts` (loss ack strings)

**Interfaces:**
- Consumes: `mentionize` from `./mention`.

The loss ack (lines ~184–189) embeds the approver `by`. The `by`-less branch (~188) has no name — unchanged.

- [ ] **Step 1: Mentionize `by` in the loss ack**

Add the import at the top of `lib/proposalExecutor.ts`:

```ts
import { mentionize } from "./mention";
```

In the branch that builds the ack with `by` (~line 184), wrap it:

```ts
        const who = mentionize(by);
        const ack = found
          ? `🛸 Зафіксовано: борт знайдено — втрату за ${date} знято — ${who}. Причина: ${note}`
          : `🛸 Зафіксовано: борт за ${date} втрачено (не знайдено) — ${who}. Причина: ${note}`;
```

(Match the exact surrounding variable names — `found`, `date`, `note`, `ack`/whatever the local is — as they appear; only the `by` interpolation changes to `who`.)

- [ ] **Step 2: Verify the build type-checks and full suite passes**

Run: `npm run lint && npm test`
Expected: lint clean; all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/proposalExecutor.ts
git commit -m "feat(mention): @mention approver in drone-loss ack

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Agent prompt nudge (best-effort)

**Files:**
- Modify: `lib/agent/slackAgent.ts` (system prompt)

**Interfaces:** none (prompt text only). Best-effort — not deterministic, not asserted in tests.

- [ ] **Step 1: Locate the agent system prompt**

Run: `grep -n "system\|You are\|Ти\|роль\|prompt" lib/agent/slackAgent.ts | head`
Identify the system-prompt string constant.

- [ ] **Step 2: Append a mention instruction**

Add one sentence to the system prompt (Ukrainian, matching the surrounding tone):

```
Коли згадуєш людину, використовуй Slack-згадку у форматі <@ID> за ростером, а не просто ім'я, щоб людина отримала сповіщення.
```

- [ ] **Step 3: Type-check + full suite**

Run: `npm run lint && npm test`
Expected: lint clean; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/agent/slackAgent.ts
git commit -m "feat(mention): nudge agent to @mention people (best-effort)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Full verification + operational rollout note

**Files:** none (verification only).

- [ ] **Step 1: Full suite + lint + build**

Run: `npm run lint && npm test && npm run build`
Expected: all green. If any test outside this plan asserts a crew/drone/assignee/bonus name literally, update it to the `mentionize`/`mention` form (registry-driven) and re-run.

- [ ] **Step 2: Sanity-check a dry-run verdict render**

Run: `npm run field-verdict -- --format table` (current month) and confirm the printed report JSON/CSV/table still shows plain names (mentions are Slack-post-only, so the report must NOT contain `<@`).
Then eyeball a would-be post: `npm run field-publish` (DRY-RUN, no `--publish`) and confirm the printed message text shows `<@…>` in the `👥`/`🛸` lines for known crew.

- [ ] **Step 3: Record the rollout requirement**

Confirm the README/CLAUDE.md backfill note applies: after this branch merges, an operator must run **once**:

```
npm run field-backfill -- --publish --channel field-qa
```

to rewrite already-published verdicts to mention form in a single controlled pass (editing a Slack message does not re-ping, so no one is re-notified). Do NOT let the nightly do the bulk rewrite. This step is operational (real Slack write) — leave it for the operator, do not run it during implementation.

- [ ] **Step 4: Final commit if any stray test/doc fixes were needed**

```bash
git add -A
git commit -m "test(mention): align remaining name assertions with mention form

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `lib/mention.ts` core (index, `mentionize`/`mention`/`dementionText`, ambiguity drop, warn-on-miss, category skip) → Task 1. ✓
- Roster line → Task 2; drone line → Task 3; acks → Task 4; sprint → Task 5; bonus thread → Task 6; loss/override `by` → Tasks 4 & 7. ✓ (all six spec apply-sites covered)
- Round-trip `dementionText` on `parseRosterSuffix` → Task 2. ✓
- Web/CSV stay plain: drone gated flag → Task 3; verified in Task 9 Step 2. ✓
- Agent nudge → Task 8. ✓
- Operational backfill → Task 9 Step 3. ✓
- `personForJiraAccountId` needed by Task 5 → added in Task 1. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; test steps show real assertions. Approximate line numbers are flagged "~" with a grep to locate exactly.

**Type consistency:** `mentionize(string)→string`, `mention(Person)→string`, `dementionText(string)→string`, `personForJiraAccountId(string)→Person|undefined`, `formatDroneLine(entries, {mention?})→string|null` — used identically across Tasks 1–7.
