# Nightly Published-Verdict Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Published verdict Slack messages never go stale — the nightly pipeline re-renders every published day from the fresh verdict report and edits the changed ones.

**Architecture:** A new server-only driver `lib/refreshPublishedDays` reuses the existing pure planner `computeBackfillPlan` (diffs stored text vs fresh `formatDayMessage`, skips overridden/no-verdict/already-current days) and applies the `update` items via `chat.update`, rewriting the stored text after each edit. `lib/runNightly.ts` calls it per window month right after `publishSettledDays`. Spec: `docs/superpowers/specs/2026-07-04-nightly-published-verdict-refresh-design.md`.

**Tech Stack:** Next.js 16 lib modules (TypeScript strict), Vitest, existing Slack client (`lib/slack.ts` reserve-then-send chokepoint).

## Global Constraints

- `lib/refreshPublished.ts` MUST import `"server-only"` (it writes to Slack); tests rely on the repo's vitest alias that maps `server-only` to an empty module.
- Effectful driver only — all pure logic stays in the existing `lib/backfillPublished.ts` / `lib/verdictPublish.ts`; do not duplicate their logic.
- Idempotency: every Slack edit is keyed `backfillEditKey(date, contentRev(newText))` and the published log is persisted after EACH edit.
- Never edit an overridden day (approver strike owns the message) and never rewrite a message to a non-publishable (PENDING) render.
- The dashboard/web surface does not change; `publishSettledDays` and the `field-backfill` CLI do not change.
- Run tests with `npx vitest run <file>`; full suite `npm test`; lint `npm run lint`.

---

### Task 1: `lib/refreshPublished.ts` — the refresh driver

**Files:**
- Create: `lib/refreshPublished.ts`
- Test: `lib/refreshPublished.test.ts`

**Interfaces:**
- Consumes: `computeBackfillPlan(log, verdictByDate)` from `lib/backfillPublished.ts`; `publishableDays`, `formatDayMessage` from `lib/verdictPublish.ts`; `readPublished`/`recordPublished`/`writePublished` from `lib/published.ts`; `updateMessage(channelId, ts, text, {key, feature, channel, trigger})` from `lib/slack.ts`; `backfillEditKey(date, rev)`, `contentRev(text)`, `SendTrigger` from `lib/outboundKeys.ts`; `TRACKED_CHANNELS` from `lib/slackChannels.ts`; `Period` from `scripts/fieldPublishReport.ts`.
- Produces: `refreshPublishedDays(days: DayVerdict[], period: Period, opts?: {dryRun?: boolean; onLog?: (m: string) => void; trigger?: SendTrigger}): Promise<RefreshResult>` where `RefreshResult = { refreshed: string[]; skipped: { date: string; reason: BackfillReason | "not-publishable" | "untracked-channel" }[] }`. In dry-run, `refreshed` lists the days that WOULD be edited. Task 2 imports `refreshPublishedDays` and `RefreshResult`.

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

