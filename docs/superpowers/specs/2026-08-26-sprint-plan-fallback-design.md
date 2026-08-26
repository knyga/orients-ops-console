# Sprint-plan fallback post + mention-driven fill-in — design (2026-08-26)

> **Amendment (as shipped, same day).** This spec predates commit `47abb73`
> (anchor + threaded detail refactor), which renamed the primitives the
> Components section references. The implementation maps them as follows:
> `formatCommittedAnchor`/`formatCommittedDetails` → `buildCommittedPost`
> (returns `SprintPost {anchor, details}`); `publishThreaded` → `publishPost`,
> which freezes/replays publish plans (`lib/sprintPublish.ts`) and gained a
> **`rewriteTs` mode** for the fill-in (edit the pending anchor in place instead
> of posting, then claim the anchor key via the new `lib/outbound.claimSentKey`
> so a later cron re-fire dedups instead of posting an orphan duplicate);
> `sprintCommittedThreadKey(slug, i)` → `sprintThreadKey("committed", slug,
> channel, i)`. The fill-in itself ships as `fillSprintPlan` in
> `lib/runSprint.ts`, called by the executor after its guards. Both new keys are
> **channel-scoped**: `sprint-plan-pending:<channel>:<day>`,
> `sprint-plan-filled:<channel>:<slug>`.

## Problem

`runSprintCommit` resolves the board's **active** sprint. When the cron fires in the
gap between one sprint closing and the next one starting, `listSprints(board,"active")`
is empty, the job returns `{status:"no-active-sprint"}`, posts nothing, DMs nobody, and
returns HTTP 200. The miss is invisible until someone notices the absence.

Observed twice on board 1 (ATP):

| Cron fire (UTC)  | prev sprint closed | next sprint started | outcome |
|---|---|---|---|
| Mon 2026-08-10 18:00 | ATP 45 — 10.08 07:39 | ATP 46 — 11.08 04:37 | no commit post; ATP 46 never got a baseline |
| Mon 2026-08-24 18:00 | ATP 47 — 24.08 13:42 | ATP 48 — 24.08 19:27 | no commit post |

The ATP 46 miss cascaded: with no frozen baseline, the following Sunday report resolved
active = ATP 46, hit `no-baseline`, and skipped too. That sprint has no record at all.

Moving the crons to the morning (the 2026-08-26 amendment in
`2026-07-19-sprint-completion-design.md`) narrows the window but does not close it —
sprint rollover is a human action whose time varies by hours.

## What this adds

1. A **fallback anchor post** to #general when `sprint-commit` finds no active sprint,
   so the miss is visible in the same place the plan would have been.
2. A **mention-driven fill-in**: an approver @mentions the bot in that anchor's thread
   once the sprint exists; the agent loop proposes, the approver confirms, and the bot
   freezes the baseline, **rewrites the anchor in place** into the real Committed post,
   threads the per-assignee details under it, and replies in-thread.

Scope is `sprint-commit` only. `sprint-report`'s `no-active-sprint` / `no-baseline`
skips are unchanged.

## Non-goals

- Auto-recovering a missed sprint retroactively (ATP 46 stays unrecorded).
- Changing the cron schedule (the pending `vercel.json` move is separate work).
- Any new DB table. The design deliberately adds no migration.

## Flow

```
Tue 09:00 Kyiv   cron sprint-commit
                 └─ no active sprint
                    └─ post anchor to #general      key: sprint-plan-pending:<YYYY-MM-DD>
                       "📋 План спринту не складено … згадайте мене у цьому треді"

(later, sprint now exists in Jira)

approver         @bot склади план          (reply in the anchor's thread, #general)
                 └─ events route → mention branch → /api/agent/run → runSlackTurn
                    └─ loop → sprint_plan_build.propose({channelId, anchorTs})
                       └─ echo: "📋 Складу план спринту ATP 49 (45 задач) …  (так/ні)"

approver         так
                 └─ gateProposalApply("sprint_plan_build", userId)   ← approver-only
                    └─ applyProposal("sprint_plan_build", params)
                       1. runSprintCommit → freeze baseline, render anchor + details
                       2. updateMessage(anchorTs) → anchor becomes the Committed post
                       3. thread details under anchorTs
                       4. return Ukrainian confirmation → posted as the in-thread reply
```

