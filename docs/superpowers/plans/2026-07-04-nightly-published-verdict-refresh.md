# Nightly Published-Verdict Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Amended 2026-07-05:** rebased on the multi-report flight-days migration (per-Звіт
> verdicts): `PublishedLog` is keyed by `verdictKey` (`reportKey(date, reportTs)`),
> `computeBackfillPlan` takes a `DayVerdict[]`, and every edit/dedup key is
> report-exact (mirroring `scripts/field-backfill.ts`).

**Goal:** Published verdict Slack messages never go stale — the nightly pipeline re-renders every published report from the fresh verdict report and edits the changed ones.

**Architecture:** A new server-only driver `lib/refreshPublishedDays` reuses the existing pure planner `computeBackfillPlan` (diffs stored text vs fresh `formatDayMessage`, skips overridden/no-verdict/already-current entries) and applies the `update` items via `chat.update`, rewriting the stored text after each edit. `lib/runNightly.ts` calls it per window month right after `publishSettledDays`. Spec: `docs/superpowers/specs/2026-07-04-nightly-published-verdict-refresh-design.md`.

**Tech Stack:** Next.js 16 lib modules (TypeScript strict), Vitest, existing Slack client (`lib/slack.ts` reserve-then-send chokepoint).

## Global Constraints

- `lib/refreshPublished.ts` MUST import `"server-only"` (it writes to Slack); tests rely on the repo's vitest alias that maps `server-only` to an empty module.
- Effectful driver only — all pure logic stays in the existing `lib/backfillPublished.ts` / `lib/verdictPublish.ts`; do not duplicate their logic.
- **Per-report keying:** every published-log lookup, write-back, and outbound dedup key is `reportKey(item.date, item.reportTs)` (the verdictKey) — never a bare date, which on a multi-report day would hit the wrong row (mirror the loop in `scripts/field-backfill.ts:100-118`).
- Idempotency: every Slack edit is keyed `backfillEditKey(reportKey(date, reportTs), contentRev(newText))` and the edited entry is persisted after EACH edit (single-entry `writePublished(period, recordPublished({}, entry))`, the `lib/applyApproval.ts` pattern).
- Never edit an overridden entry (approver strike owns the message) and never rewrite a message to a non-publishable (PENDING) render.
- The dashboard/web surface does not change; `publishSettledDays` and the `field-backfill` CLI behavior do not change (`BackfillItem` gains one additive field).
- SHARED CHECKOUT: stage ONLY your own files via explicit `git add <path>`, NEVER `git add -A`. Peer WIP in tree (`lib/agent/loop.ts`, `lib/agent/loop.test.ts`, `next-env.d.ts`) — leave untouched.
- Run tests with `npx vitest run <file>`; full suite `npm test`; lint `npm run lint`.

---

### Task 1: `lib/refreshPublished.ts` — the refresh driver

**Files:**
- Create: `lib/refreshPublished.ts`
- Modify: `lib/verdictPublish.ts:86-95` (extract `isPublishableStatus`, reimplement `publishableDays` with it)
- Modify: `lib/backfillPublished.ts` (add additive `status` field to `BackfillItem`)
- Modify: `lib/backfillPublished.test.ts` ONLY if an exact-object assertion breaks on the additive field (check with `npx vitest run lib/backfillPublished.test.ts` — expected: still green, the file asserts on projected fields)
- Test: `lib/refreshPublished.test.ts`

