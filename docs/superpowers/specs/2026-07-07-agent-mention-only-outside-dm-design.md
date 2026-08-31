# Agent mention-only outside DMs (plain-thread-reply branch narrowed to confirm/cancel)

**Date:** 2026-07-07
**Status:** Approved
**Amends:** `2026-07-02-slack-agent-phase-c2-writes-design.md` (the plain-thread-reply ingress)

## Problem

Since Phase C.2, once a thread is a known agent thread (`agent_threads`), **every**
plain message in it — no @mention — is treated as addressed to the bot. That is
right for «так»/«ні» confirmations, but it also means any later message in the
thread ("додай задачу в наступний спринт", or two humans just talking) launches a
whole new agent turn, supersedes a pending proposal with a «Скасував попередню
пропозицію…» notice, and posts a «🤔 думаю…» placeholder. Observed live on
2026-07-05 in the ATP-1714 thread. The operator wants the bot to act **only when
@mentioned everywhere except DMs**.

## Decision (one rule)

A plain, unmentioned reply in an agent thread can only **confirm or cancel a
pending proposal**. It can never start a new agent turn. New requests and
follow-ups in any channel or thread require @mentioning the bot. DMs stay fully
conversational (unchanged).

## Behavior matrix (surface `"thread"` — plain reply in a known agent thread)

| Situation | Old behavior | New behavior |
|---|---|---|
| Pending proposal + requester replies «так»/«ні» | apply / cancel inline | **unchanged** — apply / cancel inline |
| Pending proposal + requester replies anything else | supersede + notice + new deferred turn | **silently ignore** — no supersede, no notice; the proposal stays PENDING |
| Pending proposal + non-requester replies | ignore (`not-requester`) | **unchanged** |
| No pending proposal | new deferred agent turn (the bug) | **silently ignore** (`mention-required`) |
| Non-allowlisted user's plain reply | Ukrainian refusal post | **silently ignore** — a refusal only fires on @mention or DM |

`dm` and `mention` surfaces are untouched: an @mention with a pending proposal
still supersedes it and starts a new turn.

## Implementation

All in `handleAgentConversation` (`app/api/slack/events/route.ts`): an early
gate for `inp.surface === "thread"`, **before** the event-id claim and the
allowlist refusal, so an ignored bystander message leaves no trace (no
`slack_events_seen` row, no refusal post):

1. `readPendingProposal(conversationKey)` — none → ack `ignored: "mention-required"`.
2. `pending.proposedBy !== userId` → ack `ignored: "not-requester"` (existing reason kept).
3. `classifyDmReply(text) === "other"` → ack `ignored: "mention-required"`.
4. Otherwise fall through to the existing flow (claim event → allowlist →
   confirm/cancel state machine). The gate's pending read duplicates the state
   machine's read; that second read is kept so the dm/mention paths (and the
   "allowlist gate before state machine" invariant) stay byte-identical.

The route-level branch (agentThreadExists → `surface: "thread"`) stays as is —
deleting it would let plain agent-thread replies fall through to the
tracked-channel/S7 handlers; keeping it and acking `ignored` is the explicit
version.

**Untouched by design:** the approver-instruction flow in *verdict* threads
(`applyInstructionReply`) is a separate feature with its own plain-reply
confirm — unchanged.

## Tests (`app/api/slack/events/route.test.ts`)

- Plain thread reply, no pending → ignored: no placeholder, no self-invoke, no
  event claim, no refusal.
- Plain "other" text with pending → proposal stays PENDING: no `setState`, no
  supersede notice, no defer.
- Plain «так»/«ні» by requester with pending → applies/cancels (existing tests keep passing).
- Non-requester plain reply → `not-requester` (existing test keeps passing).
- Non-allowlisted user's plain thread reply → ignored, no refusal post.
- @mention with pending → supersedes + defers (unchanged path).
- The old "second thread reply defers a new turn" test is rewritten to expect ignore.

## Docs

- Route header comment + branch comments updated.
- CLAUDE.md Phase C.2 paragraphs updated (drop "plain thread follow-up starts a
  turn"; plain replies are confirm/cancel-only).

## Amendment (2026-08-31): driver-gating replaces requester-gating

Requester-only gating silently swallowed an approver's «@bot так» on another
user's pending proposal (hit in #issue-log: Bohdan's `jira_create` proposal,
Oleksandr's confirm ignored with no feedback). Fundamental fix:

- **Who can drive a pending proposal outside a DM:** its requester OR any
  `lib/approvers.ts` approver — `canDriveProposal(proposedBy, userId)` in
  `lib/proposalGate.ts` (pure, tested). Applies to both the plain-thread-reply
  confirm path and the mention path's pending-proposal state machine.
- **No more silence for allowed users:** an allowed user whose @mention can't
  drive the pending proposal gets an in-thread «⏳ Є незавершена пропозиція від
  <@requester>…» notice (keyed `agent:<user>:<ts>:wait`) instead of a silent
  ack (`ignored: "not-authorized-for-pending"`). Plain unmentioned bystander
  replies stay silent (no bot noise on thread chatter).
- **Apply-time approver gate evaluates the confirmer:** `gateProposalApply`
  is called with the confirming user's id (was the requester's), so an approver
  confirming someone else's money-affecting proposal passes the gate and their
  own name is injected as `by`.
