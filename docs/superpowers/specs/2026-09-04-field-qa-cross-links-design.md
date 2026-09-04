# #field-qa cross-links between per-day bot messages — design

**Date:** 2026-09-04
**Status:** approved (brainstorm), pending implementation plan

## Problem

A flight day in #field-qa produces several unrelated-looking messages:

| node | author | when | today's link to the others |
|---|---|---|---|
| 🛸 drone-count reminder (anchor for pilots' replies) | bot, cron 06:00 UTC | morning | none |
| Звіт (field report) | human pilot | evening | none |
| verdict (✅/⚠️/⛔ per Звіт) | bot, nightly 06:30 UTC | next morning | none — no URL anywhere in the text |
| 💰 bonus breakdown | bot, `field-bonus --notify` (CLI) | days later | inside the verdict thread only |
| monthly summary day line | bot, `field-summary` (CLI / agent) | end of month | links «вердикт · звіт» |

Readers jump between them by scrolling. Every node should carry links to the rest of its day's cluster, and the links must be **added as new nodes appear**, i.e. already-posted messages get edited.

## Decisions (from the brainstorm)

1. **Звіт is a human message** → the bot cannot edit it. Instead the bot posts **one reply in the Звіт thread** («🔗 Вердикт · Дрони · Бонуси · Підсумок») and edits that reply in place as nodes appear.
2. **Cluster = the Kyiv day.** Reminder and summary line are day-level; Звіт, verdict and bonus are per-Звіт. Day-level messages list per-Звіт items with an ordinal when a day has several reports («Звіт 1/2 · Звіт 2/2 · Вердикт 1/2 · Вердикт 2/2»), ordered by Звіт ts. Single-report days render without ordinals.
3. **Cadence:** one `relinkDay` stage runs (a) in the nightly over the catch-up window as the catch-all and (b) at the tail of every post path that creates a node (verdict publish is inside the nightly already; bonus notify, summary post, drone reminder call it directly). No new cron, no webhook.
4. **Derived registry, no new table** (approach A). Nodes are collected from the stores each post already had to write: `published` (verdict ts, Звіт ts), `bonus_notified` (bonus thread reply ts), `outbound_messages` (reminder, Звіт-thread reply, summary chunks). Nothing can drift because nothing is dual-written.
5. **Idempotent by key.** Every edit is keyed by target + `contentRev` of the rendered link line, so an unchanged cluster produces the same key and the `lib/slack.ts` chokepoint dedups it. Re-running the stage is free.
6. **Summary chunks are never edited after posting.** The summary is posted last (end of month) and already renders its links complete at post time (extended with «дрони» and «бонуси»). Only the *reverse* links (reminder / verdict / bonus / Звіт-reply → «Підсумок») are edited in.

Rejected: a `day_messages` registry table (dual-write drift, backfill); event-driven relinking from the Slack webhook (3-second ack, out-of-order events).

## Link line

One trailing **disjoint region** on every bot-owned node, marker `🔗 ` at the start of the last line, each item a Slack link `<url|label>` separated by ` · `:

```
🔗 Звіт · Дрони · Бонуси · Підсумок
```

- Absent nodes are omitted. A node with nothing to link gets no 🔗 line at all (`null`).
- Labels: `Звіт`, `Вердикт`, `Дрони` (the reminder), `Бонуси`, `Підсумок`.
- Self-omission: the verdict never links itself; the bonus reply omits itself **and** the verdict (it already lives in that thread) and links `Звіт · Дрони · Підсумок`; the Звіт-thread reply omits the Звіт.
- URLs come from the shared `permalinkFor(channelId, ts)` in `lib/slack.ts`, against the tracked `field-qa` channel id.
- Region order on the verdict message: body (incl. loss line and any approver strike) → `👥 У полі:` crew suffix → `🛸 Дрони:` line → `🔗` line. The 🔗 line is the **last** line, so the existing "peel exactly one trailing line" splitters keep working once they learn to peel 🔗 first.
- The 🔗 region is edited **even when the verdict is approver-overridden** (`published.override != null`) — the same rule the crew-suffix edit already follows, because the regions are disjoint.

## Components

### `lib/dayLinks.ts` — pure, unit-tested

```ts
type DayNodes = {
  date: string;                       // YYYY-MM-DD Kyiv
  reminderTs?: string;                // drone-reminder:<date> outbound row, status sent
  reports: Array<{                    // ordered by reportTs asc → ordinal 1..N
    reportTs: string;                 // Звіт ts (published.report_ts)
    verdictTs?: string;               // published.ts
    bonusTs?: string;                 // bonus_notified.thread_ts
    zvitReplyTs?: string;             // links-zvit:<reportTs> outbound row, status sent
  }>;
  summary?: { ts: string };           // field-summary chunk containing this day's line
};

collectDayNodes(date, { published, bonusNotified, outboundRows }): DayNodes
renderLinks(target: LinkTarget, nodes: DayNodes, channelId: string): string | null
withLinksRegion(text: string, line: string | null): string
splitLinksRegion(text: string): { rest: string; linksLine: string | null }
planRelink(nodes: DayNodes, current: CurrentTexts, channelId): RelinkEdit[]
```

- `LinkTarget` = `{ kind: "reminder" } | { kind: "verdict" | "bonus" | "zvit"; reportTs }`.
- `RelinkEdit` = `{ target, op: "edit" | "post", channelId, ts?, threadTs?, newText, key }`. `op: "post"` only for a missing Звіт-thread reply.
- `planRelink` emits an edit only when the rendered 🔗 line differs from the one currently on the message (`splitLinksRegion(current).linksLine !== rendered`).
- Keys (added to `lib/outboundKeys.ts`): edit `links-edit:<targetKey>:<contentRev(line)>` where `targetKey` is `reminder:<date>` / `verdict:<date>#<reportTs>` / `bonus:<date>#<reportTs>` / `zvit:<reportTs>`; Звіт-reply post `links-zvit:<reportTs>`; Звіт-reply edit `links-zvit-edit:<reportTs>:<contentRev(line)>`.
- Summary chunk resolution: scan `outbound_messages` rows with `feature = "field-summary"`, `status = "sent"`, part ≠ anchor, whose frozen `text` contains the day's line prefix (the `DD.MM` day label the renderer emits at line start). Exactly one match → `summary.ts`; zero or >1 → omit «Підсумок». Read-only and deterministic.

### `lib/relinkDay.ts` — orchestration (server)

`relinkDays(dates: string[], opts: { publish: boolean; trigger; zvitReply: boolean })`:

1. Read `published`, `bonus_notified`, `outbound_messages` once for the covering period(s); resolve the `field-qa` tracked channel (untracked → refuse, like the other editors).
2. Per date → `collectDayNodes` → `planRelink`.
3. Apply each `RelinkEdit` through the chokepoint: `updateMessage` for edits, `postMessage(threadTs = reportTs)` for the Звіт reply. Each edit is wrapped independently; a failure is recorded `{ target, error }` and the loop continues.
4. On a **verdict** edit, re-read the `published` row first (TOCTOU guard, same as `refreshPublished`: skip `changed-since-plan` if the stored text moved or `override` changed since planning), then after a successful edit rewrite `published.text` with the new text so the nightly refresh compare stays consistent.
5. `updateMessage`/`postMessage` returning `""` (skipped on a stuck `pending` row) counts as `skipped`, not sent; the key is unchanged so the next run retries (a `failed` row is reclaimed by `decideReserve`; a stuck `pending` stays skipped — the same known limitation as elsewhere, visible in the dry-run output).
6. Returns `{ planned, sent, skipped, failed[] }`. Never DMs the operator: cosmetic feature.

Requires one new DB helper: `findSentByKey(key)` in `lib/outbound.ts` (reminder ts, Звіт-reply ts). Summary rows come from `readOutbound(period)` filtered in memory.

### Hooks (all soft-fail: `try/catch`, logged, never block the parent)

- `lib/runNightly.ts`: new stage after `refreshPublishedDays`, over every window date that has at least one node.
- `scripts/field-bonus.ts --notify --publish`: tail, for the notified dates.
- `lib/fieldSummaryPost.ts`: tail after the thread chunks are posted, for the period's dates (reverse links only — the chunks themselves are not edited).
- `lib/droneReminder.ts`: tail after the reminder post, for today (usually a no-op — the Звіт arrives later — but cheap).

### Refresh + region editors must respect the 🔗 region

- `lib/backfillPublished.ts` `computeBackfillPlan`: compare `splitLinksRegion(entry.text).rest !== formatDayMessage(verdict)`; on `update`, re-append the existing 🔗 line to the new text. Otherwise the nightly refresh would strip links every night.
- `lib/applyApproval.ts`, `lib/applyRosterCorrection.ts`, `scripts/field-backfill.ts`, `lib/verdictPublish.ts` splitters (`splitDroneLine`, `splitRosterSuffix`): peel the 🔗 line first, rebuild their own region, re-append 🔗 unchanged. Verify each in implementation with a round-trip test on a text that carries strike + crew + 🛸 + 🔗.
- `formatDayMessage` itself stays link-free; links are a separate region owned only by `relinkDay`.

### Summary renderer

`lib/fieldMonthSummary.ts` day line gains «дрони» (reminder permalink) and «бонуси» (bonus reply permalink) next to the existing «вердикт · звіт», omitted when absent. `assembleSummaryDays` in `lib/fieldSummaryPost.ts` supplies them from the same `collectDayNodes`.

## Two interfaces (CLAUDE.md rule)

- **CLI:** `npm run field-links -- --start YYYY-MM-DD --end YYYY-MM-DD [--publish] [--channel <name>] [--zvit-reply|--no-zvit-reply] [--format table]`. **DRY-RUN by default**: prints, per day, the node table (which nodes exist, their ts) and every planned edit/post with target, key and new 🔗 line; sends nothing. `--publish` applies via `relinkDays`; requires `--channel <name>` (a tracked channel; use a private test channel before #field-qa). Defaults to the current Kyiv month.
- **Web:** `GET /api/field-links?period=<key>` returns the same per-day nodes + planned edits (read-only, computed from the DB; never posts). Rendered as a small «Зв'язки» panel on the Verdict tab: one row per day with present/absent markers per node and a count of pending link edits.

## Rollout

1. Adding a 🔗 region to verdict messages is a **format change**. Per the existing rule (see `field-nightly` in CLAUDE.md), run the manual pass first: `npm run field-links -- --start <month-start> --end <today> --publish --channel <test-channel>`, inspect, then `--channel field-qa`. After that the nightly stage keeps links current.
2. **Backfill of older months** is the operator's call, same CLI with a wider range. Posting new Звіт-thread replies on weeks-old threads bumps them in Slack, so the Звіт reply is **opt-in for backfills**: `--zvit-reply` must be passed explicitly on the CLI; the nightly passes `zvitReply: true` only for dates inside its catch-up window. Edits to already-existing messages never bump a thread and are always allowed.
3. Volume: ~5 edits per flight day, ~150 `chat.update` calls for a full month backfill. Slack `chat.update` is Tier 3 (50+/min); fine.

## Guards

- Edit only bot-owned messages found in `published`, `bonus_notified`, or `outbound_messages` with `status = "sent"`. Never touch a message the stores don't know.
- Звіт-thread reply is posted only for reports that already have a verdict (unparsed / stray messages get no reply).
- Ambiguous summary-chunk match (>1 chunk contains the day prefix) → omit «Підсумок» rather than guess.
- Untracked channel → refuse (`untracked-channel`), matching the other editors.

## Tests (Vitest, pure modules)

- `lib/dayLinks.test.ts`
  - `collectDayNodes`: single report; two reports with ordinals; missing bonus; missing reminder; summary chunk found / zero / ambiguous; ignores `status != sent` rows.
  - `renderLinks` per target: self-omission rules; bonus omits verdict; ordinals only when N > 1; `null` when nothing to link; permalink shape.
  - `withLinksRegion` / `splitLinksRegion`: round-trip on text with strike + crew + 🛸; replaces an existing 🔗 line; removing (`null`) strips it.
  - `planRelink`: unchanged line → no edit; changed line → edit with new `contentRev` key; missing Звіт reply → `op: "post"` keyed `links-zvit:<reportTs>`; `zvitReply: false` suppresses the post but not edits.
- `lib/backfillPublished.test.ts`: refresh compare ignores the 🔗 region; rewrite re-appends it.
- `lib/verdictPublish.test.ts` (+ approval / roster editors): each region editor preserves an existing 🔗 tail.
- `lib/relinkDay.test.ts`: fake sender — per-edit failure continues; `""` counted `skipped`; `published.text` rewritten after a verdict edit; TOCTOU skip when the stored row moved.

## Out of scope

Editing summary chunks after they are posted; links inside per-person DMs; #datasets messages; emoji reactions on the Звіт; relinking triggered from the Slack events webhook.