// Minimal type-valid verdict; status/dataset overridable per test.
const day = (date: string, over: Partial<DayVerdict> = {}): DayVerdict => ({
  date,
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
  it("edits a stale published day and rewrites its stored text", async () => {
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
    // Stored text rewritten so a re-run is a no-op.
    expect(writePublished).toHaveBeenCalledWith(
      period,
      expect.objectContaining({
        "2026-07-02": expect.objectContaining({ text: formatDayMessage(d) }),
      }),
    );
  });

  it("persists the log after EACH edit (mid-run failure loses nothing)", async () => {
    readPublished.mockResolvedValue({
      "2026-07-02": entry("2026-07-02", "старий 02"),
      "2026-07-03": entry("2026-07-03", "старий 03"),
    });
    await refreshPublishedDays([day("2026-07-02"), day("2026-07-03")], period);
    expect(updateMessage).toHaveBeenCalledTimes(2);
    expect(writePublished).toHaveBeenCalledTimes(2);
  });

  it("skips overridden days — the approver strike owns the message", async () => {
    readPublished.mockResolvedValue({
      "2026-07-02": entry("2026-07-02", "~struck~", {
        override: { decision: "rejected", by: "Oleksandr K", ackedAt: "2026-07-03T00:00:00.000Z" },
      }),
    });
    const res = await refreshPublishedDays([day("2026-07-02")], period);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(res.refreshed).toEqual([]);
    expect(res.skipped).toEqual([{ date: "2026-07-02", reason: "overridden" }]);
  });

  it("skips already-current and no-verdict days", async () => {
    const d = day("2026-07-02");
    readPublished.mockResolvedValue({
      "2026-07-02": entry("2026-07-02", formatDayMessage(d)), // current
      "2026-07-03": entry("2026-07-03", "текст без вердикту"), // no verdict in report
    });
    const res = await refreshPublishedDays([d], period);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(res.skipped).toEqual(
      expect.arrayContaining([
        { date: "2026-07-02", reason: "already-current" },
        { date: "2026-07-03", reason: "no-verdict" },
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
    expect(res.skipped).toEqual([{ date: "2026-07-02", reason: "not-publishable" }]);
  });

  it("skips entries whose channel is not tracked", async () => {
    readPublished.mockResolvedValue({
      "2026-07-02": entry("2026-07-02", "старий текст", { channel: "retired-channel" }),
    });
    const res = await refreshPublishedDays([day("2026-07-02")], period);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(res.skipped).toEqual([{ date: "2026-07-02", reason: "untracked-channel" }]);
  });

  it("dry-run: reports would-edit days but writes nothing", async () => {
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

Create `lib/refreshPublished.ts`:

```ts
/**
 * Refresh already-published verdict messages against a freshly computed verdict
 * report. SERVER-ONLY (edits Slack + rewrites the published log). Mirrors
 * lib/publishVerdicts.ts in shape: pure planning lives in
 * lib/backfillPublished.computeBackfillPlan (edit only when the stored text
 * differs from the fresh formatDayMessage render; skip overridden days — the
 * approver strike owns the message — plus no-verdict and already-current days);
 * this is the effectful driver, called by lib/runNightly per window month.
 *
 * Guards beyond the planner: never rewrite a settled message to a
 * non-publishable (⏳ PENDING) render — grace only shrinks, so it should be
 * unreachable, but the write is outward-facing — and skip entries whose channel
 * is no longer tracked. Idempotent: edits are keyed
 * backfillEditKey(date, contentRev(newText)) and the log is persisted after
 * EACH edit, so a re-run (or a mid-run failure retried next night) is a no-op.
 */
import "server-only";
import { updateMessage } from "./slack";
import { backfillEditKey, contentRev, type SendTrigger } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { readPublished, recordPublished, writePublished } from "./published";
import { computeBackfillPlan, type BackfillReason } from "./backfillPublished";
import { publishableDays } from "./verdictPublish";
import type { DayVerdict } from "./fieldDayVerdict";
import type { Period } from "../scripts/fieldPublishReport";

export interface RefreshSkip {
  date: string;
  reason: BackfillReason | "not-publishable" | "untracked-channel";
}

export interface RefreshResult {
  /** Days edited (dry-run: days that WOULD be edited). */
  refreshed: string[];
  skipped: RefreshSkip[];
}

export interface RefreshOptions {
  dryRun?: boolean;
  onLog?: (message: string) => void;
  /** Audit-log origin recorded for each edit. Default "cron"; the CLI path passes "cli". */
  trigger?: SendTrigger;
}

export async function refreshPublishedDays(
  days: DayVerdict[],
  period: Period,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const log = opts.onLog ?? (() => {});
  const trigger = opts.trigger ?? "cron";

  let publishedLog = await readPublished(period);
  const verdictByDate: Record<string, DayVerdict> = {};
  for (const d of days) verdictByDate[d.date] = d;
  const publishable = new Set(publishableDays(days).map((d) => d.date));

  const refreshed: string[] = [];
  const skipped: RefreshSkip[] = [];
  for (const item of computeBackfillPlan(publishedLog, verdictByDate)) {
    if (item.action === "skip") {
      skipped.push({ date: item.date, reason: item.reason });
      continue;
    }
    if (!publishable.has(item.date)) {
      skipped.push({ date: item.date, reason: "not-publishable" });
      continue;
    }
    const channel = TRACKED_CHANNELS.find((c) => c.name === item.channel);
    if (!channel) {
      skipped.push({ date: item.date, reason: "untracked-channel" });
      continue;
    }
    if (opts.dryRun) {
      refreshed.push(item.date);
      log(`field-refresh (dry-run): would update ${item.date} in #${channel.name}`);
      continue;
    }
    await updateMessage(channel.id, item.ts, item.newText, {
      key: backfillEditKey(item.date, contentRev(item.newText)),
      feature: "verdict",
      channel: channel.name,
      trigger,
    });
    // Rewrite the stored text so a re-run is a no-op; persist after EACH edit
    // so a mid-run failure loses nothing.
    publishedLog = recordPublished(publishedLog, { ...publishedLog[item.date], text: item.newText });
    await writePublished(period, publishedLog);
    refreshed.push(item.date);
    log(`field-refresh: updated ${item.date} in #${channel.name} (ts ${item.ts})`);
  }
  return { refreshed, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/refreshPublished.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/refreshPublished.ts lib/refreshPublished.test.ts
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
- Consumes: `refreshPublishedDays(days, period, {dryRun?, onLog?, trigger?}): Promise<RefreshResult>` from Task 1 (`lib/refreshPublished.ts`).
- Produces: `NightlyMonthResult` gains `refreshed: string[]` (consumed by the `field-nightly` CLI's summary output via `NightlySummary`, no CLI change needed — it prints the JSON summary as-is).

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

In `beforeEach`, add `refreshPublishedDays` to the reset loop and default it:

```ts
refreshPublishedDays.mockResolvedValue({ refreshed: [], skipped: [] });
```

Add the two new cases inside `describe("runNightly", …)`:

```ts
  it("publish: refreshes published days after publishing and surfaces the dates", async () => {
    refreshPublishedDays.mockResolvedValue({ refreshed: ["2026-07-10"], skipped: [] });
    const res = await runNightly({ publish: true, today: "2026-07-15" });
    expect(refreshPublishedDays).toHaveBeenCalledOnce();
    const [days, period, opts] = refreshPublishedDays.mock.calls[0];
    expect(days).toEqual([{ date: "2026-07-14", status: "ACCEPTED" }]); // the fresh verdict report
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
Expected: the two new tests FAIL (`refreshPublishedDays` never called / `refreshed` undefined); the six existing tests still PASS.

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
  /** Already-published days whose message was re-rendered and edited (dry-run: would be). */
  refreshed: string[];
}
```

In the stage-3 loop, refresh AFTER publishing (a just-posted day's stored text
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
Expected: PASS (8 tests). Then run the full suite: `npm test` — expected all green; `npm run lint` — 0 errors.

- [ ] **Step 5: Update docs**

In `CLAUDE.md`, in the `npm run field-nightly` bullet, extend the pipeline description sentence `… → verdict compute → publish settled verdicts to #field-qa, over the catch-up window …` to:

```
… → verdict compute → publish settled verdicts to #field-qa → refresh already-published days whose re-rendered message changed (dataset waives, video exceptions, airborne overrides, late data — edits the Slack message in place via lib/refreshPublished.ts, skipping approver-overridden days), over the catch-up window …
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
- End-to-end (read-only): `npm run field-nightly` (dry-run) — the log should list `field-refresh (dry-run): would update …` lines for any currently-stale July days and the summary JSON should carry `refreshed` per month. No Slack writes in dry-run.