**Interfaces:**
- Consumes: `computeBackfillPlan(log: PublishedLog, verdicts: DayVerdict[]): BackfillItem[]` from `lib/backfillPublished.ts` (items carry `date`, `reportTs`, `channel`, `ts`, `oldText`, `newText`, `action`, `reason`); `formatDayMessage(day)` from `lib/verdictPublish.ts`; `readPublished(period)`/`recordPublished(log, entry)`/`writePublished(period, log)` from `lib/published.ts` (log keyed by verdictKey); `updateMessage(channelId, ts, text, {key, feature, channel, trigger})` from `lib/slack.ts`; `backfillEditKey(key, rev)`, `contentRev(text)`, `SendTrigger` from `lib/outboundKeys.ts`; `TRACKED_CHANNELS` from `lib/slackChannels.ts`; `reportKey(date, reportTs)`, `DayVerdict` from `lib/fieldDayVerdict.ts`; `Period` from `scripts/fieldPublishReport.ts`.
- Produces: `isPublishableStatus(status: VerdictStatus): boolean` (exported from `lib/verdictPublish.ts`); `BackfillItem.status: DayVerdict["status"] | null`; `refreshPublishedDays(days: DayVerdict[], period: Period, opts?: {dryRun?: boolean; onLog?: (m: string) => void; trigger?: SendTrigger}): Promise<RefreshResult>` where `RefreshResult = { refreshed: string[]; skipped: { key: string; reason: BackfillReason | "not-publishable" | "untracked-channel" }[] }` — `refreshed`/`skipped[].key` are verdictKeys; in dry-run, `refreshed` lists the entries that WOULD be edited. Task 2 imports `refreshPublishedDays` and `RefreshResult`.

- [ ] **Step 1: Write the failing test**

Create `lib/refreshPublished.test.ts` (same mocking pattern as `lib/publishVerdicts.test.ts` — `vi.hoisted` + partial module mocks):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateMessage, readPublished, writePublished } = vi.hoisted(() => ({
  updateMessage: vi.fn(),
  readPublished: vi.fn(),
  writePublished: vi.fn(),
}));
vi.mock("./slack", () => ({ updateMessage }));
vi.mock("./published", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, readPublished, writePublished }; // keep the real recordPublished
});

import { refreshPublishedDays } from "./refreshPublished";
import { formatDayMessage } from "./verdictPublish";
import type { DayVerdict } from "./fieldDayVerdict";
import type { PublishedEntry } from "./published";

const period = { start: "2026-07-01", end: "2026-07-31" };

// Minimal type-valid verdict; fields overridable per test.
const day = (date: string, over: Partial<DayVerdict> = {}): DayVerdict => ({
  date,
  reportTs: null,
  reportSeq: 1,
  reportCount: 1,
  status: "ACCEPTED",
  airborneMinutes: 20,
  videoMinutes: 40,
  ratio: 2,
  datasetStatus: "POSTED",
  withinGrace: false,
  reasons: [],
  roster: [],
  unknownInitials: [],
  airborneReported: true,
  ...over,
});

const entry = (date: string, text: string, over: Partial<PublishedEntry> = {}): PublishedEntry => ({
  date,
  reportTs: null,
  channel: "field-qa",
  text,
  postedAt: "2026-07-02T04:00:00.000Z",
  ts: `1783.${date.slice(-2)}`,
  ...over,
});

beforeEach(() => {
  updateMessage.mockReset().mockResolvedValue(undefined);
  readPublished.mockReset().mockResolvedValue({});
  writePublished.mockReset().mockResolvedValue(undefined);
});

