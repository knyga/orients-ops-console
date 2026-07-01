# Slack DM `/help` — help-on-any-DM

**Date:** 2026-07-01
**Status:** approved

## Problem

The bot's DM ("Messages") tab is now enabled, so a human can type to the bot in a
DM. Today a DM does nothing: `parseSlackEvent` requires a `thread_ts`, so a
top-level DM message falls into `skip: "filter"` and the webhook never reacts.
We want the bot to answer a DM with a short Ukrainian cheat sheet explaining what
it is and how an approver actually works with it (replies in a verdict thread).

Note: Slack reserves `/help`, so a custom slash command of that name is
impossible. The trigger is therefore a plain DM message, reusing the `message.im`
events already subscribed.

## Behavior

- Any DM to the bot → it replies **once** with the help text. Keyword messages
  ("help" / "допомога" / "довідка" / "?") are ordinary DMs and get the same reply;
  there is no keyword matching — every DM is effectively "help me".
- The bot's own messages are already filtered (`!e.bot_id && !e.subtype`), so the
  reply never triggers another reply (no echo loop).
- Redelivery of the same Slack event dedups (event-id claim + outbound key), so a
  single DM yields exactly one reply; a *new* DM re-replies.
- Info-only: a DM never mutates verdict data. Real changes stay in verdict threads
  (unchanged approver-instruction path).

## Components

All logic lives in pure `lib/` modules; the route and CLI are thin consumers.

1. **`lib/slackEventParse.ts`** — add `channel_type?: string` to the event
   envelope and a new parsed kind:
   `{ kind: "dm"; eventId: string | null; channelId: string; userId: string; text: string }`.
   A `message` with `channel_type === "im"`, no `subtype`, no `bot_id`, and a
   `user` + `ts` + `channel` → `dm`. The existing thread-reply ("actionable")
   branch is unchanged and still requires `thread_ts`. The DM check comes first so
   a DM is never misclassified as a channel reply.

2. **`lib/dmHelp.ts`** (new, pure) — `formatDmHelp(): string` returns the
   Ukrainian text: what the bot is (posts per-day field-verdicts to #field-qa) and
   that an **approver** can reply *in a verdict thread* to change the crew,
   accept/reject a day, or set airborne minutes, with 2–3 example phrasings.
   No IO — unit-tested.

3. **`app/api/slack/events/route.ts`** — a new branch **before** the
   `TRACKED_CHANNELS` lookup (a DM channel is not a tracked channel): on
   `parsed.kind === "dm"`, claim the `event_id` via `claimSlackEvent` (redelivery
   dedup), then `postMessage(channelId, formatDmHelp(), meta)` back to the DM
   channel — the event's `channel` is already the DM id, so no `openDm` is needed.
   Recorded through the normal `sendTracked` chokepoint. Ack 200 as usual.

4. **`lib/outboundKeys.ts`** — `dmHelpKey(userId, ts)` → `help:<userId>:<ts>`,
   keyed on the incoming message ts so each distinct DM gets exactly one reply.
   Audit row uses `feature: "help"`, `channel: "dm"`.

5. **CLI (required second interface)** — `scripts/dmHelp.ts` + `npm run dm-help`
   prints `formatDmHelp()` so the exact text is verifiable from the terminal
   without Slack. Shares the same `lib/dmHelp.ts` code path as the webhook.

## Testing

- `parseSlackEvent`: an `im` message → `kind: "dm"` with the right fields; a bot
  DM (`bot_id`) or a subtype DM → `skip`; a channel thread reply still →
  `actionable` (no regression).
- `formatDmHelp()`: contains the key Ukrainian phrases (verdict thread, crew,
  accept/reject, airborne).

## Out of scope

No slash command, no DM-driven actions, no rate limiting beyond event-id +
outbound-key dedup.
