# #field-qa Cross-Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every per-day bot message in #field-qa (drone reminder, verdict, bonus breakdown, a new bot reply under the human Звіт, the monthly summary line) carries a trailing `🔗` line linking to the day's other messages, kept current by an idempotent relink stage as new messages appear.

**Architecture:** A pure planner (`lib/dayLinks.ts`) derives the day's node set from stores that already exist (`published`, `bonus_notified`, `outbound_messages`) — no new table — renders one `🔗` link line per target and emits edits only where the line on the message differs. A server-only driver (`lib/relinkDay.ts`) applies them through the `lib/slack.ts` reserve-then-send chokepoint with content-hash keys, so re-runs are free. The stage runs in the nightly and at the tail of every path that creates a node. Existing verdict region editors and the nightly refresh learn to peel / re-append the new trailing region.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Vitest, drizzle (Postgres), Slack Web API (`chat.update`, `chat.postMessage`).

**Spec:** `docs/superpowers/specs/2026-09-04-field-qa-cross-links-design.md`

## Global Constraints

- All team-facing Slack text is **Ukrainian**. Labels are exactly `Звіт`, `Вердикт`, `Дрони`, `Бонуси`, `Підсумок`; separator ` · `; region marker `🔗 ` at the start of the message's **last** line.
- Fixed label order everywhere: `Звіт · Вердикт · Дрони · Бонуси · Підсумок` (absent nodes omitted; a target never links itself; the bonus reply also omits `Вердикт`; the Звіт-thread reply omits `Звіт`).
- Multi-Звіт days: per-Звіт items on **day-level** targets (reminder) carry ordinals `Звіт 1/2 · Звіт 2/2 · Вердикт 1/2 …`, ordered by Звіт ts ascending; single-report days have no ordinal. Per-Звіт targets link only their own report's nodes.
- Every Slack send/edit goes through `postMessage` / `updateMessage` in `lib/slack.ts` with a `SendMeta` key from `lib/outboundKeys.ts`. Never call the Slack API directly.
- Edit keys: `links-edit:<targetKey>:<contentRev(line)>`; Звіт-reply post `links-zvit:<reportTs>`; Звіт-reply edit `links-zvit-edit:<reportTs>:<contentRev(line)>`. `targetKey` ∈ `reminder:<date>`, `verdict:<date>#<reportTs>`, `bonus:<date>#<reportTs>`, `zvit:<reportTs>`.
- Pure `lib/` modules stay free of `server-only`, DB, Slack and `node:fs` imports and are unit-tested. Server-only modules import `"server-only"` first.
- CLIs run under `node --conditions=react-server --import tsx` (see `package.json` scripts) and are **DRY-RUN by default**; `--publish` requires `--channel <name>` naming a `TRACKED_CHANNELS` entry.
- Relink is a **soft** stage: a failure on one target is recorded and the loop continues; it never blocks the caller and never DMs the operator.
- Summary thread chunks are **never edited** after posting.
- Feature must ship both a CLI (`npm run field-links`) and a web surface (`GET /api/field-links` + a panel on the Verdict tab).
- Commit after each task with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.

---

## File map

| File | Responsibility |
|---|---|
| `lib/linksRegion.ts` (new, pure) | `LINKS_MARKER`, `withLinksRegion`, `splitLinksRegion` — the trailing-line region primitive shared by the verdict formatter and the planner. |
| `lib/verdictPublish.ts` (modify) | `splitDroneLine` / `splitRosterSuffix` peel the 🔗 line first and return it as `linksLine`. |
| `lib/applyApproval.ts`, `lib/applyRosterCorrection.ts` (modify) | re-append `linksLine` after rebuilding their region. |
| `lib/outboundKeys.ts` (modify) | `linksTargetKey`, `linksEditKey`, `linksZvitKey`, `linksZvitEditKey`. |
| `lib/outbound.ts` (modify) | `findSentByKey(key)`, `readOutboundByFeature(feature)`. |
| `lib/dayLinks.ts` (new, pure) | `collectDayNodes`, `renderLinks`, `planRelink`, summary-chunk resolution. |
| `lib/relinkDay.ts` (new, server-only) | `relinkDays` driver: read stores → plan → apply via chokepoint → write back `published.text`. |
| `lib/backfillPublished.ts` (modify) | refresh compare ignores the 🔗 region and re-appends it. |
| `lib/fieldMonthSummary.ts`, `lib/fieldSummaryPost.ts` (modify) | summary day line gains `дрони` + `бонуси` links; `postFieldSummary` tail calls relink. |
| `lib/runNightly.ts`, `lib/droneReminder.ts`, `scripts/field-bonus.ts` (modify) | soft-fail relink hooks. |
| `scripts/fieldLinksReport.ts` (new, pure) | CLI arg parsing + table rendering. |
| `scripts/field-links.ts` (new) | the CLI. |
| `app/api/field-links/route.ts` (new) | web twin (read-only). |
| `app/(dashboard)/field-verdict/page.tsx` (modify) | «Зв'язки» panel. |
| `CLAUDE.md` (modify) | command entry. |

---

### Task 1: Links region primitive

**Files:**
- Create: `lib/linksRegion.ts`
- Test: `lib/linksRegion.test.ts`

**Interfaces:**
- Produces:
  - `export const LINKS_MARKER = "🔗 "`
  - `export function withLinksRegion(text: string, line: string | null): string` — replaces or appends the trailing 🔗 line; `null` strips it.
  - `export function splitLinksRegion(text: string): { rest: string; linksLine: string | null }` — peels exactly one trailing 🔗 line.

- [ ] **Step 1: Write the failing test**

```ts
// lib/linksRegion.test.ts
import { describe, expect, it } from "vitest";
import { LINKS_MARKER, splitLinksRegion, withLinksRegion } from "./linksRegion";

const body = "✅ 18.06 — прийнято (…).\n👥 У полі: <@U1>, <@U2>.\n🛸 Дрони: Влад 3; разом 3";
const line = `${LINKS_MARKER}<https://x/p1|Звіт> · <https://x/p2|Дрони>`;