## Components

### `lib/sprintReport.ts` (PURE, tested)

New `formatNoSprintAnchor(dayKyiv: string): string` — the Ukrainian fallback text.
Pure like its `formatCommittedAnchor` siblings; no Jira, no Slack, no clock.

```
📋 План спринту не складено — на дошці немає активного спринту (<dayKyiv>).
Створіть спринт у Jira і згадайте мене (@bot) у цьому треді — складу план і оновлю це повідомлення.
```

### `lib/outboundKeys.ts` (PURE, tested)

```ts
sprintPlanPendingKey(day: string)  // `sprint-plan-pending:${day}`
sprintPlanFilledKey(slug: string)  // `sprint-plan-filled:${slug}`
```

`sprintPlanPendingKey` is keyed on the run's **Kyiv calendar day**, so a ±59-min cron
re-fire dedups to one post while a genuinely missed following week posts again.
`sprintPlanFilledKey` keys the anchor **edit** and is namespaced apart from
`sprintCommittedKey`, so the edit never collides with a reservation that would skip it
(same reasoning as `backfillEditKey`).

### `lib/runSprint.ts`

- Extract `publishThreaded`'s reply loop into
  `threadDetails(channelId, anchorTs, details, threadKey, trigger)`. `publishThreaded`
  calls it; the fill-in executor calls it directly against an existing anchor.
- `runSprintCommit`: on `no-active-sprint` **and** `opts.publish`, post the fallback
  anchor (no details) under `sprintPlanPendingKey(kyivDay)`. Return type gains
  `{ status: "no-active-sprint"; anchor: string; posted: boolean }` so the CLI dry-run
  prints the exact text it would have sent.
- The existing `opts.sprintId` override already lets the fill-in target a named sprint.

### `lib/outbound.ts`

New reader `findSentByTs(ts: string): Promise<OutboundRow | null>` — one indexed lookup
by the message ts. Used only as the fill-in's safety guard (below).

### `lib/agent/tools/types.ts`

`ProposeContext` gains `channelId?: string` and `threadTs?: string`. Rationale is the
same as the existing `sourceUrl`: a conversation-level fact the loop knows and the model
must not have to relay.

### `lib/agent/tools/sprint.ts` (NEW)

One write tool, `sprint_plan_build`.

- **Input schema:** `{ sprint?: string }` — an optional sprint name or id ("ATP 49",
  "1487"). Omitted means the board's active sprint.
- **`propose(args, ctx)`:**
  - Resolve the target sprint live. None found → **throw** (the loop surfaces the tool
    error and the model relays it): `на дошці ще немає активного спринту — створіть його в Jira і спробуйте знову`.
  - Require `ctx.channelId` + `ctx.threadTs`; missing → throw (a DM has no anchor to
    rewrite, so the tool is only usable from a thread).
  - `params = { channelId, anchorTs: ctx.threadTs, sprintId, sprintName }` — serializable,
    because the proposal survives the Slack confirm round-trip in `agent_proposals`.
  - `echoUk`: `📋 Складу план спринту <name> (<n> задач) і оновлю повідомлення вище. Застосувати? (так/ні)`
    — `<n>` comes from a `fetchSprintIssues(sprintId)` call at **propose** time, so the
    approver confirms against a real count. The apply re-fetches; a scope change between
    propose and confirm is reflected in the baseline, not the echo.
  - `apply: () => applyProposal("sprint_plan_build", params)`

### `lib/proposalExecutor.ts`

New `sprint_plan_build` case, added to the `ProposalKind` union:

1. **Guard.** `findSentByTs(anchorTs)`; proceed only if the row's key starts with
   `sprint-plan-pending:`. Anything else → throw `це повідомлення не є заглушкою плану спринту`.
   Without this, a mention in any other #general thread would rewrite an unrelated bot
   message.