describe("refreshPublishedDays", () => {
  it("edits a stale published entry and rewrites its stored text", async () => {
    const d = day("2026-07-02");
    readPublished.mockResolvedValue({ "2026-07-02": entry("2026-07-02", "старий текст") });
    const res = await refreshPublishedDays([d], period);

    expect(res.refreshed).toEqual(["2026-07-02"]);
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const [channelId, ts, newText, meta] = updateMessage.mock.calls[0];
    expect(channelId).toBe("C08GY2NKF9D"); // #field-qa
    expect(ts).toBe("1783.02");
    expect(newText).toBe(formatDayMessage(d));
    expect(meta).toMatchObject({ feature: "verdict", channel: "field-qa", trigger: "cron" });
    expect(meta.key).toMatch(/^backfill-edit:2026-07-02:/); // content-rev'd
    // Stored text rewritten (single-entry upsert) so a re-run is a no-op.
    expect(writePublished).toHaveBeenCalledWith(
      period,
      expect.objectContaining({
        "2026-07-02": expect.objectContaining({ text: formatDayMessage(d) }),
      }),
    );
  });

  it("targets the exact report row on a multi-report day (verdictKey, never bare date)", async () => {
    const d1 = day("2026-07-02", { reportTs: "111.1", reportSeq: 1, reportCount: 2 });
    const d2 = day("2026-07-02", { reportTs: "222.2", reportSeq: 2, reportCount: 2 });
    readPublished.mockResolvedValue({
      "2026-07-02#111.1": entry("2026-07-02", "старий 1/2", { reportTs: "111.1", ts: "1783.911" }),
      "2026-07-02#222.2": entry("2026-07-02", formatDayMessage(d2), { reportTs: "222.2", ts: "1783.922" }),
    });
    const res = await refreshPublishedDays([d1, d2], period);

    expect(res.refreshed).toEqual(["2026-07-02#111.1"]);
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const [, ts, newText, meta] = updateMessage.mock.calls[0];
    expect(ts).toBe("1783.911"); // report 1's own message
    expect(newText).toBe(formatDayMessage(d1));
    expect(meta.key).toMatch(/^backfill-edit:2026-07-02#111\.1:/);
    expect(writePublished).toHaveBeenCalledWith(
      period,
      expect.objectContaining({
        "2026-07-02#111.1": expect.objectContaining({ text: formatDayMessage(d1) }),
      }),
    );
  });

  it("persists after EACH edit (mid-run failure loses nothing)", async () => {
    readPublished.mockResolvedValue({
      "2026-07-02": entry("2026-07-02", "старий 02"),
      "2026-07-03": entry("2026-07-03", "старий 03"),
    });
    await refreshPublishedDays([day("2026-07-02"), day("2026-07-03")], period);
    expect(updateMessage).toHaveBeenCalledTimes(2);
    expect(writePublished).toHaveBeenCalledTimes(2);
  });

  it("skips overridden entries — the approver strike owns the message", async () => {
    readPublished.mockResolvedValue({
      "2026-07-02": entry("2026-07-02", "~struck~", {
        override: { decision: "rejected", by: "Oleksandr K", ackedAt: "2026-07-03T00:00:00.000Z" },
      }),
    });
    const res = await refreshPublishedDays([day("2026-07-02")], period);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(res.refreshed).toEqual([]);
    expect(res.skipped).toEqual([{ key: "2026-07-02", reason: "overridden" }]);
  });

  it("skips already-current and no-verdict entries", async () => {
    const d = day("2026-07-02");
    readPublished.mockResolvedValue({
      "2026-07-02": entry("2026-07-02", formatDayMessage(d)), // current
      "2026-07-03": entry("2026-07-03", "текст без вердикту"), // no verdict in report
    });
    const res = await refreshPublishedDays([d], period);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(res.skipped).toEqual(
      expect.arrayContaining([
        { key: "2026-07-02", reason: "already-current" },
        { key: "2026-07-03", reason: "no-verdict" },
      ]),
    );
  });

  it("never rewrites a settled message to a non-publishable (PENDING) render", async () => {
    readPublished.mockResolvedValue({ "2026-07-02": entry("2026-07-02", "старий текст") });
    const res = await refreshPublishedDays(
      [day("2026-07-02", { status: "PENDING", withinGrace: true })],
      period,
    );
    expect(updateMessage).not.toHaveBeenCalled();
    expect(res.skipped).toEqual([{ key: "2026-07-02", reason: "not-publishable" }]);
  });

  it("skips entries whose channel is not tracked", async () => {
    readPublished.mockResolvedValue({
      "2026-07-02": entry("2026-07-02", "старий текст", { channel: "retired-channel" }),
    });
    const res = await refreshPublishedDays([day("2026-07-02")], period);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(res.skipped).toEqual([{ key: "2026-07-02", reason: "untracked-channel" }]);
  });

  it("dry-run: reports would-edit entries but writes nothing", async () => {
    readPublished.mockResolvedValue({ "2026-07-02": entry("2026-07-02", "старий текст") });
    const res = await refreshPublishedDays([day("2026-07-02")], period, { dryRun: true });
    expect(res.refreshed).toEqual(["2026-07-02"]);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(writePublished).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/refreshPublished.test.ts`
Expected: FAIL — `Cannot find module './refreshPublished'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

3a. In `lib/verdictPublish.ts`, replace the `publishableDays` function (keep its doc comment) with:

```ts
/** Statuses the bot will post/keep posted (settled + actionable) — shared by the publish and refresh drivers. */
export function isPublishableStatus(status: DayVerdict["status"]): boolean {
  return (
    status === "ACCEPTED" ||
    status === "NEEDS_REVIEW" ||
    status === "ACCEPTED_EXCEPTION" ||
    status === "REJECTED"
  );
}

/** Days the bot will publish a verdict for (settled + actionable). */
export function publishableDays(days: DayVerdict[]): DayVerdict[] {
  return days.filter((d) => isPublishableStatus(d.status));
}
```

3b. In `lib/backfillPublished.ts`, add the matched verdict's status to `BackfillItem` (additive):

- In the interface, after `overridden: boolean;` add:

```ts
  /** The matched verdict's status; null when no verdict matched (reason "no-verdict"). */
  status: DayVerdict["status"] | null;
```

- In the `if (!verdict)` branch's returned object add `status: null,`.
- In `withReportMeta` add `status: verdict.status`:

```ts
      const withReportMeta = { ...base, reportSeq: verdict.reportSeq, reportCount: verdict.reportCount, status: verdict.status };
```

3c. Create `lib/refreshPublished.ts`:

```ts
/**
 * Refresh already-published verdict messages against a freshly computed verdict
 * report. SERVER-ONLY (edits Slack + rewrites the published log). Mirrors
 * lib/publishVerdicts.ts in shape: pure planning lives in
 * lib/backfillPublished.computeBackfillPlan (edit only when the stored text
 * differs from the fresh formatDayMessage render; skip overridden entries — the
 * approver strike owns the message — plus no-verdict and already-current ones);
 * this is the effectful driver, called by lib/runNightly per window month.
 *
 * Guards beyond the planner: never rewrite a settled message to a
 * non-publishable (⏳ PENDING) render — grace only shrinks, so it should be
 * unreachable, but the write is outward-facing — and skip entries whose channel
 * is no longer tracked. Idempotent: every key is the entry's verdictKey
 * (reportKey(date, reportTs) — report-exact on multi-report days), edits are
 * keyed backfillEditKey(verdictKey, contentRev(newText)), and each edited entry
 * is upserted immediately, so a re-run (or a mid-run failure retried next
 * night) is a no-op.
 */
import "server-only";
import { updateMessage } from "./slack";
import { backfillEditKey, contentRev, type SendTrigger } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { readPublished, recordPublished, writePublished } from "./published";
import { computeBackfillPlan, type BackfillReason } from "./backfillPublished";
import { isPublishableStatus } from "./verdictPublish";
import { reportKey, type DayVerdict } from "./fieldDayVerdict";
import type { Period } from "../scripts/fieldPublishReport";

export interface RefreshSkip {
  /** The entry's verdictKey (reportKey(date, reportTs)). */
  key: string;
  reason: BackfillReason | "not-publishable" | "untracked-channel";
}

export interface RefreshResult {
  /** verdictKeys edited (dry-run: that WOULD be edited). */
  refreshed: string[];
  skipped: RefreshSkip[];
}

export interface RefreshOptions {
  dryRun?: boolean;
  onLog?: (message: string) => void;
  /** Audit-log origin recorded for each edit. Default "cron"; a CLI path passes "cli". */
  trigger?: SendTrigger;
}

export async function refreshPublishedDays(
  days: DayVerdict[],
  period: Period,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const log = opts.onLog ?? (() => {});
  const trigger = opts.trigger ?? "cron";

  const publishedLog = await readPublished(period);
  const refreshed: string[] = [];
  const skipped: RefreshSkip[] = [];
  for (const item of computeBackfillPlan(publishedLog, days)) {
    const key = reportKey(item.date, item.reportTs);
    if (item.action === "skip") {
      skipped.push({ key, reason: item.reason });
      continue;
    }
    if (item.status === null || !isPublishableStatus(item.status)) {
      skipped.push({ key, reason: "not-publishable" });
      continue;
    }
    const channel = TRACKED_CHANNELS.find((c) => c.name === item.channel);
    if (!channel) {
      skipped.push({ key, reason: "untracked-channel" });
      continue;
    }
    if (opts.dryRun) {
      refreshed.push(key);
      log(`field-refresh (dry-run): would update ${key} in #${channel.name}`);
      continue;
    }
    await updateMessage(channel.id, item.ts, item.newText, {
      key: backfillEditKey(key, contentRev(item.newText)),
      feature: "verdict",
      channel: channel.name,
      trigger,
    });
    // Rewrite the stored text so a re-run is a no-op; single-entry upsert after
    // EACH edit so a mid-run failure loses nothing.
    await writePublished(period, recordPublished({}, { ...publishedLog[key], text: item.newText }));
    refreshed.push(key);
    log(`field-refresh: updated ${key} in #${channel.name} (ts ${item.ts})`);
  }
  return { refreshed, skipped };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/refreshPublished.test.ts lib/backfillPublished.test.ts lib/publishVerdicts.test.ts lib/verdictPublish.test.ts`
Expected: PASS (the three existing files stay green — the `BackfillItem.status` field is additive and `publishableDays` behavior is unchanged). If a `backfillPublished.test.ts` exact-object assertion trips on the new field, extend that fixture's expected object with the correct `status` value (do not weaken the assertion).

- [ ] **Step 5: Commit**

```bash
git add lib/refreshPublished.ts lib/refreshPublished.test.ts lib/verdictPublish.ts lib/backfillPublished.ts
# plus lib/backfillPublished.test.ts ONLY if you had to touch it
git commit -m "feat(nightly): refreshPublishedDays — re-render published verdicts, edit stale messages

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire the refresh stage into the nightly + docs

**Files:**
- Modify: `lib/runNightly.ts` (stage-3 loop, `NightlyMonthResult`)
- Modify: `lib/runNightly.test.ts`
- Modify: `CLAUDE.md` (the `npm run field-nightly` bullet)
- Modify: `.claude/skills/field-instructions/SKILL.md` (Gotchas)

**Interfaces:**
- Consumes: `refreshPublishedDays(days, period, {dryRun?, onLog?, trigger?}): Promise<RefreshResult>` from Task 1 (`lib/refreshPublished.ts`); `RefreshResult.refreshed: string[]` (verdictKeys).
- Produces: `NightlyMonthResult` gains `refreshed: string[]` (surfaced through `NightlySummary`; the `field-nightly` CLI prints the summary JSON as-is, no CLI change needed).

- [ ] **Step 1: Write the failing tests**

In `lib/runNightly.test.ts`, add `refreshPublishedDays` to the hoisted mocks and mock the module (existing tests keep passing because the default resolves empty):

```ts
const { syncAllChannels, extractFieldQa, computeVerdicts, publishSettledDays, refreshPublishedDays, openDm, postMessage, readReportJson } =
  vi.hoisted(() => ({
    syncAllChannels: vi.fn(),
    extractFieldQa: vi.fn(),
    computeVerdicts: vi.fn(),
    publishSettledDays: vi.fn(),
    refreshPublishedDays: vi.fn(),
    openDm: vi.fn(),
    postMessage: vi.fn(),
    readReportJson: vi.fn(),
  }));
```

Add after the other `vi.mock` calls:

```ts
vi.mock("./refreshPublished", () => ({ refreshPublishedDays }));
```

In `beforeEach`, add `refreshPublishedDays` to the reset loop's array and default it:

```ts
refreshPublishedDays.mockResolvedValue({ refreshed: [], skipped: [] });
```

Add two new cases inside `describe("runNightly", …)` (fixture note: the `computeVerdicts` mock's `days` array is whatever the existing `beforeEach` sets — assert against that same reference):

```ts
  it("publish: refreshes published entries after publishing and surfaces the keys", async () => {
    refreshPublishedDays.mockResolvedValue({ refreshed: ["2026-07-10"], skipped: [] });
    const res = await runNightly({ publish: true, today: "2026-07-15" });
    expect(refreshPublishedDays).toHaveBeenCalledOnce();
    const [days, period, opts] = refreshPublishedDays.mock.calls[0];
    expect(days).toBe((await computeVerdicts.mock.results[0].value).days); // the fresh verdict report's days
    expect(period).toMatchObject({ start: "2026-07-01" });
    expect(opts?.dryRun).toBeFalsy();
    expect(res.months[0].refreshed).toEqual(["2026-07-10"]);
  });

  it("dry-run: plans the refresh without editing (dryRun: true)", async () => {
    await runNightly({ publish: false, today: "2026-07-15" });
    expect(refreshPublishedDays).toHaveBeenCalledOnce();
    expect(refreshPublishedDays.mock.calls[0][2]).toMatchObject({ dryRun: true });
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run lib/runNightly.test.ts`
Expected: the two new tests FAIL (`refreshPublishedDays` never called / `refreshed` undefined); all existing tests still PASS.

- [ ] **Step 3: Wire the stage in `lib/runNightly.ts`**

Add the import next to the publish import:

```ts
import { publishSettledDays } from "./publishVerdicts";
import { refreshPublishedDays } from "./refreshPublished";
```

Extend `NightlyMonthResult`:

```ts
export interface NightlyMonthResult {
  period: { start: string; end: string };
  extractedDays: number;
  posted: string[];
  skipped: string[];
  /** Published entries (verdictKeys) whose message was re-rendered and edited (dry-run: would be). */
  refreshed: string[];
}
```

In the stage-3 loop, refresh AFTER publishing (a just-posted entry's stored text
equals the fresh render, so the refresh sees it `already-current`):

```ts
      let posted: string[] = [];
      let skipped: string[] = [];
      let refreshed: string[] = [];
      if (opts.publish) {
        ({ posted, skipped } = await publishSettledDays(c.report.days, channel, c.period, { onLog: log }));
        ({ refreshed } = await refreshPublishedDays(c.report.days, c.period, { onLog: log }));
      } else {
        log(`field-nightly (dry-run): would publish settled days for ${c.period.start}..${c.period.end}`);
        ({ refreshed } = await refreshPublishedDays(c.report.days, c.period, { dryRun: true, onLog: log }));
      }
```

And include it in the pushed month result:

```ts
      months.push({
        period: { start: c.period.start, end: c.period.end },
        extractedDays: c.extractedDays,
        posted,
        skipped,
        refreshed,
      });
```

Also extend the module's top doc comment: change `(per window month: publish)` to `(per window month: publish → refresh stale published messages)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/runNightly.test.ts`
Expected: PASS (all existing + 2 new). Then the full suite: `npm test` — all green; `npm run lint` — 0 errors.

- [ ] **Step 5: Update docs**

In `CLAUDE.md`, in the `npm run field-nightly` bullet, extend the pipeline description `… → verdict compute → publish settled verdicts to #field-qa, over the catch-up window …` to:

```
… → verdict compute → publish settled verdicts to #field-qa → refresh already-published messages whose re-rendered text changed (dataset waives, video exceptions, airborne overrides, late data — edits the Slack message in place via lib/refreshPublished.ts, skipping approver-overridden entries), over the catch-up window …
```

In `.claude/skills/field-instructions/SKILL.md`, add to **Gotchas**:

```
- A dataset **waive**, **video** exception, or **airborne** override changes the
  verdict but the published message is only re-rendered by the NIGHTLY refresh
  stage (`lib/refreshPublished.ts`) — expect the Slack edit by the next morning.
  Day rejections / dataset declines strike immediately. For a prior-month day
  outside the nightly window, re-run `field-verdict -- --write` then
  `npm run field-backfill`.
```

- [ ] **Step 6: Commit**

```bash
git add lib/runNightly.ts lib/runNightly.test.ts CLAUDE.md .claude/skills/field-instructions/SKILL.md
git commit -m "feat(nightly): refresh stale published verdict messages after publish

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Verification (after both tasks)

- `npm test` — full suite green.
- `npm run lint` — 0 errors.
- End-to-end (read-only): `npm run field-nightly` (dry-run) — the log should list `field-refresh (dry-run): would update …` lines for any currently-stale entries and the summary JSON should carry `refreshed` per month. No Slack writes in dry-run.