describe("linksRegion", () => {
  it("appends a 🔗 line as the last line", () => {
    expect(withLinksRegion(body, line)).toBe(`${body}\n${line}`);
  });
  it("replaces an existing 🔗 line instead of stacking", () => {
    const other = `${LINKS_MARKER}<https://x/p9|Бонуси>`;
    expect(withLinksRegion(`${body}\n${line}`, other)).toBe(`${body}\n${other}`);
  });
  it("null strips the region and leaves the rest byte-identical", () => {
    expect(withLinksRegion(`${body}\n${line}`, null)).toBe(body);
    expect(withLinksRegion(body, null)).toBe(body);
  });
  it("split peels exactly one trailing 🔗 line", () => {
    expect(splitLinksRegion(`${body}\n${line}`)).toEqual({ rest: body, linksLine: line });
    expect(splitLinksRegion(body)).toEqual({ rest: body, linksLine: null });
  });
  it("split ignores a 🔗 line that is not the last line", () => {
    const text = `${line}\n${body}`;
    expect(splitLinksRegion(text)).toEqual({ rest: text, linksLine: null });
  });
  it("split handles a single-line message that is only a 🔗 line", () => {
    expect(splitLinksRegion(line)).toEqual({ rest: "", linksLine: line });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/linksRegion.test.ts`
Expected: FAIL — `Cannot find module './linksRegion'`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/linksRegion.ts
/**
 * The trailing «🔗 …» cross-link region every per-day #field-qa bot message
 * carries (spec: docs/superpowers/specs/2026-09-04-field-qa-cross-links-design.md).
 * Always the LAST line of a message, disjoint from the verdict's body / 👥 crew /
 * 🛸 drone regions, so each editor can peel it, rebuild its own region, and
 * re-append it unchanged. PURE — no imports; shared by lib/verdictPublish (the
 * region splitters) and lib/dayLinks (the planner).
 */
export const LINKS_MARKER = "🔗 ";

/** Peel exactly one trailing 🔗 line. A 🔗 line anywhere else is left alone. */
export function splitLinksRegion(text: string): { rest: string; linksLine: string | null } {
  const idx = text.lastIndexOf("\n");
  const last = idx === -1 ? text : text.slice(idx + 1);
  if (!last.startsWith(LINKS_MARKER)) return { rest: text, linksLine: null };
  return { rest: idx === -1 ? "" : text.slice(0, idx), linksLine: last };
}

/** Replace/append the trailing 🔗 line; `null` removes it. Idempotent. */
export function withLinksRegion(text: string, line: string | null): string {
  const { rest } = splitLinksRegion(text);
  if (line === null) return rest;
  return rest ? `${rest}\n${line}` : line;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/linksRegion.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/linksRegion.ts lib/linksRegion.test.ts
git commit -m "links: trailing 🔗 region primitive (withLinksRegion / splitLinksRegion)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Verdict region splitters and editors preserve the 🔗 tail

**Files:**
- Modify: `lib/verdictPublish.ts:68-84` (`splitDroneLine`, `splitRosterSuffix`)
- Modify: `lib/applyApproval.ts:71-74`
- Modify: `lib/applyRosterCorrection.ts:49-51`
- Test: `lib/verdictPublish.test.ts`

**Interfaces:**
- Consumes: `splitLinksRegion` from Task 1.
- Produces:
  - `splitDroneLine(text): { rest: string; droneLine: string | null; linksLine: string | null }`
  - `splitRosterSuffix(text): { body: string; rosterLine: string | null; droneLine: string | null; linksLine: string | null }`
  - Both editors re-append `linksLine` as the final line.

- [ ] **Step 1: Write the failing tests**

Append to `lib/verdictPublish.test.ts` (imports at the top already include `splitRosterSuffix`, `withRosterSuffix`, `withDroneLine`; add `splitDroneLine`):

```ts
import { LINKS_MARKER } from "./linksRegion";

describe("region splitters with a trailing 🔗 line", () => {
  const body = "✅ 18.06 — прийнято (у повітрі 18 хв; відео 206 хв — 1144%; датасет ✓).";
  const roster = `${ROSTER_MARKER}<@U1>, <@U2>.`;
  const drone = "🛸 Дрони: Влад 3; разом 3";
  const links = `${LINKS_MARKER}<https://x/p1|Звіт> · <https://x/p2|Дрони>`;
  const full = [body, roster, drone, links].join("\n");

  it("splitDroneLine peels 🔗 first, then the 🛸 line", () => {
    expect(splitDroneLine(full)).toEqual({ rest: `${body}\n${roster}`, droneLine: drone, linksLine: links });
  });
  it("splitDroneLine without 🔗 is unchanged in shape", () => {
    expect(splitDroneLine(`${body}\n${drone}`)).toEqual({ rest: body, droneLine: drone, linksLine: null });
  });
  it("splitRosterSuffix returns all four regions", () => {
    expect(splitRosterSuffix(full)).toEqual({ body, rosterLine: roster, droneLine: drone, linksLine: links });
  });
  it("splitRosterSuffix: 🔗 directly after the crew line (no 🛸)", () => {
    expect(splitRosterSuffix([body, roster, links].join("\n"))).toEqual({ body, rosterLine: roster, droneLine: null, linksLine: links });
  });
  it("parseRosterSuffix reads the same crew with or without a trailing 🔗 line", () => {
    expect(parseRosterSuffix(full)).toEqual(parseRosterSuffix([body, roster, drone].join("\n")));
    expect(parseRosterSuffix(full).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/verdictPublish.test.ts`
Expected: FAIL — `splitDroneLine` result lacks `linksLine`; the 🛸 line is not peeled when 🔗 trails.

- [ ] **Step 3: Update the splitters**

In `lib/verdictPublish.ts` add the import and replace the two functions:

```ts
import { splitLinksRegion } from "./linksRegion";

/** Peel a trailing "\n🔗 …" cross-link line (if any), then a trailing "\n🛸 Дрони: …" line. Pure. */
export function splitDroneLine(text: string): { rest: string; droneLine: string | null; linksLine: string | null } {
  const { rest: noLinks, linksLine } = splitLinksRegion(text);
  const idx = noLinks.lastIndexOf(`\n${DRONE_MARKER}`);
  if (idx === -1) return { rest: noLinks, droneLine: null, linksLine };
  const after = noLinks.slice(idx + 1);
  if (after.includes("\n")) return { rest: noLinks, droneLine: null, linksLine }; // not the trailing line
  return { rest: noLinks.slice(0, idx), droneLine: after, linksLine };
}

/** Split a published message into body + crew suffix + drone line + 🔗 links line.
 *  Regions are disjoint; every editor rebuilds ONE and re-appends the others. Pure. */
export function splitRosterSuffix(text: string): {
  body: string;
  rosterLine: string | null;
  droneLine: string | null;
  linksLine: string | null;
} {
  const { rest, droneLine, linksLine } = splitDroneLine(text);
  const idx = rest.lastIndexOf(`\n${ROSTER_MARKER}`);
  if (idx === -1) return { body: rest, rosterLine: null, droneLine, linksLine };
  return { body: rest.slice(0, idx), rosterLine: rest.slice(idx + 1), droneLine, linksLine };
}
```

- [ ] **Step 4: Re-append the tail in both editors**

`lib/applyApproval.ts` (inside `amendPublishedVerdict`):

```ts
  const { body, rosterLine, droneLine, linksLine } = splitRosterSuffix(entry.text);
  const { updatedText: struck, replyText } = formatOverride(body, decision, by, reason);
  const tail = [rosterLine, droneLine, linksLine].filter(Boolean).join("\n");
  const updatedText = tail ? `${struck}\n${tail}` : struck;
```

`lib/applyRosterCorrection.ts` (inside `applyRosterDecision`):

```ts
  const { body, droneLine, linksLine } = splitRosterSuffix(entry.text);
  const withRoster = withRosterSuffix(body, outcome.roster);
  const updatedText = [withRoster, droneLine, linksLine].filter(Boolean).join("\n");
```

Update the comment above each to say "keep the body, the trailing drone line AND the 🔗 links line intact — each is a disjoint region".

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS. (`lib/applyApproval.test.ts` / roster tests, if present, still pass because texts without a 🔗 line produce `linksLine: null`, which `filter(Boolean)` drops.)

- [ ] **Step 6: Commit**

```bash
git add lib/verdictPublish.ts lib/verdictPublish.test.ts lib/applyApproval.ts lib/applyRosterCorrection.ts
git commit -m "verdict: region splitters peel + editors preserve the trailing 🔗 line

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Outbound keys + DB lookups

**Files:**
- Modify: `lib/outboundKeys.ts` (append after `rosterAckKey`)
- Modify: `lib/outbound.ts` (append after `findSentByTs`)
- Test: `lib/outboundKeys.test.ts` (append)

**Interfaces:**
- Produces:
  - `export type LinksTarget = { kind: "reminder"; date: string } | { kind: "verdict" | "bonus"; date: string; reportTs: string } | { kind: "zvit"; reportTs: string }`
  - `linksTargetKey(t: LinksTarget): string` → `reminder:<date>` / `verdict:<date>#<reportTs>` / `bonus:<date>#<reportTs>` / `zvit:<reportTs>`
  - `linksEditKey(t: LinksTarget, rev: string): string` → `links-edit:<targetKey>:<rev>`
  - `linksZvitKey(reportTs: string): string` → `links-zvit:<reportTs>`
  - `linksZvitEditKey(reportTs: string, rev: string): string` → `links-zvit-edit:<reportTs>:<rev>`
  - `export const LINKS_FEATURE = "links"`
  - `findSentByKey(key: string): Promise<OutboundRow | null>` — the row for a key if `status === "sent"` and `ts` set, else null.
  - `readOutboundByFeature(feature: string): Promise<OutboundRow[]>` — all rows for a feature (uses the `feature` index).

- [ ] **Step 1: Write the failing test**

Append to `lib/outboundKeys.test.ts`:

```ts
import { linksEditKey, linksTargetKey, linksZvitEditKey, linksZvitKey } from "./outboundKeys";

describe("links keys", () => {
  it("target keys are report-exact for per-Звіт targets and date-only for the reminder", () => {
    expect(linksTargetKey({ kind: "reminder", date: "2026-09-03" })).toBe("reminder:2026-09-03");
    expect(linksTargetKey({ kind: "verdict", date: "2026-09-03", reportTs: "1.5" })).toBe("verdict:2026-09-03#1.5");
    expect(linksTargetKey({ kind: "bonus", date: "2026-09-03", reportTs: "1.5" })).toBe("bonus:2026-09-03#1.5");
    expect(linksTargetKey({ kind: "zvit", reportTs: "1.5" })).toBe("zvit:1.5");
  });
  it("edit / post keys are namespaced apart from every other key family", () => {
    expect(linksEditKey({ kind: "reminder", date: "2026-09-03" }, "abc")).toBe("links-edit:reminder:2026-09-03:abc");
    expect(linksZvitKey("1.5")).toBe("links-zvit:1.5");
    expect(linksZvitEditKey("1.5", "abc")).toBe("links-zvit-edit:1.5:abc");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/outboundKeys.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Add the keys**

Append to `lib/outboundKeys.ts`:

```ts
/**
 * Cross-link (🔗) edits — spec 2026-09-04-field-qa-cross-links-design.md. The
 * edit is keyed by the TARGET message + a content hash of the rendered link
 * line, so an unchanged cluster re-derives the same key and dedups at the
 * chokepoint, while a new node (new line) re-edits. The Звіт-thread reply is
 * the one POST (keyed by the Звіт ts, so a day never gets two), edited under
 * its own content-rev key afterwards.
 */
export const LINKS_FEATURE = "links";
export type LinksTarget =
  | { kind: "reminder"; date: string }
  | { kind: "verdict" | "bonus"; date: string; reportTs: string }
  | { kind: "zvit"; reportTs: string };
export const linksTargetKey = (t: LinksTarget): string =>
  t.kind === "reminder" ? `reminder:${t.date}` :
  t.kind === "zvit" ? `zvit:${t.reportTs}` :
  `${t.kind}:${t.date}#${t.reportTs}`;
export const linksEditKey = (t: LinksTarget, rev: string): string => `links-edit:${linksTargetKey(t)}:${rev}`;
export const linksZvitKey = (reportTs: string): string => `links-zvit:${reportTs}`;
export const linksZvitEditKey = (reportTs: string, rev: string): string => `links-zvit-edit:${reportTs}:${rev}`;
```

- [ ] **Step 4: Add the DB lookups**

Append to `lib/outbound.ts` after `findSentByTs`:

```ts
/** The SENT row under `key` (with a ts), or null. Used by the cross-link
 *  planner to find the drone reminder / Звіт-thread reply it posted earlier. */
export async function findSentByKey(key: string): Promise<OutboundRow | null> {
  const [row] = await db.select().from(schema.outboundMessages).where(eq(schema.outboundMessages.key, key)).limit(1);
  return row && row.status === "sent" && row.ts ? row : null;
}

/** Every row of one feature (indexed). Small tables (reminders, summaries). */
export async function readOutboundByFeature(feature: string): Promise<OutboundRow[]> {
  return db.select().from(schema.outboundMessages).where(eq(schema.outboundMessages.feature, feature));
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run lib/outboundKeys.test.ts && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add lib/outboundKeys.ts lib/outboundKeys.test.ts lib/outbound.ts
git commit -m "links: outbound key family + findSentByKey / readOutboundByFeature

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Pure planner — `lib/dayLinks.ts`

**Files:**
- Create: `lib/dayLinks.ts`
- Test: `lib/dayLinks.test.ts`

**Interfaces:**
- Consumes: Task 1 (`withLinksRegion`, `splitLinksRegion`, `LINKS_MARKER`), Task 3 (`LinksTarget`, `linksEditKey`, `linksZvitKey`, `linksZvitEditKey`), `contentRev` from `lib/outboundKeys.ts`, `reportKey` from `lib/fieldDayVerdict.ts`, types `PublishedLog` (`lib/published.ts`), `NotifiedLog` (`lib/bonusNotified.ts`).
- Produces:

```ts
export interface OutboundRowLike { key: string; feature: string; status: string; ts: string | null; text: string; channel: string }
export interface ReportNodes { reportTs: string; verdictTs?: string; verdictText?: string; bonusTs?: string; bonusText?: string; zvitReplyTs?: string; zvitReplyText?: string }
export interface DayNodes { date: string; reminderTs?: string; reminderText?: string; reports: ReportNodes[]; summaryTs?: string }
export interface CollectInput { date: string; channel: string; published: PublishedLog; notified: NotifiedLog; outbound: OutboundRowLike[] }
export function collectDayNodes(input: CollectInput): DayNodes
export function renderLinks(target: LinksTarget, nodes: DayNodes, permalink: (ts: string) => string): string | null
export interface RelinkEdit { target: LinksTarget; op: "edit" | "post"; ts: string | null; threadTs: string | null; newText: string; key: string }
export function planRelink(nodes: DayNodes, opts: { permalink: (ts: string) => string; zvitReply: boolean }): RelinkEdit[]
export function summaryChunkFor(date: string, rows: OutboundRowLike[], channel: string): string | null
```

Notes for the implementer:
- `published` values carry `date`, `reportTs`, `ts`, `text`, `channel`; only entries with `entry.date === date && entry.channel === channel && entry.reportTs` are nodes (a legacy bare-date entry with `reportTs === null` has no Звіт to link — skip it).
- `notified[reportKey(date, reportTs)]?.threadTs` is the bonus reply ts. Its text is not stored in `bonus_notified`; look it up in `outbound` by `key === bonusThreadKey(reportKey(date, reportTs))` (`bonus-thread:<date>#<reportTs>`), `status === "sent"`. If the row is missing, `bonusText` is `""` (treat as "no 🔗 line yet").
- Reminder: `outbound` row with `key === droneReminderKey(date)` (`drone-reminder:<date>`), `status === "sent"`, `channel === channel`.
- Звіт reply: `outbound` row with `key === linksZvitKey(reportTs)`, `status === "sent"`.
- Summary: `summaryChunkFor` — rows with `feature === "field-summary"`, `status === "sent"`, `channel === channel`, key not ending `:anchor`, whose `text` matches `/(^|\n)\*DD\.MM /` for the date. Exactly one distinct `ts` → that ts; otherwise `null`.
- Ordinals appear only when `nodes.reports.length > 1`, formatted ` ${i + 1}/${n}`.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/dayLinks.test.ts
import { describe, expect, it } from "vitest";
import { collectDayNodes, planRelink, renderLinks, summaryChunkFor, type DayNodes, type OutboundRowLike } from "./dayLinks";
import { LINKS_MARKER, withLinksRegion } from "./linksRegion";
import { contentRev } from "./outboundKeys";
import type { PublishedLog } from "./published";
import type { NotifiedLog } from "./bonusNotified";

const url = (ts: string) => `https://w.slack.com/archives/C1/p${ts.replace(".", "")}`;
const row = (o: Partial<OutboundRowLike> & { key: string }): OutboundRowLike => ({
  feature: "x", status: "sent", ts: "9.9", text: "", channel: "field-qa", ...o,
});

const published: PublishedLog = {
  "2026-09-03#100.1": { date: "2026-09-03", reportTs: "100.1", channel: "field-qa", text: "✅ v1", ts: "200.1", postedAt: "" },
  "2026-09-03#100.2": { date: "2026-09-03", reportTs: "100.2", channel: "field-qa", text: "⚠️ v2", ts: "200.2", postedAt: "" },
  "2026-09-02#100.0": { date: "2026-09-02", reportTs: "100.0", channel: "field-qa", text: "✅ other day", ts: "200.0", postedAt: "" },
};
const notified: NotifiedLog = {
  "2026-09-03#100.1": { date: "2026-09-03", reportTs: "100.1", threadTs: "300.1", dms: [] },
};
const outbound: OutboundRowLike[] = [
  row({ key: "drone-reminder:2026-09-03", feature: "drone-reminder", ts: "50.0", text: "🛸 Звіт по дронах за 03.09\n<@U1> — …" }),
  row({ key: "bonus-thread:2026-09-03#100.1", feature: "bonus", ts: "300.1", text: "💰 Бонуси за 2026-09-03 (попередньо): разом 700 грн" }),
  row({ key: "links-zvit:100.2", feature: "links", ts: "400.2", text: `${LINKS_MARKER}<${url("200.2")}|Вердикт>` }),
  row({ key: "field-summary:2026-09:2026-09-30:field-qa:anchor", feature: "field-summary", ts: "500.0", text: "*Польові дні — вересень 2026*" }),
  row({ key: "field-summary:2026-09:2026-09-30:field-qa:t1", feature: "field-summary", ts: "500.1", text: "*02.09 ср* · екіпаж …\n*03.09 чт* · виїзд 1/2 · …\n*03.09 чт* · виїзд 2/2 · …" }),
];

describe("collectDayNodes", () => {
  it("gathers the day's reminder, per-report verdict/bonus/zvit-reply nodes and the summary chunk", () => {
    const n = collectDayNodes({ date: "2026-09-03", channel: "field-qa", published, notified, outbound });
    expect(n.reminderTs).toBe("50.0");
    expect(n.reports.map((r) => r.reportTs)).toEqual(["100.1", "100.2"]); // ordered by Звіт ts
    expect(n.reports[0]).toMatchObject({ verdictTs: "200.1", verdictText: "✅ v1", bonusTs: "300.1", bonusText: expect.stringContaining("Бонуси") });
    expect(n.reports[0].zvitReplyTs).toBeUndefined();
    expect(n.reports[1]).toMatchObject({ verdictTs: "200.2", zvitReplyTs: "400.2" });
    expect(n.reports[1].bonusTs).toBeUndefined();
    expect(n.summaryTs).toBe("500.1");
  });
  it("ignores other days, other channels, and non-sent rows", () => {
    const n = collectDayNodes({
      date: "2026-09-02", channel: "field-qa", published, notified,
      outbound: [row({ key: "drone-reminder:2026-09-02", feature: "drone-reminder", status: "failed", ts: null })],
    });
    expect(n.reminderTs).toBeUndefined();
    expect(n.reports.map((r) => r.reportTs)).toEqual(["100.0"]);
    expect(collectDayNodes({ date: "2026-09-02", channel: "orients-ops-console-test", published, notified, outbound }).reports).toEqual([]);
  });
});

describe("summaryChunkFor", () => {
  const chunks = (texts: string[]) => texts.map((t, i) => row({ key: `field-summary:2026-09:d:field-qa:t${i + 1}`, feature: "field-summary", ts: `500.${i + 1}`, text: t }));
  it("returns the single chunk whose line starts with the day label", () => {
    expect(summaryChunkFor("2026-09-03", chunks(["*02.09 ср* · a", "*03.09 чт* · b"]), "field-qa")).toBe("500.2");
  });
  it("returns null when no chunk or more than one chunk carries the day", () => {
    expect(summaryChunkFor("2026-09-04", chunks(["*02.09 ср* · a"]), "field-qa")).toBeNull();
    expect(summaryChunkFor("2026-09-03", chunks(["*03.09 чт* · виїзд 1/2", "*03.09 чт* · виїзд 2/2"]), "field-qa")).toBeNull();
  });
  it("never matches the anchor or a foreign channel", () => {
    const rows = [row({ key: "field-summary:2026-09:d:field-qa:anchor", feature: "field-summary", ts: "1.0", text: "*03.09 чт*" }),
      row({ key: "field-summary:2026-09:d:t:t1", feature: "field-summary", ts: "1.1", text: "*03.09 чт*", channel: "orients-ops-console-test" })];
    expect(summaryChunkFor("2026-09-03", rows, "field-qa")).toBeNull();
  });
});

describe("renderLinks", () => {
  const nodes: DayNodes = {
    date: "2026-09-03", reminderTs: "50.0", summaryTs: "500.1",
    reports: [
      { reportTs: "100.1", verdictTs: "200.1", bonusTs: "300.1" },
      { reportTs: "100.2", verdictTs: "200.2" },
    ],
  };
  it("reminder (day-level) lists per-report items with ordinals, then the summary", () => {
    expect(renderLinks({ kind: "reminder", date: "2026-09-03" }, nodes, url)).toBe(
      `${LINKS_MARKER}<${url("100.1")}|Звіт 1/2> · <${url("100.2")}|Звіт 2/2> · <${url("200.1")}|Вердикт 1/2> · <${url("200.2")}|Вердикт 2/2> · <${url("300.1")}|Бонуси 1/2> · <${url("500.1")}|Підсумок>`,
    );
  });
  it("verdict links its own Звіт · Дрони · Бонуси · Підсумок, never itself", () => {
    expect(renderLinks({ kind: "verdict", date: "2026-09-03", reportTs: "100.1" }, nodes, url)).toBe(
      `${LINKS_MARKER}<${url("100.1")}|Звіт> · <${url("50.0")}|Дрони> · <${url("300.1")}|Бонуси> · <${url("500.1")}|Підсумок>`,
    );
  });
  it("bonus omits itself AND the verdict it is threaded under", () => {
    expect(renderLinks({ kind: "bonus", date: "2026-09-03", reportTs: "100.1" }, nodes, url)).toBe(
      `${LINKS_MARKER}<${url("100.1")}|Звіт> · <${url("50.0")}|Дрони> · <${url("500.1")}|Підсумок>`,
    );
  });
  it("zvit reply omits the Звіт", () => {
    expect(renderLinks({ kind: "zvit", reportTs: "100.2" }, nodes, url)).toBe(
      `${LINKS_MARKER}<${url("200.2")}|Вердикт> · <${url("50.0")}|Дрони> · <${url("500.1")}|Підсумок>`,
    );
  });
  it("single-report day has no ordinals; nothing to link → null", () => {
    const single: DayNodes = { date: "2026-09-03", reports: [{ reportTs: "100.1", verdictTs: "200.1" }] };
    expect(renderLinks({ kind: "reminder", date: "2026-09-03" }, single, url)).toBe(
      `${LINKS_MARKER}<${url("100.1")}|Звіт> · <${url("200.1")}|Вердикт>`,
    );
    expect(renderLinks({ kind: "verdict", date: "2026-09-03", reportTs: "100.1" }, single, url)).toBe(`${LINKS_MARKER}<${url("100.1")}|Звіт>`);
    expect(renderLinks({ kind: "zvit", reportTs: "100.1" }, { date: "2026-09-03", reports: [{ reportTs: "100.1" }] }, url)).toBeNull();
  });
});

describe("planRelink", () => {
  const base: DayNodes = {
    date: "2026-09-03", reminderTs: "50.0", reminderText: "🛸 Звіт по дронах за 03.09\n<@U1> — …",
    reports: [{ reportTs: "100.1", verdictTs: "200.1", verdictText: "✅ v1\n👥 У полі: <@U1>." }],
  };
  it("emits an edit per target whose 🔗 line differs, keyed by content-rev, plus the Звіт reply post", () => {
    const edits = planRelink(base, { permalink: url, zvitReply: true });
    const reminderLine = renderLinks({ kind: "reminder", date: "2026-09-03" }, base, url)!;
    const verdictLine = renderLinks({ kind: "verdict", date: "2026-09-03", reportTs: "100.1" }, base, url)!;
    const zvitLine = renderLinks({ kind: "zvit", reportTs: "100.1" }, base, url)!;
    expect(edits).toEqual([
      { target: { kind: "reminder", date: "2026-09-03" }, op: "edit", ts: "50.0", threadTs: null,
        newText: withLinksRegion(base.reminderText!, reminderLine), key: `links-edit:reminder:2026-09-03:${contentRev(reminderLine)}` },
      { target: { kind: "verdict", date: "2026-09-03", reportTs: "100.1" }, op: "edit", ts: "200.1", threadTs: null,
        newText: withLinksRegion(base.reports[0].verdictText!, verdictLine), key: `links-edit:verdict:2026-09-03#100.1:${contentRev(verdictLine)}` },
      { target: { kind: "zvit", reportTs: "100.1" }, op: "post", ts: null, threadTs: "100.1", newText: zvitLine, key: "links-zvit:100.1" },
    ]);
  });
  it("is a no-op when every message already carries the current line", () => {
    const reminderLine = renderLinks({ kind: "reminder", date: "2026-09-03" }, base, url)!;
    const verdictLine = renderLinks({ kind: "verdict", date: "2026-09-03", reportTs: "100.1" }, base, url)!;
    const zvitLine = renderLinks({ kind: "zvit", reportTs: "100.1" }, base, url)!;
    const current: DayNodes = {
      ...base, reminderText: withLinksRegion(base.reminderText!, reminderLine),
      reports: [{ ...base.reports[0], verdictText: withLinksRegion(base.reports[0].verdictText!, verdictLine), zvitReplyTs: "400.1", zvitReplyText: zvitLine }],
    };
    expect(planRelink(current, { permalink: url, zvitReply: true })).toEqual([]);
  });
  it("edits a stale Звіт reply under its own edit key", () => {
    const stale: DayNodes = { ...base, reports: [{ ...base.reports[0], zvitReplyTs: "400.1", zvitReplyText: `${LINKS_MARKER}<old|Вердикт>` }] };
    const zvitLine = renderLinks({ kind: "zvit", reportTs: "100.1" }, stale, url)!;
    const e = planRelink(stale, { permalink: url, zvitReply: true }).find((x) => x.target.kind === "zvit")!;
    expect(e).toEqual({ target: { kind: "zvit", reportTs: "100.1" }, op: "edit", ts: "400.1", threadTs: null, newText: zvitLine, key: `links-zvit-edit:100.1:${contentRev(zvitLine)}` });
  });
  it("zvitReply:false suppresses the POST but still edits an existing reply", () => {
    expect(planRelink(base, { permalink: url, zvitReply: false }).some((e) => e.op === "post")).toBe(false);
    const stale: DayNodes = { ...base, reports: [{ ...base.reports[0], zvitReplyTs: "400.1", zvitReplyText: "🔗 <old|Вердикт>" }] };
    expect(planRelink(stale, { permalink: url, zvitReply: false }).some((e) => e.target.kind === "zvit" && e.op === "edit")).toBe(true);
  });
  it("never posts a Звіт reply for a report without a verdict, and skips targets whose text is unknown", () => {
    const noVerdict: DayNodes = { date: "2026-09-03", reminderTs: "50.0", reminderText: "r", reports: [{ reportTs: "100.1" }] };
    expect(planRelink(noVerdict, { permalink: url, zvitReply: true }).map((e) => e.target.kind)).toEqual(["reminder"]);
    const unknownText: DayNodes = { date: "2026-09-03", reminderTs: "50.0", reports: [{ reportTs: "100.1", verdictTs: "200.1", verdictText: "v" }] };
    expect(planRelink(unknownText, { permalink: url, zvitReply: false }).map((e) => e.target.kind)).toEqual(["verdict"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/dayLinks.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// lib/dayLinks.ts
/**
 * Pure planner for the #field-qa cross-links (🔗) — spec
 * docs/superpowers/specs/2026-09-04-field-qa-cross-links-design.md.
 *
 * A flight day's message CLUSTER is derived from stores every post already
 * wrote (no registry of its own, so nothing can drift): the drone reminder and
 * the bot's Звіт-thread reply from `outbound_messages`, the verdict from
 * `published`, the bonus breakdown from `bonus_notified` (+ its text from
 * `outbound_messages`), the monthly summary chunk from `outbound_messages`.
 * `renderLinks` builds the one trailing 🔗 line each target should carry;
 * `planRelink` emits an edit only where the message's current line differs
 * (content-hash keyed, so an unchanged cluster dedups at the chokepoint).
 * No DB / Slack / Next imports; unit-tested.
 */
import { LINKS_MARKER, splitLinksRegion, withLinksRegion } from "./linksRegion";
import { bonusThreadKey, contentRev, linksEditKey, linksZvitEditKey, linksZvitKey, type LinksTarget } from "./outboundKeys";
import { droneReminderKey } from "./droneReminderPlan";
import { reportKey } from "./fieldDayVerdict";
import type { PublishedLog } from "./published";
import type { NotifiedLog } from "./bonusNotified";

export interface OutboundRowLike {
  key: string;
  feature: string;
  status: string;
  ts: string | null;
  text: string;
  channel: string;
}

export interface ReportNodes {
  reportTs: string;
  verdictTs?: string;
  verdictText?: string;
  bonusTs?: string;
  bonusText?: string;
  zvitReplyTs?: string;
  zvitReplyText?: string;
}

export interface DayNodes {
  date: string;
  reminderTs?: string;
  reminderText?: string;
  /** Ordered by Звіт ts ascending — the ordinal «N/M» order. */
  reports: ReportNodes[];
  /** The summary thread chunk that carries this day's line (unambiguous match only). */
  summaryTs?: string;
}

export interface CollectInput {
  date: string;
  /** Tracked channel NAME the cluster lives in (all nodes must match it). */
  channel: string;
  published: PublishedLog;
  notified: NotifiedLog;
  outbound: OutboundRowLike[];
}

const SUMMARY_FEATURE = "field-summary";

function sentRow(rows: OutboundRowLike[], pred: (r: OutboundRowLike) => boolean): OutboundRowLike | undefined {
  return rows.find((r) => r.status === "sent" && r.ts && pred(r));
}

/** The one summary thread chunk whose text has a line starting with «*DD.MM » for `date`; null when none or ambiguous. */
export function summaryChunkFor(date: string, rows: OutboundRowLike[], channel: string): string | null {
  const label = `*${date.slice(8, 10)}.${date.slice(5, 7)} `;
  const re = new RegExp(`(^|\\n)\\${label}`);
  const hits = new Set(
    rows
      .filter((r) => r.feature === SUMMARY_FEATURE && r.status === "sent" && r.ts && r.channel === channel && !r.key.endsWith(":anchor") && re.test(r.text))
      .map((r) => r.ts as string),
  );
  return hits.size === 1 ? [...hits][0] : null;
}

export function collectDayNodes(input: CollectInput): DayNodes {
  const { date, channel, published, notified, outbound } = input;
  const reminder = sentRow(outbound, (r) => r.key === droneReminderKey(date) && r.channel === channel);
  const reports: ReportNodes[] = Object.values(published)
    .filter((e) => e.date === date && e.channel === channel && e.reportTs)
    .sort((a, b) => Number(a.reportTs) - Number(b.reportTs))
    .map((e) => {
      const reportTs = e.reportTs as string;
      const key = reportKey(date, reportTs);
      const node: ReportNodes = { reportTs, verdictTs: e.ts, verdictText: e.text };
      const bonusTs = notified[key]?.threadTs;
      if (bonusTs) {
        node.bonusTs = bonusTs;
        node.bonusText = sentRow(outbound, (r) => r.key === bonusThreadKey(key))?.text ?? "";
      }
      const zvit = sentRow(outbound, (r) => r.key === linksZvitKey(reportTs));
      if (zvit) {
        node.zvitReplyTs = zvit.ts as string;
        node.zvitReplyText = zvit.text;
      }
      return node;
    });
  const summaryTs = summaryChunkFor(date, outbound, channel);
  return {
    date,
    ...(reminder ? { reminderTs: reminder.ts as string, reminderText: reminder.text } : {}),
    reports,
    ...(summaryTs ? { summaryTs } : {}),
  };
}

type Link = { label: string; ts: string };

function ordinal(i: number, n: number): string {
  return n > 1 ? ` ${i + 1}/${n}` : "";
}

/** The 🔗 line `target` should carry given the day's nodes, or null when there is nothing to link. */
export function renderLinks(target: LinksTarget, nodes: DayNodes, permalink: (ts: string) => string): string | null {
  const links: Link[] = [];
  const n = nodes.reports.length;
  if (target.kind === "reminder") {
    nodes.reports.forEach((r, i) => links.push({ label: `Звіт${ordinal(i, n)}`, ts: r.reportTs }));
    nodes.reports.forEach((r, i) => { if (r.verdictTs) links.push({ label: `Вердикт${ordinal(i, n)}`, ts: r.verdictTs }); });
    nodes.reports.forEach((r, i) => { if (r.bonusTs) links.push({ label: `Бонуси${ordinal(i, n)}`, ts: r.bonusTs }); });
  } else {
    const r = nodes.reports.find((x) => x.reportTs === target.reportTs);
    if (!r) return null;
    if (target.kind !== "zvit") links.push({ label: "Звіт", ts: r.reportTs });
    if (target.kind === "zvit" && r.verdictTs) links.push({ label: "Вердикт", ts: r.verdictTs });
    if (nodes.reminderTs) links.push({ label: "Дрони", ts: nodes.reminderTs });
    if (target.kind !== "bonus" && r.bonusTs) links.push({ label: "Бонуси", ts: r.bonusTs });
  }
  if (nodes.summaryTs) links.push({ label: "Підсумок", ts: nodes.summaryTs });
  if (links.length === 0) return null;
  return `${LINKS_MARKER}${links.map((l) => `<${permalink(l.ts)}|${l.label}>`).join(" · ")}`;
}

export interface RelinkEdit {
  target: LinksTarget;
  op: "edit" | "post";
  /** Message to edit (null for a post). */
  ts: string | null;
  /** Thread root for a post (null for an edit). */
  threadTs: string | null;
  newText: string;
  key: string;
}

/**
 * The edits/posts that bring every target's 🔗 line up to date. A target whose
 * current text is unknown (message not in the stores) is skipped — never edit
 * blind. The Звіт-thread reply is POSTED only when `zvitReply` is on and the
 * report already has a verdict; an existing reply is always kept current.
 */
export function planRelink(nodes: DayNodes, opts: { permalink: (ts: string) => string; zvitReply: boolean }): RelinkEdit[] {
  const out: RelinkEdit[] = [];
  const edit = (target: LinksTarget, ts: string, current: string) => {
    const line = renderLinks(target, nodes, opts.permalink);
    const next = withLinksRegion(current, line);
    if (next === current || line === null) return;
    out.push({ target, op: "edit", ts, threadTs: null, newText: next, key: linksEditKey(target, contentRev(line)) });
  };
  if (nodes.reminderTs && nodes.reminderText !== undefined) edit({ kind: "reminder", date: nodes.date }, nodes.reminderTs, nodes.reminderText);
  for (const r of nodes.reports) {
    if (r.verdictTs && r.verdictText !== undefined) edit({ kind: "verdict", date: nodes.date, reportTs: r.reportTs }, r.verdictTs, r.verdictText);
    if (r.bonusTs && r.bonusText !== undefined) edit({ kind: "bonus", date: nodes.date, reportTs: r.reportTs }, r.bonusTs, r.bonusText);
    const target: LinksTarget = { kind: "zvit", reportTs: r.reportTs };
    const line = renderLinks(target, nodes, opts.permalink);
    if (r.zvitReplyTs && r.zvitReplyText !== undefined) {
      if (line !== null && splitLinksRegion(r.zvitReplyText).linksLine !== line) {
        out.push({ target, op: "edit", ts: r.zvitReplyTs, threadTs: null, newText: line, key: linksZvitEditKey(r.reportTs, contentRev(line)) });
      }
    } else if (opts.zvitReply && r.verdictTs && line !== null) {
      out.push({ target, op: "post", ts: null, threadTs: r.reportTs, newText: line, key: linksZvitKey(r.reportTs) });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/dayLinks.test.ts`
Expected: PASS. If the `collectDayNodes` test's `zvitReplyTs` lookup for `100.2` fails because the Звіт row is not `status: "sent"`, check the `row()` helper defaults — they are `sent` with `ts: "9.9"`, overridden per row.

- [ ] **Step 5: Commit**

```bash
git add lib/dayLinks.ts lib/dayLinks.test.ts
git commit -m "links: pure day-cluster planner (collectDayNodes / renderLinks / planRelink)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Nightly refresh ignores the 🔗 region

**Files:**
- Modify: `lib/backfillPublished.ts:88-93`
- Test: `lib/backfillPublished.test.ts` (append)

**Interfaces:**
- Consumes: `splitLinksRegion`, `withLinksRegion` (Task 1).
- Produces: `computeBackfillPlan` compares the stored text **minus** its 🔗 line against `formatDayMessage`, and its `newText` carries the existing 🔗 line re-appended.

- [ ] **Step 1: Write the failing tests**

Append to `lib/backfillPublished.test.ts`:

```ts
import { LINKS_MARKER, withLinksRegion } from "./linksRegion";

describe("computeBackfillPlan with a trailing 🔗 line", () => {
  const links = `${LINKS_MARKER}<https://x/p1|Звіт> · <https://x/p2|Дрони>`;
  it("treats a current render + 🔗 line as already-current (never strips links nightly)", () => {
    const v = verdict({});
    const plan = computeBackfillPlan(logOf(entry({ text: withLinksRegion(formatDayMessage(v), links) })), [v]);
    expect(plan[0].action).toBe("skip");
    expect(plan[0].reason).toBe("already-current");
  });
  it("re-appends the existing 🔗 line when the body needs a re-render", () => {
    const v = verdict({});
    const plan = computeBackfillPlan(logOf(entry({ text: withLinksRegion("✅ stale body", links) })), [v]);
    expect(plan[0].action).toBe("update");
    expect(plan[0].newText).toBe(withLinksRegion(formatDayMessage(v), links));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/backfillPublished.test.ts`
Expected: FAIL — the first case is `update`, the second's `newText` lacks the 🔗 line.

- [ ] **Step 3: Implement**

In `lib/backfillPublished.ts`, import `{ splitLinksRegion, withLinksRegion } from "./linksRegion"` and replace the tail of the `.map` callback from `const newText = formatDayMessage(verdict);` onward:

```ts
      // The 🔗 cross-link line is a disjoint region owned by lib/relinkDay, not
      // by the formatter: compare and re-render WITHOUT it, then put it back.
      const { rest: storedBody, linksLine } = splitLinksRegion(entry.text);
      const newText = withLinksRegion(formatDayMessage(verdict), linksLine);
      if (overridden) {
        return { ...withReportMeta, newText, action: "skip" as const, reason: "overridden" as const };
      }
      if (storedBody === formatDayMessage(verdict)) {
        return { ...withReportMeta, newText, action: "skip" as const, reason: "already-current" as const };
      }
      return { ...withReportMeta, newText, action: "update" as const, reason: "needs-update" as const };
```

Also update the file's doc comment: "An item is `update` only when its stored text — minus the trailing 🔗 cross-link line, which is re-appended to the new render — differs from the fresh render."

- [ ] **Step 4: Run the suite**

Run: `npx vitest run lib/backfillPublished.test.ts lib/refreshPublished.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/backfillPublished.ts lib/backfillPublished.test.ts
git commit -m "refresh: compare verdict text without the 🔗 region and re-append it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Server driver — `lib/relinkDay.ts`

**Files:**
- Create: `lib/relinkDay.ts`
- Test: `lib/relinkDay.test.ts`

**Interfaces:**
- Consumes: Task 3 (`findSentByKey`, `readOutboundByFeature`, `LINKS_FEATURE`), Task 4 (`collectDayNodes`, `planRelink`, `RelinkEdit`), `readPublished`/`findPublishedByTs`/`writePublished`/`recordPublished` (`lib/published.ts`), `readNotified` (`lib/bonusNotified.ts`), `postMessage`/`updateMessage`/`permalinkFor` (`lib/slack.ts`), `TRACKED_CHANNELS` (`lib/slackChannels.ts`), `periodKey`/`Period` (`lib/period.ts`), `SendTrigger`.
- Produces:

```ts
export interface RelinkOptions { publish: boolean; trigger: SendTrigger; zvitReply: boolean; channel?: string /* tracked channel NAME, default "field-qa" */; onLog?: (m: string) => void }
export interface RelinkDayResult { date: string; planned: RelinkEdit[]; sent: number; skipped: number; failed: { key: string; error: string }[] }
export interface RelinkResult { days: RelinkDayResult[]; sent: number; skipped: number; failed: number }
export async function relinkDays(period: Period, dates: string[] | null, opts: RelinkOptions): Promise<RelinkResult>
export async function planRelinkForPeriod(period: Period, dates: string[] | null, channel: string): Promise<{ channelId: string; days: { date: string; nodes: DayNodes; edits: RelinkEdit[] }[] }>  // read-only; the web route and dry-run use it
```

`dates === null` → every date that has a `published` entry in the period (plus reminder rows for dates in the period) — the union of dates seen across the three stores, within `[period.start, period.end]`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/relinkDay.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  readPublished: vi.fn(),
  findPublishedByTs: vi.fn(),
  writePublished: vi.fn(),
  readNotified: vi.fn(),
  readOutboundByFeature: vi.fn(),
  findSentByKey: vi.fn(),
}));
vi.mock("./slack", () => ({
  postMessage: m.postMessage,
  updateMessage: m.updateMessage,
  permalinkFor: (c: string, ts: string) => `https://w/${c}/p${ts.replace(".", "")}`,
}));
vi.mock("./published", async (orig) => ({
  ...(await orig<typeof import("./published")>()),
  readPublished: m.readPublished,
  findPublishedByTs: m.findPublishedByTs,
  writePublished: m.writePublished,
}));
vi.mock("./bonusNotified", async (orig) => ({ ...(await orig<typeof import("./bonusNotified")>()), readNotified: m.readNotified }));
vi.mock("./outbound", () => ({ readOutboundByFeature: m.readOutboundByFeature, findSentByKey: m.findSentByKey }));

import { relinkDays } from "./relinkDay";

const period = { start: "2026-09-01", end: "2026-09-30" };
const entry = { date: "2026-09-03", reportTs: "100.1", channel: "field-qa", text: "✅ v1", ts: "200.1", postedAt: "" };

beforeEach(() => {
  vi.resetAllMocks();
  m.readPublished.mockResolvedValue({ "2026-09-03#100.1": entry });
  m.readNotified.mockResolvedValue({});
  m.readOutboundByFeature.mockImplementation(async (feature: string) =>
    feature === "drone-reminder"
      ? [{ key: "drone-reminder:2026-09-03", feature, status: "sent", ts: "50.0", text: "🛸 …", channel: "field-qa" }]
      : []);
  m.findSentByKey.mockResolvedValue(null);
  m.findPublishedByTs.mockResolvedValue({ period, entry });
  m.updateMessage.mockImplementation(async (_c: string, ts: string) => ts);
  m.postMessage.mockResolvedValue("400.1");
});

describe("relinkDays", () => {
  it("dry-run plans but sends nothing", async () => {
    const r = await relinkDays(period, ["2026-09-03"], { publish: false, trigger: "cli", zvitReply: true });
    expect(r.days[0].planned.map((e) => e.target.kind)).toEqual(["reminder", "verdict", "zvit"]);
    expect(m.updateMessage).not.toHaveBeenCalled();
    expect(m.postMessage).not.toHaveBeenCalled();
    expect(m.writePublished).not.toHaveBeenCalled();
  });

  it("publish edits the reminder + verdict, posts the Звіт reply, and writes the verdict text back", async () => {
    const r = await relinkDays(period, ["2026-09-03"], { publish: true, trigger: "cron", zvitReply: true });
    expect(r.sent).toBe(3);
    expect(m.updateMessage).toHaveBeenCalledWith("C08GY2NKF9D", "50.0", expect.stringContaining("🔗 "), expect.objectContaining({ feature: "links", key: expect.stringMatching(/^links-edit:reminder:2026-09-03:/) }));
    expect(m.updateMessage).toHaveBeenCalledWith("C08GY2NKF9D", "200.1", expect.stringContaining("🔗 "), expect.objectContaining({ key: expect.stringMatching(/^links-edit:verdict:2026-09-03#100\.1:/) }));
    expect(m.postMessage).toHaveBeenCalledWith("C08GY2NKF9D", expect.stringMatching(/^🔗 </), expect.objectContaining({ key: "links-zvit:100.1" }), "100.1");
    expect(m.writePublished).toHaveBeenCalledWith(period, { "2026-09-03#100.1": expect.objectContaining({ ts: "200.1", text: expect.stringContaining("🔗 ") }) });
  });

  it("a failing edit is recorded and the loop continues", async () => {
    m.updateMessage.mockImplementation(async (_c: string, ts: string) => { if (ts === "50.0") throw new Error("boom"); return ts; });
    const r = await relinkDays(period, ["2026-09-03"], { publish: true, trigger: "cron", zvitReply: true });
    expect(r.failed).toBe(1);
    expect(r.days[0].failed[0]).toMatchObject({ error: "boom" });
    expect(r.sent).toBe(2);
  });

  it("an empty ts from the chokepoint counts as skipped, not sent, and skips the write-back", async () => {
    m.updateMessage.mockResolvedValue("");
    m.postMessage.mockResolvedValue("");
    const r = await relinkDays(period, ["2026-09-03"], { publish: true, trigger: "cron", zvitReply: true });
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(3);
    expect(m.writePublished).not.toHaveBeenCalled();
  });

  it("TOCTOU: a verdict whose stored text moved since planning is skipped", async () => {
    m.findPublishedByTs.mockResolvedValue({ period, entry: { ...entry, text: "✅ v1 (edited meanwhile)" } });
    const r = await relinkDays(period, ["2026-09-03"], { publish: true, trigger: "cron", zvitReply: false });
    expect(m.updateMessage).not.toHaveBeenCalledWith("C08GY2NKF9D", "200.1", expect.anything(), expect.anything());
    expect(r.skipped).toBe(1);
  });

  it("refuses an untracked channel", async () => {
    await expect(relinkDays(period, ["2026-09-03"], { publish: false, trigger: "cli", zvitReply: false, channel: "nope" })).rejects.toThrow(/не відстежується/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/relinkDay.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// lib/relinkDay.ts
/**
 * Cross-link (🔗) relink stage — spec
 * docs/superpowers/specs/2026-09-04-field-qa-cross-links-design.md. SERVER-ONLY
 * (edits Slack, rewrites `published.text`). Pure planning lives in
 * lib/dayLinks; this is the effectful driver, called by the nightly, the
 * `field-links` CLI, and the tail of every path that creates a node (bonus
 * notify, summary post, drone reminder).
 *
 * SOFT stage: each edit is independent — a failure is recorded and the loop
 * continues; nothing upstream depends on it and it never DMs the operator.
 * Idempotent: every key is target + contentRev(line) (see lib/outboundKeys).
 * An edit the chokepoint skips (returns "") is counted `skipped`, not sent,
 * and the verdict write-back is withheld, so the next run retries.
 */
import "server-only";
import { permalinkFor, postMessage, updateMessage } from "./slack";
import { TRACKED_CHANNELS } from "./slackChannels";
import { readPublished, findPublishedByTs, writePublished, recordPublished } from "./published";
import { readNotified } from "./bonusNotified";
import { readOutboundByFeature, findSentByKey } from "./outbound";
import { collectDayNodes, planRelink, type DayNodes, type OutboundRowLike, type RelinkEdit } from "./dayLinks";
import { DRONE_REMINDER_FEATURE } from "./droneReminderPlan";
import { LINKS_FEATURE, linksZvitKey, type SendTrigger } from "./outboundKeys";
import type { Period } from "./period";

const DEFAULT_CHANNEL = "field-qa";

export interface RelinkOptions {
  publish: boolean;
  trigger: SendTrigger;
  /** Post a NEW Звіт-thread reply where missing (edits of an existing one are always allowed). */
  zvitReply: boolean;
  /** Tracked channel NAME the cluster lives in; default #field-qa. */
  channel?: string;
  onLog?: (message: string) => void;
}

export interface RelinkDayResult {
  date: string;
  planned: RelinkEdit[];
  sent: number;
  skipped: number;
  failed: { key: string; error: string }[];
}

export interface RelinkResult {
  channel: string;
  days: RelinkDayResult[];
  sent: number;
  skipped: number;
  failed: number;
}

function inPeriod(date: string, period: Period): boolean {
  return date >= period.start && date <= period.end;
}

/** Read-only: the day clusters + planned edits (shared by dry-run, the web route and the publisher). */
export async function planRelinkForPeriod(
  period: Period,
  dates: string[] | null,
  channelName: string = DEFAULT_CHANNEL,
  zvitReply = true,
): Promise<{ channelId: string; days: { date: string; nodes: DayNodes; edits: RelinkEdit[] }[] }> {
  const channel = TRACKED_CHANNELS.find((c) => c.name === channelName);
  if (!channel) throw new Error(`канал ${channelName} не відстежується — 🔗 редагуємо лише у відстежуваних каналах.`);
  const [published, notified, reminders, summaries, bonusRows] = await Promise.all([
    readPublished(period),
    readNotified(period),
    readOutboundByFeature(DRONE_REMINDER_FEATURE),
    readOutboundByFeature("field-summary"),
    readOutboundByFeature("bonus"),
  ]);
  const reportTss = Object.values(published).map((e) => e.reportTs).filter((t): t is string => Boolean(t));
  const zvitRows = (await Promise.all(reportTss.map((t) => findSentByKey(linksZvitKey(t))))).filter((r): r is NonNullable<typeof r> => r !== null);
  const outbound: OutboundRowLike[] = [...reminders, ...summaries, ...bonusRows, ...zvitRows].map((r) => ({
    key: r.key, feature: r.feature, status: r.status, ts: r.ts, text: r.text, channel: r.channel,
  }));

  const candidates = new Set<string>(dates ?? []);
  if (!dates) {
    for (const e of Object.values(published)) if (inPeriod(e.date, period)) candidates.add(e.date);
    for (const r of reminders) {
      const d = r.key.slice(`${DRONE_REMINDER_FEATURE}:`.length);
      if (r.status === "sent" && inPeriod(d, period)) candidates.add(d);
    }
  }
  const permalink = (ts: string) => permalinkFor(channel.id, ts);
  const days = [...candidates].sort().map((date) => {
    const nodes = collectDayNodes({ date, channel: channel.name, published, notified, outbound });
    return { date, nodes, edits: planRelink(nodes, { permalink, zvitReply }) };
  });
  return { channelId: channel.id, days };
}

export async function relinkDays(period: Period, dates: string[] | null, opts: RelinkOptions): Promise<RelinkResult> {
  const log = opts.onLog ?? (() => {});
  const channelName = opts.channel ?? DEFAULT_CHANNEL;
  const { channelId, days } = await planRelinkForPeriod(period, dates, channelName, opts.zvitReply);
  const results: RelinkDayResult[] = [];
  for (const day of days) {
    const res: RelinkDayResult = { date: day.date, planned: day.edits, sent: 0, skipped: 0, failed: [] };
    for (const e of day.edits) {
      if (!opts.publish) { log(`field-links (dry-run): would ${e.op} ${e.key}`); continue; }
      try {
        const meta = { key: e.key, feature: LINKS_FEATURE, channel: channelName, trigger: opts.trigger };
        let ts: string;
        if (e.op === "post") {
          ts = await postMessage(channelId, e.newText, meta, e.threadTs ?? undefined);
        } else {
          if (e.target.kind === "verdict") {
            // TOCTOU guard (same as lib/refreshPublished): an approver strike or a
            // crew edit landing between planning and now must not be clobbered.
            const fresh = await findPublishedByTs(e.ts as string);
            const reportTs = (e.target as { reportTs: string }).reportTs;
            const planned = day.nodes.reports.find((r) => r.reportTs === reportTs);
            if (!fresh || fresh.entry.text !== planned?.verdictText) { res.skipped += 1; log(`field-links: ${e.key} changed-since-plan — skipped`); continue; }
          }
          ts = await updateMessage(channelId, e.ts as string, e.newText, meta);
        }
        if (!ts) { res.skipped += 1; log(`field-links: ${e.key} skipped by the chokepoint (stuck reservation)`); continue; }
        if (e.op === "edit" && e.target.kind === "verdict") {
          const fresh = await findPublishedByTs(e.ts as string);
          if (fresh) await writePublished(fresh.period, recordPublished({}, { ...fresh.entry, text: e.newText }));
        }
        res.sent += 1;
        log(`field-links: ${e.op} ${e.key} → ts ${ts}`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        res.failed.push({ key: e.key, error });
        log(`field-links: ${e.key} FAILED — ${error}`);
      }
    }
    results.push(res);
  }
  return {
    channel: channelName,
    days: results,
    sent: results.reduce((n, d) => n + d.sent, 0),
    skipped: results.reduce((n, d) => n + d.skipped, 0),
    failed: results.reduce((n, d) => n + d.failed.length, 0),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run lib/relinkDay.test.ts`
Expected: PASS (6 tests). If `vi.mock("./published", async (orig) …)` complains, mock the whole module explicitly: `{ readPublished, findPublishedByTs, writePublished, recordPublished: (log, e) => ({ ...log, [\`${e.date}#${e.reportTs}\`]: e }) }`.

- [ ] **Step 5: Commit**

```bash
git add lib/relinkDay.ts lib/relinkDay.test.ts
git commit -m "links: relinkDays server driver (soft-fail, TOCTOU-guarded, write-back)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Summary day line links «дрони» + «бонуси»

**Files:**
- Modify: `lib/fieldMonthSummary.ts:26-47` (`SummaryDay`), `:165-168` (links in `formatDayLine`)
- Modify: `lib/fieldSummaryPost.ts:60-100` (`assembleSummaryDays`)
- Test: `lib/fieldMonthSummary.test.ts` (append)

**Interfaces:**
- Consumes: `readNotified` (`lib/bonusNotified.ts`), `readOutboundByFeature` (Task 3), `droneReminderKey` (`lib/droneReminderPlan.ts`).
- Produces: `SummaryDay.reminderUrl: string | null`, `SummaryDay.bonusUrl: string | null`; day line ends `<…|вердикт> · <…|звіт> · <…|дрони> · <…|бонуси>` (absent ones omitted).

- [ ] **Step 1: Write the failing test**

Append to `lib/fieldMonthSummary.test.ts` (reuse the file's existing `SummaryDay` fixture helper; if it is named differently, adapt the call):

```ts
describe("formatDayLine links", () => {
  it("appends дрони and бонуси links after вердикт · звіт, omitting absent ones", () => {
    const d = day({ verdictUrl: "https://x/v", zvitUrl: "https://x/z", reminderUrl: "https://x/r", bonusUrl: "https://x/b" });
    expect(formatDayLine(d)).toMatch(/<https:\/\/x\/v\|вердикт> · <https:\/\/x\/z\|звіт> · <https:\/\/x\/r\|дрони> · <https:\/\/x\/b\|бонуси>$/);
    expect(formatDayLine(day({ verdictUrl: "https://x/v", zvitUrl: null, reminderUrl: null, bonusUrl: "https://x/b" }))).toMatch(/<https:\/\/x\/v\|вердикт> · <https:\/\/x\/b\|бонуси>$/);
  });
});
```

Also add `reminderUrl: null, bonusUrl: null` to the test file's `SummaryDay` fixture defaults so existing tests keep compiling.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/fieldMonthSummary.test.ts`
Expected: FAIL — type error / missing links.

- [ ] **Step 3: Implement the renderer**

`lib/fieldMonthSummary.ts` — add to `SummaryDay`:

```ts
  /** The day's drone-count reminder (🛸 anchor) permalink, if the bot posted one. */
  reminderUrl: string | null;
  /** The bonus breakdown reply's permalink (posted by `field-bonus --notify`), if any. */
  bonusUrl: string | null;
```

and in `formatDayLine` replace the links block:

```ts
  const links: string[] = [];
  if (day.verdictUrl) links.push(`<${day.verdictUrl}|вердикт>`);
  if (day.zvitUrl) links.push(`<${day.zvitUrl}|звіт>`);
  if (day.reminderUrl) links.push(`<${day.reminderUrl}|дрони>`);
  if (day.bonusUrl) links.push(`<${day.bonusUrl}|бонуси>`);
  if (links.length) parts.push(links.join(" · "));
```

- [ ] **Step 4: Supply the URLs in `assembleSummaryDays`**

In `lib/fieldSummaryPost.ts` add imports `import { readNotified } from "./bonusNotified"; import { readOutboundByFeature } from "./outbound"; import { DRONE_REMINDER_FEATURE, droneReminderKey } from "./droneReminderPlan";`, then inside `assembleSummaryDays` after `const published = await readPublished(period);`:

```ts
  const notified = await readNotified(period);
  const reminderTsByDate = new Map<string, string>();
  for (const r of await readOutboundByFeature(DRONE_REMINDER_FEATURE)) {
    if (r.status === "sent" && r.ts && r.channel === fieldQaChannel.name) reminderTsByDate.set(r.key.slice(`${DRONE_REMINDER_FEATURE}:`.length), r.ts);
  }
```

and in the returned object:

```ts
      reminderUrl: reminderTsByDate.has(v.date) ? permalinkFor(fieldQaChannel.id, reminderTsByDate.get(v.date)!) : null,
      bonusUrl: notified[reportKey(v.date, v.reportTs)]?.threadTs ? permalinkFor(fieldQaChannel.id, notified[reportKey(v.date, v.reportTs)]!.threadTs!) : null,
```

(`droneReminderKey` import is unused if you slice the key; drop it. Keep `DRONE_REMINDER_FEATURE`.)

- [ ] **Step 5: Run suite + typecheck**

Run: `npx vitest run lib/fieldMonthSummary.test.ts && npx tsc --noEmit -p .`
Expected: PASS; any other `SummaryDay` literal (e.g. in `app/api/field-summary` consumers or tests) that fails typing gets the two new `null` fields.

- [ ] **Step 6: Commit**

```bash
git add lib/fieldMonthSummary.ts lib/fieldMonthSummary.test.ts lib/fieldSummaryPost.ts
git commit -m "summary: day line links дрони + бонуси next to вердикт · звіт

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Hooks — nightly, drone reminder, summary post, bonus notify

**Files:**
- Modify: `lib/runNightly.ts:191-222` (after the refresh, per month)
- Modify: `lib/droneReminder.ts:84-96` (after the post)
- Modify: `lib/fieldSummaryPost.ts` (`postFieldSummary` tail)
- Modify: `scripts/field-bonus.ts:56-78` (after the per-item loop)
- Test: `lib/runNightly.test.ts` (append one case)

**Interfaces:**
- Consumes: `relinkDays(period, dates, opts)` (Task 6).
- Produces: `NightlyMonthResult.relinked?: { sent: number; skipped: number; failed: number }`.

All four hooks share this shape — copy it, do not abstract:

```ts
    try {
      const r = await relinkDays(period, dates, { publish, trigger, zvitReply, onLog: log });
      log(`field-links: ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed`);
    } catch (e) {
      log(`field-links: stage skipped — ${e instanceof Error ? e.message : String(e)}`);
    }
```

- [ ] **Step 1: Nightly test**

Append to `lib/runNightly.test.ts`, following the file's existing mocking style (it already mocks `./refreshPublished`, `./publishVerdicts`, etc. via `vi.hoisted` + `vi.mock`). Add `relinkDays: vi.fn()` to the hoisted block, `vi.mock("./relinkDay", () => ({ relinkDays }))`, and:

```ts
  it("runs the cross-link stage per window month after refresh, and a relink failure never fails the night", async () => {
    relinkDays.mockRejectedValueOnce(new Error("slack down"));
    const summary = await runNightly({ publish: true, today: "2026-09-04", onLog: () => {} });
    expect(relinkDays).toHaveBeenCalledWith(
      expect.objectContaining({ start: "2026-09-01" }), null,
      expect.objectContaining({ publish: true, trigger: "cron", zvitReply: true }),
    );
    expect(summary.months.length).toBeGreaterThan(0);
  });
```

Adapt `runNightly`'s option object to what the test file already passes in its other cases (e.g. `channel`), copying an existing successful call.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/runNightly.test.ts`
Expected: FAIL — `relinkDays` not called.

- [ ] **Step 3: Nightly hook**

In `lib/runNightly.ts` import `{ relinkDays } from "./relinkDay"`, extend `NightlyMonthResult` with `relinked?: { sent: number; skipped: number; failed: number }`, and inside the per-month loop after the `refreshPublishedDays` calls (before the anomaly check):

```ts
      // 3b. Cross-links (🔗) between the month's per-day messages — soft stage:
      // cosmetic, so a Slack hiccup here never fails the night or DMs anyone.
      let relinked: NightlyMonthResult["relinked"];
      try {
        const r = await relinkDays(c.period, null, { publish: opts.publish, trigger: "cron", zvitReply: true, onLog: log });
        relinked = { sent: r.sent, skipped: r.skipped, failed: r.failed };
      } catch (e) {
        log(`field-links: stage skipped — ${e instanceof Error ? e.message : String(e)}`);
      }
```

and add `relinked` to the `months.push({...})` object.

- [ ] **Step 4: Drone reminder hook**

In `lib/droneReminder.ts` import `{ relinkDays } from "./relinkDay"` and after the `postMessage` + log in the publish branch:

```ts
  try {
    const r = await relinkDays({ start: today, end: today }, [today], { publish: true, trigger: opts.trigger ?? "cron", zvitReply: true, onLog: log });
    log(`field-links: ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed`);
  } catch (e) {
    log(`field-links: stage skipped — ${e instanceof Error ? e.message : String(e)}`);
  }
```

(Usually a no-op at 09:00 — the Звіт lands later — but cheap, and it covers a re-run later in the day.)

- [ ] **Step 5: Summary post hook**

In `lib/fieldSummaryPost.ts` import `{ relinkDays } from "./relinkDay"` and at the end of `postFieldSummary`, before `return`:

```ts
  // Reverse links: the just-posted summary chunks are never edited, but the
  // reminder / verdict / bonus / Звіт-reply messages now gain «Підсумок».
  try {
    const r = await relinkDays(args.period, null, { publish: true, trigger: args.trigger, zvitReply: false, channel: channel.name });
    console.error(`field-links: ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed`);
  } catch (e) {
    console.error(`field-links: stage skipped — ${e instanceof Error ? e.message : String(e)}`);
  }
```

`zvitReply: false` here: a month-end summary must not bump every Звіт thread of the month with a fresh reply; edits of already-existing replies still happen.

- [ ] **Step 6: Bonus notify hook**

In `scripts/field-bonus.ts`, after the `for (const item of plan)` loop and before `process.stderr.write("field-bonus: notify done.\n")`:

```ts
    const { relinkDays } = await import("../lib/relinkDay");
    const notifiedDates = [...new Set(plan.filter((i) => i.published).map((i) => i.date))];
    try {
      const r = await relinkDays(period, notifiedDates, { publish: true, trigger: "cli", zvitReply: true, channel: channel.name, onLog: (m) => process.stderr.write(`${m}\n`) });
      process.stderr.write(`field-links: ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed\n`);
    } catch (e) {
      process.stderr.write(`field-links: stage skipped — ${e instanceof Error ? e.message : String(e)}\n`);
    }
```

- [ ] **Step 7: Run suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/runNightly.ts lib/runNightly.test.ts lib/droneReminder.ts lib/fieldSummaryPost.ts scripts/field-bonus.ts
git commit -m "links: soft-fail relink hooks in nightly, drone reminder, summary post, bonus notify

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: CLI `npm run field-links`

**Files:**
- Create: `scripts/fieldLinksReport.ts` (pure), `scripts/field-links.ts`
- Modify: `package.json` scripts
- Test: `scripts/fieldLinksReport.test.ts`

**Interfaces:**
- Consumes: `planRelinkForPeriod`, `relinkDays` (Task 6), `DayNodes`/`RelinkEdit` (Task 4), `parseArgs`/`resolvePeriod` style from `scripts/fieldPublishReport.ts`.
- Produces:
  - `parseLinksArgs(argv): { start?: string; end?: string; channel?: string; publish: boolean; zvitReply: boolean | null; format?: "table" }` — `--zvit-reply` → `true`, `--no-zvit-reply` → `false`, neither → `null` (resolved to `true` by the CLI only for dates within the last 14 days of today; older dates get `false` unless `--zvit-reply` was explicit).
  - `renderLinksTable(days: { date: string; nodes: DayNodes; edits: RelinkEdit[] }[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/fieldLinksReport.test.ts
import { describe, expect, it } from "vitest";
import { parseLinksArgs, renderLinksTable, resolveZvitReply } from "./fieldLinksReport";

describe("parseLinksArgs", () => {
  it("parses flags; zvit-reply defaults to null", () => {
    expect(parseLinksArgs(["--start", "2026-09-01", "--end", "2026-09-04", "--publish", "--channel", "field-qa", "--format", "table"]))
      .toEqual({ start: "2026-09-01", end: "2026-09-04", publish: true, channel: "field-qa", zvitReply: null, format: "table" });
    expect(parseLinksArgs(["--zvit-reply"]).zvitReply).toBe(true);
    expect(parseLinksArgs(["--no-zvit-reply"]).zvitReply).toBe(false);
  });
  it("rejects unknown flags", () => {
    expect(() => parseLinksArgs(["--bogus"])).toThrow(/Unknown flag/);
  });
});

describe("resolveZvitReply", () => {
  it("explicit flag wins; otherwise only periods ending within 14 days of today post new Звіт replies", () => {
    expect(resolveZvitReply(true, { start: "2026-07-01", end: "2026-07-31" }, "2026-09-04")).toBe(true);
    expect(resolveZvitReply(false, { start: "2026-09-01", end: "2026-09-04" }, "2026-09-04")).toBe(false);
    expect(resolveZvitReply(null, { start: "2026-09-01", end: "2026-09-04" }, "2026-09-04")).toBe(true);
    expect(resolveZvitReply(null, { start: "2026-07-01", end: "2026-07-31" }, "2026-09-04")).toBe(false);
  });
});

describe("renderLinksTable", () => {
  it("one row per day with node markers and the planned edit count", () => {
    const out = renderLinksTable([{
      date: "2026-09-03",
      nodes: { date: "2026-09-03", reminderTs: "50.0", reports: [{ reportTs: "100.1", verdictTs: "200.1" }], summaryTs: undefined },
      edits: [{ target: { kind: "verdict", date: "2026-09-03", reportTs: "100.1" }, op: "edit", ts: "200.1", threadTs: null, newText: "x", key: "links-edit:verdict:2026-09-03#100.1:abc" }],
    }]);
    expect(out).toContain("2026-09-03");
    expect(out).toContain("дрони ✓");
    expect(out).toContain("звіт 1  вердикт ✓  бонуси –  🔗-звіт –");
    expect(out).toContain("edits: 1");
    expect(out).toContain("edit  links-edit:verdict:2026-09-03#100.1:abc");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run scripts/fieldLinksReport.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the pure helpers**

```ts
// scripts/fieldLinksReport.ts
/** Pure arg parsing + table rendering for `npm run field-links`. */
import type { DayNodes, RelinkEdit } from "../lib/dayLinks";

export interface LinksArgs {
  start?: string;
  end?: string;
  channel?: string;
  publish: boolean;
  /** true = --zvit-reply, false = --no-zvit-reply, null = not given. */
  zvitReply: boolean | null;
  format?: "table";
}

export function parseLinksArgs(argv: string[]): LinksArgs {
  const out: LinksArgs = { publish: false, zvitReply: null };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--start") { out.start = argv[i + 1]; i += 1; }
    else if (f === "--end") { out.end = argv[i + 1]; i += 1; }
    else if (f === "--channel") { out.channel = argv[i + 1]; i += 1; }
    else if (f === "--publish") out.publish = true;
    else if (f === "--zvit-reply") out.zvitReply = true;
    else if (f === "--no-zvit-reply") out.zvitReply = false;
    else if (f === "--format") { if (argv[i + 1] === "table") out.format = "table"; i += 1; }
    else throw new Error(`Unknown flag ${f}`);
  }
  return out;
}

const RECENT_DAYS = 14;

/** Backfills of old months must not bump every Звіт thread with a new reply:
 *  an explicit flag wins; otherwise only a period ending within the last 14
 *  days posts new Звіт-thread replies (edits are always allowed). */
export function resolveZvitReply(flag: boolean | null, period: { start: string; end: string }, today: string): boolean {
  if (flag !== null) return flag;
  const ageDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${period.end}T00:00:00Z`)) / 86_400_000;
  return ageDays <= RECENT_DAYS;
}

export function renderLinksTable(days: { date: string; nodes: DayNodes; edits: RelinkEdit[] }[]): string {
  const mark = (v: unknown) => (v ? "✓" : "–");
  const lines: string[] = [];
  for (const d of days) {
    lines.push(`${d.date}  дрони ${mark(d.nodes.reminderTs)}  підсумок ${mark(d.nodes.summaryTs)}  edits: ${d.edits.length}`);
    d.nodes.reports.forEach((r, i) => {
      lines.push(`    звіт ${i + 1}  вердикт ${mark(r.verdictTs)}  бонуси ${mark(r.bonusTs)}  🔗-звіт ${mark(r.zvitReplyTs)}`);
    });
    for (const e of d.edits) lines.push(`    ${e.op.padEnd(4)}  ${e.key}`);
  }
  return lines.length ? lines.join("\n") : "(no days)";
}
```

- [ ] **Step 4: Write the CLI**

```ts
// scripts/field-links.ts
/**
 * CLI: cross-links (🔗) between a period's per-day #field-qa bot messages —
 * drone reminder, verdict, bonus breakdown, the bot's Звіт-thread reply and the
 * monthly summary line. DRY-RUN by default: prints each day's node table and
 * every planned edit/post, sends nothing.
 *
 *   npm run field-links -- --start 2026-09-01 --end 2026-09-04                      # dry-run, JSON
 *   npm run field-links -- --start 2026-09-01 --end 2026-09-04 --format table
 *   npm run field-links -- --start 2026-09-01 --end 2026-09-04 --publish --channel orients-ops-console-test
 *   npm run field-links -- --start 2026-07-01 --end 2026-07-31 --publish --channel field-qa --zvit-reply   # backfill incl. new Звіт replies
 *
 * `--publish` requires `--channel <name>` (tracked). New Звіт-thread replies are
 * posted only for a period ending within the last 14 days unless `--zvit-reply`
 * / `--no-zvit-reply` says otherwise (edits are always allowed). Mirrors
 * GET /api/field-links. Runs under --conditions=react-server.
 */
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { planRelinkForPeriod, relinkDays } from "../lib/relinkDay";
import { parseLinksArgs, renderLinksTable, resolveZvitReply } from "./fieldLinksReport";
import { resolvePeriod } from "./fieldPublishReport";

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }
  const args = parseLinksArgs(process.argv.slice(2));
  const today = todayInFieldTz();
  const period = resolvePeriod({ start: args.start, end: args.end, publish: args.publish }, today);
  const zvitReply = resolveZvitReply(args.zvitReply, period, today);
  const channelName = args.channel ?? "field-qa";

  if (!args.publish) {
    const plan = await planRelinkForPeriod(period, null, channelName, zvitReply);
    if (args.format === "table") {
      process.stdout.write(`DRY RUN — #${channelName} ${period.start}..${period.end} (zvitReply=${zvitReply})\n${renderLinksTable(plan.days)}\nNo messages were sent. Re-run with --publish --channel <name>.\n`);
    } else {
      console.log(JSON.stringify({ period, channel: channelName, zvitReply, days: plan.days }, null, 2));
    }
    return;
  }
  if (!args.channel) { process.stderr.write("field-links: --publish requires --channel <name>.\n"); process.exit(1); }
  if (!TRACKED_CHANNELS.some((c) => c.name === args.channel)) { process.stderr.write(`field-links: unknown channel "${args.channel}".\n`); process.exit(1); }
  const r = await relinkDays(period, null, { publish: true, trigger: "cli", zvitReply, channel: args.channel, onLog: (m) => process.stderr.write(`${m}\n`) });
  process.stderr.write(`field-links: ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed in #${r.channel}\n`);
  if (r.failed > 0) process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`field-links: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
```

Add to `package.json` scripts (next to `"field-loss"`):

```json
    "field-links": "node --conditions=react-server --import tsx scripts/field-links.ts",
```

- [ ] **Step 5: Run tests, typecheck, and a real dry-run**

Run: `npx vitest run scripts/fieldLinksReport.test.ts && npx tsc --noEmit -p . && npm run field-links -- --start 2026-09-01 --end 2026-09-04 --format table`
Expected: tests PASS; the dry-run prints a table for September's days (needs `POSTGRES_URL`) and says `No messages were sent.`

- [ ] **Step 6: Commit**

```bash
git add scripts/fieldLinksReport.ts scripts/fieldLinksReport.test.ts scripts/field-links.ts package.json
git commit -m "cli: field-links — dry-run/publish cross-link relink for a period

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Web twin + docs

**Files:**
- Create: `app/api/field-links/route.ts`
- Modify: `app/(dashboard)/field-verdict/page.tsx` (state at `:40`, fetch at `:53-64`, panel after the summary section at `:156-169`)
- Modify: `CLAUDE.md` (add a `npm run field-links` bullet after the `field-summary` one)

**Interfaces:**
- Consumes: `planRelinkForPeriod` (Task 6), `parsePeriodKey` (`lib/period.ts`).
- Produces: `GET /api/field-links?period=<key>` → `{ period, channel: "field-qa", days: [{ date, nodes, edits }] }`; 400 on a bad period.

- [ ] **Step 1: Route**

```ts
// app/api/field-links/route.ts
import { NextResponse } from "next/server";
import { parsePeriodKey } from "@/lib/period";
import { planRelinkForPeriod } from "@/lib/relinkDay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/field-links?period=<key> — the web twin of `npm run field-links`
 * (dry-run): per day, which cluster nodes exist (drone reminder, Звіт, verdict,
 * bonus reply, the bot's Звіт-thread reply, summary chunk) and the 🔗 edits a
 * relink would make. Read-only; never posts.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period");
  if (!period) return NextResponse.json({ error: "Provide `period` (YYYY-MM or YYYY-MM-DD_YYYY-MM-DD)." }, { status: 400 });
  const parsed = parsePeriodKey(period);
  if (!parsed) return NextResponse.json({ error: "`period` must be YYYY-MM or YYYY-MM-DD_YYYY-MM-DD." }, { status: 400 });
  try {
    const plan = await planRelinkForPeriod(parsed, null, "field-qa", true);
    return NextResponse.json({ period: parsed, channel: "field-qa", days: plan.days });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Panel on the Verdict tab**

In `app/(dashboard)/field-verdict/page.tsx`:

Add state next to `summary`:

```tsx
  type LinksDay = { date: string; nodes: { reminderTs?: string; summaryTs?: string; reports: { reportTs: string; verdictTs?: string; bonusTs?: string; zvitReplyTs?: string }[] }; edits: { op: string; key: string }[] };
  const [links, setLinks] = useState<LinksDay[] | null>(null);
```

In the load callback, after the summary fetch block:

```tsx
    setLinks(null);
    try {
      const res = await fetch(`/api/field-links?period=${encodeURIComponent(key)}`);
      if (res.ok) {
        const body = (await res.json()) as { days: LinksDay[] };
        setLinks(body.days);
      }
    } catch {
      /* panel simply stays hidden */
    }
```

After the summary `<section>`:

```tsx
      {/* Cross-links twin — what `npm run field-links` would edit (dry-run view) */}
      {links && links.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900">Зв&apos;язки між повідомленнями (#field-qa)</h2>
          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2 text-center">Дрони</th>
                  <th className="px-3 py-2">Звіти (вердикт / бонуси / 🔗-відповідь)</th>
                  <th className="px-3 py-2 text-center">Підсумок</th>
                  <th className="px-3 py-2 text-right">Pending edits</th>
                </tr>
              </thead>
              <tbody>
                {links.map((d) => (
                  <tr key={d.date} className="border-b border-slate-100">
                    <td className="px-3 py-2 font-mono text-xs">{d.date}</td>
                    <td className="px-3 py-2 text-center">{d.nodes.reminderTs ? "✓" : "–"}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {d.nodes.reports.map((r, i) => `${i + 1}: ${r.verdictTs ? "✓" : "–"}/${r.bonusTs ? "✓" : "–"}/${r.zvitReplyTs ? "✓" : "–"}`).join("  ")}
                    </td>
                    <td className="px-3 py-2 text-center">{d.nodes.summaryTs ? "✓" : "–"}</td>
                    <td className="px-3 py-2 text-right">{d.edits.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
```

- [ ] **Step 3: CLAUDE.md**

Add after the `npm run field-summary` bullet:

```markdown
- `npm run field-links -- --start YYYY-MM-DD --end YYYY-MM-DD [--publish --channel <name>] [--zvit-reply|--no-zvit-reply] [--format table]` — **cross-links between a flight day's #field-qa messages** (2026-09-04): the 🛸 drone reminder, each Звіт (via ONE bot reply in its thread — the Звіт itself is a human message), each verdict, each 💰 bonus breakdown and the monthly summary line link to one another through a trailing `🔗 Звіт · Вердикт · Дрони · Бонуси · Підсумок` line (Slack links; a message never links itself; multi-Звіт days carry «1/2» ordinals on the day-level reminder). No registry table: the cluster is DERIVED from `published`, `bonus_notified` and `outbound_messages` (pure planner `lib/dayLinks.ts`; driver `lib/relinkDay.ts`), and every edit is keyed `links-edit:<target>:<contentRev(line)>` so an unchanged cluster dedups at the chokepoint. Runs as a **soft stage** (never blocks, never DMs) in the nightly per window month and at the tail of `drone-reminder`, `field-bonus --notify --publish` and `field-summary`/`field_summary_post` (summary chunks themselves are never edited — they render link-complete at post time, incl. «дрони · бонуси»). The 🔗 line is a disjoint region below `🛸 Дрони:`: the crew/strike editors and the nightly refresh peel it and re-append it (`lib/linksRegion.ts`), and it is edited even on approver-overridden verdicts. **DRY-RUN by default** (prints per-day node table + planned edits); `--publish` requires `--channel <name>` — run against the test channel first after any verdict-format change. New Звіт-thread replies default to ON only for a period ending within the last 14 days (a backfill of an old month bumps every Звіт thread otherwise) — force with `--zvit-reply` / `--no-zvit-reply`. Web: `GET /api/field-links?period=` + the «Зв'язки» panel on the Verdict tab. (See `docs/superpowers/specs/2026-09-04-field-qa-cross-links-design.md`.)
```

- [ ] **Step 4: Lint, typecheck, build**

Run: `npm run lint && npx tsc --noEmit -p . && npm run build`
Expected: clean. (`npm run build` catches an accidental client import of the server-only `lib/relinkDay.ts` — the page must only `fetch` the route.)

- [ ] **Step 5: Commit**

```bash
git add app/api/field-links/route.ts "app/(dashboard)/field-verdict/page.tsx" CLAUDE.md
git commit -m "web: GET /api/field-links + Зв'язки panel on the Verdict tab; docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Rollout verification (manual, operator)

**Files:** none.

- [ ] **Step 1: Test-channel pass**

Run: `npm run field-links -- --start 2026-09-01 --end 2026-09-04 --format table` and read the plan. Then, if the test channel holds published verdicts, `npm run field-links -- --start 2026-09-01 --end 2026-09-04 --publish --channel orients-ops-console-test`. Otherwise skip to Step 2 with a single recent day.

- [ ] **Step 2: #field-qa, one recent day first**

Run: `npm run field-links -- --start 2026-09-03 --end 2026-09-03 --publish --channel field-qa`. Open #field-qa, confirm: the 🛸 reminder's last line is `🔗 Звіт · Вердикт …`, the verdict's last line is `🔗 Звіт · Дрони …`, a `🔗 Вердикт · Дрони` reply sits under the Звіт, each link opens the right message.

- [ ] **Step 3: Idempotency**

Re-run the same command. Expected stderr: `field-links: 0 sent, 0 skipped, 0 failed`.

- [ ] **Step 4: Whole month, then let the nightly own it**

Run: `npm run field-links -- --start 2026-09-01 --end 2026-09-04 --publish --channel field-qa`. Check `npm run sent -- --start 2026-09-04 --end 2026-09-04 --format table` shows feature `links` rows, all `sent`. Backfilling older months is the operator's call (`--zvit-reply` to also add Звіт replies).

---

## Self-review

**Spec coverage.** Link shape + labels + ordinals → Task 4. Звіт-thread reply post/edit → Tasks 4, 6. Region disjointness + overridden verdicts still edited → Tasks 1, 2 (relink never checks `override`; the TOCTOU guard compares text only). Refresh never strips links → Task 5. Derived registry / no table → Task 4, 6. `findSentByKey` → Task 3. Hooks (nightly, bonus, summary, reminder) → Task 8. Summary «дрони»/«бонуси» → Task 7; summary chunks never edited → Task 8 step 5 (`zvitReply: false`, no chunk target exists in the planner). CLI + web + docs → Tasks 9, 10. Rollout + 14-day Звіт-reply default → Tasks 9, 11. Soft-fail, `""` = skipped, untracked-channel refusal → Task 6. Ambiguous summary chunk → Task 4.

**Deviation from spec, deliberate:** `renderLinks` takes a `permalink` callback instead of a `channelId` so `lib/dayLinks.ts` stays free of the server-only `lib/slack.ts`; the driver supplies `permalinkFor(channel.id, ts)`.

**Type consistency.** `LinksTarget`, `linksEditKey`, `linksZvitKey`, `linksZvitEditKey`, `LINKS_FEATURE` (Task 3) are used verbatim in Tasks 4, 6. `DayNodes`/`ReportNodes`/`RelinkEdit`/`OutboundRowLike` (Task 4) are used verbatim in Tasks 6, 9, 10. `relinkDays(period, dates | null, opts)` and `planRelinkForPeriod(period, dates | null, channelName, zvitReply)` (Task 6) match every call in Tasks 8, 9, 10. `splitRosterSuffix` now returns `linksLine` (Task 2) and both editors destructure it.
