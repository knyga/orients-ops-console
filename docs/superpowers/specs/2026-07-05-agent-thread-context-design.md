# Agent thread-context injection — design

**Date:** 2026-07-05
**Status:** Approved

## Problem

@mentioning the bot inside an existing Slack thread (e.g. "створи джира тікет з цього треду")
runs the Phase-C.2 agent loop with only the mention text plus the bot's own prior
turns (`agent_threads` memory). The surrounding human thread messages — the actual
context the user is pointing at — never reach the model, so "create a ticket from
this thread" produces a context-free proposal.

The Slack mirror (`data/slack/...`) is a local, git-ignored file store and is not
available on Vercel, so thread context must be fetched live.

## Decision

Auto-inject a capped thread transcript into the agent's question on every
@mention-in-thread turn (and plain-thread-reply follow-ups). No new agent tool;
no extra loop iterations. `jira_create` stays confirm-first; Mr-Lab routing
unchanged.

## Components

### 1. `lib/slack.ts` — `fetchThreadMessages(channelId, threadTs)`

Small server-only helper: one `conversations.replies` page loop for a single
thread (reusing the existing `call` + paging conventions used by
`fetchRawMessages`). Returns `{ ts, user, bot_id?, text }[]` oldest-first.
No new scopes — the mirror sync already uses `conversations.replies`.

### 2. `lib/agent/threadContext.ts`

- `formatThreadContext(messages, opts)` — **pure**, unit-tested. Renders
  `Контекст треду (Slack):` + one `[name]: text` line per message, oldest-first.
  - Excludes `opts.excludeTs` (the incoming mention) and the bot's
    `думаю…` placeholder / any `bot_id` message that equals the placeholder ts.
  - Resolves Slack user IDs to names via the `lib/people.ts` roster; unmapped
    users render as `<@U…>`.
  - Caps: last 40 messages and ~8 000 chars (drop oldest first). Empty result →
    `null` (no block).
- `fetchThreadContext(channelId, threadTs, excludeTs)` — fetch + format glue.

### 3. Wire-in: `app/api/agent/run/route.ts`

When `body.threadTs` is present (mention-in-thread and plain-thread-reply
follow-ups both pass one; DMs do not), fetch the context and prepend the block
to `body.question` before `runSlackTurn`. A fetch failure logs and proceeds
without context — never fails the turn.

Accepted trade-off: on follow-up turns the transcript partially duplicates
agent memory (the bot's own replies appear in both). Harmless token overlap.

### 4. CLI twin: `npm run agent -- --thread <ref>`

`<ref>` is `<channelId>:<ts>`, or a Slack permalink URL
(`…/archives/<CHANNEL>/p<ts-without-dot>`) parsed to the same pair. The CLI
fetches the same context via the same module and prepends it to the message —
identical code path to the Slack surface, testable from the terminal.

## Testing

- Unit: `formatThreadContext` — cap behavior, exclusion, name resolution,
  empty thread, placeholder filtering.
- Unit: permalink parsing for the CLI flag.
- Route test: `POST /api/agent/run` with `threadTs` passes a question carrying
  the transcript to `runSlackTurn`; without `threadTs` the question is
  untouched; a throwing fetch still runs the turn.

## Out of scope

- A `slack_thread_read` agent tool (rejected: burns iterations, model may skip it).
- Filtering memory/transcript overlap.
- Any change to proposal/confirm mechanics or Jira routing.
