# Agent DM context + confirm-first loss write — design

**Date:** 2026-07-07
**Status:** approved (brainstorm with operator)

## Problem

On 2026-07-07 the operator replied «Один знайшли» to the nightly loss-alert DM
and the bot answered with a context-free Jira clarification. Three causes:

1. `lib/agent/slackTurn.ts` had pinned `tools: jiraTools`, hiding
   `field_loss_status` from every Slack surface — **already fixed** (`2e7cb2f`,
   pending deploy; ships with the calendar stack).
2. Bot-sent DMs (nightly alerts, failure notices, bonus DMs) are not recorded
   in the agent's thread memory, so a human reply in the bot DM arrives with no
   context.
3. The agent has no loss-write capability — recovery corrections exist only as
   verdict-thread instructions and the `field-instructions` CLI.

Decisions taken with the operator: fix the gaps in the current architecture
(no Agent SDK replatform — it solves loop machinery we already have and needs
a persistent runtime Vercel Hobby can't host; revisit only for a future rich
chat project). No LlamaIndex — neither gap is a retrieval problem; a future
«answer from history» need would be a separate `history_search` tool over our
own Neon data. Record **all** bot DMs into agent memory (not just loss
alerts). Loss writes via the agent are **approver-gated and confirm-first**.

## 1. Bot DMs become agent memory

At the send chokepoint (`lib/slack.ts` `postMessage`), after a **successful**
send to a DM channel (id starts with `D`) with no `thread_ts`, best-effort
append the sent text as a **bot turn** to the agent-thread memory for that
channel (`agent_threads`, key = the DM channel id — the same `conversationKey`
`handleAgentConversation` reads).

- Reuses the existing memory shape and the 10-turn/24h cap
  (`lib/agentThreadCap.ts`) unchanged; the bot turn is stored with the
  assistant role the agent loop already replays as history.
- Best-effort: an append failure is logged and never affects the send result.
- Applies to every execution point that goes through `postMessage` (webhook,
  cron, local CLI) — no per-feature wiring; new notification types inherit it.
- Threaded DM replies (`thread_ts` set) are out of scope — DM agent
  conversations are flat; only top-level DM sends become memory.

## 2. `field_loss_set` — confirm-first, approver-gated agent write

A write tool in `lib/agent/tools/fieldLoss.ts` beside `field_loss_status`:

- `kind: "write"`, input `{ date: "YYYY-MM-DD", state: "found" | "lost",
  note?: string }`; `propose()` validates the date and returns a `Proposal`
  with a Ukrainian echo, e.g. «🛸 Борт 2026-07-04: знайдено — втрату знято.
  Застосувати? (так/ні)».
- The shared executor (`lib/proposalExecutor.ts`) gains a `field_loss_set`
  case: upsert the `instruction`-source ledger row (day-wide `reportTs ""`,
  `updatedBy` = the requester, note = the stated reason — same shape as a
  manual `field-instructions --loss` correction), then post the existing
  Ukrainian ack into the day's published verdict thread when one exists (the
  explicit activity log; DB `updated_by`/`note` carry it regardless).
- **Approver gate at apply:** the stored agent proposal already carries the
  requester's Slack user id; before applying a `field_loss_set`, the executor
  path refuses (Ukrainian message) unless that user is in `lib/approvers.ts`.
  Non-approvers can ask read questions as before; their loss proposal is
  refused at propose-confirmation time, never applied.
- The CLI twin (`npm run agent -- "…" --yes`) inherits the same executor;
  `--yes` runs as the operator (an approver).
- Ledger precedence (instruction outranks extraction; repeat apply is an
  idempotent same-key upsert) is enforced in `lib/lossStore.ts` — no new
  invariants.

## Error handling

- Memory append: swallowed + logged; a DB outage degrades to today's
  (context-free) behavior, never a failed send.
- Tool: invalid date → tool error text to the model (it reprompts the user);
  apply failure (DB/Slack) → the existing proposal-failure surfacing posts the
  actionable error in the DM.

## Testing

- Chokepoint: DM send appends a bot turn (channel-id key, role, text); channel
  send does not; thread_ts DM send does not; append failure leaves the send
  result intact.
- Memory→loop: a recorded bot turn appears in the next turn's history for the
  same conversationKey (existing agentThread tests extended).
- Tool: propose echo for found/lost; invalid date; executor case writes the
  instruction row + acks in-thread when published entry exists / skips ack
  cleanly when not; approver gate — non-approver confirm refused, approver
  applies; idempotent re-apply.

## Out of scope

- Agent SDK replatform; LlamaIndex / RAG `history_search` tool (possible
  follow-up feature, separately specced).
- Per-report (`reportTs`-scoped) loss writes from the agent — day-wide only,
  matching the manual CLI; report-scoped corrections stay in verdict threads.
- Recording channel (non-DM) bot posts into any memory.