2. `runSprintCommit({ publish: false, sprintId })` — freezes the baseline and returns
   `anchor` + `details`.
3. `updateMessage(channelId, anchorTs, anchor, { key: sprintPlanFilledKey(slug), feature: "sprint", channel: "general", trigger: "webhook" })`.
4. `threadDetails(channelId, anchorTs, details, i => sprintCommittedThreadKey(slug, i), "webhook")`.
5. Return `✅ План спринту <name> складено: <n> задач. Повідомлення вище оновлено.`

Steps 3 and 4 are individually deduped at the `lib/slack.ts` chokepoint, so a retried
apply re-sends only what never landed.

### `lib/proposalGate.ts`

Add `sprint_plan_build` to `APPROVER_GATED_KINDS`, refusal text:
`⛔ Скласти план спринту може лише затверджувач (Oleksandr K або Bohdan Forostianyi).`

The Slack agent surface already refuses non-approvers wholesale; the gate runs on the
Slack confirm path only and is defense in depth there. The CLI `--yes` path is
operator-trusted and deliberately ungated: it runs on a machine that already holds the
JIRA and Slack credentials, so a CLI-side identity check would be theatre.

### Plumbing `channelId` / `threadTs`

- `lib/agent/loop.ts`: `RunAgentOptions` gains both; passed into `tool.propose(...)`
  alongside `sourceUrl`. Registers `sprintTools`.
- `lib/agent/slackTurn.ts`: `opts` gains both, forwarded to `runAgent`.
- `app/api/agent/run/route.ts`: `RunBody` already carries `channelId` and `threadTs`;
  pass them into `runSlackTurn`.
- `scripts/agent.ts`: `--thread <channelId:ts>` already parses both for `permalinkFor`;
  pass them through too, so the CLI drives the same path.

### System prompt

One line in `lib/agent/loop.ts`:
`«Склади план спринту» у треді із заглушкою — це sprint_plan_build (запис із підтвердженням).`

## Two interfaces (CLAUDE.md requirement)

- **Web/Slack:** the cron's fallback post + the mention→confirm→fill-in flow above.
- **CLI:** `npm run sprint -- commit` dry-run prints the fallback anchor text when the
  board has no active sprint (instead of today's bare `no-active-sprint`).
  `npm run agent -- "склади план спринту" --thread <channelId:ts> --yes` runs the whole
  propose→apply path from the terminal against the real anchor.

## Testing

Pure units, following the repo's existing test placement:

- `lib/sprintReport.test.ts` — `formatNoSprintAnchor` text + the mention instruction.
- `lib/outboundKeys.test.ts` — both new builders, and that `sprintPlanFilledKey` does
  not collide with `sprintCommittedKey`.
- `lib/agent/tools/sprint.test.ts` — propose resolves the active sprint; explicit
  `sprint` override; throws with no active sprint; throws without `ctx.threadTs`;
  `params` is JSON-serializable.
- `lib/proposalGate.test.ts` — approver passes, non-approver refused.
- `lib/runSprint.test.ts` — `no-active-sprint` + `publish` posts exactly one anchor and
  zero details, under the pending key (Slack mocked).

## Failure modes

| Case | Behaviour |
|---|---|
| Cron re-fires within the hour | `sprintPlanPendingKey(day)` dedups → one anchor |
| Mention arrives before the sprint exists | tool throws; model relays; anchor stays pending |
| Non-approver mentions the bot | Slack agent surface refuses; gate refuses on apply |
| Mention in an unrelated #general thread | `findSentByTs` guard throws |
| Apply dies after the edit, before the details | retry re-sends only the missing replies |
| Two approvers confirm concurrently | `claimApply` flips PENDING→APPLIED once |
| Anchor filled, then cron fires next week | new Kyiv day → new key → new anchor |

## Deliberately unchanged

The silent-failure gap in `sprint-report` (`no-active-sprint` / `no-baseline` return
`{ok:false}` with no operator DM) stays open. Worth a follow-up, out of scope here.
