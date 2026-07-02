# Slack Conversational Agent — Phase C.2: confirm-first writes over Slack (DM + @mention)

**Date:** 2026-07-02
**Status:** Design approved; implementation pending
**Basis:** Extends `2026-07-02-slack-agent-phase-c-dm-design.md` (DM-only writes) to **both** surfaces.

> **Implementation note:** the DM write path (`/api/agent/run`, `proposalExecutor`, `agentThread`, `agent_proposals`/`agent_threads`) was implemented by a peer session (commits through `c63dc46`). This plan's remaining scope — the `@mention`/thread delta (generalized `handleAgentConversation`, the plain-thread-reply branch, requester-gating, `conversationKey` threaded through `deferAgentTurn`) — was implemented on top of it.

## Problem

Phase C.1 wired the Phase-B agent loop into Slack for **read-only** Q&A: DM + `@mention` route to `lib/agent/slackAgent.ts`, which filters to `kind === "read"` tools. So people can brainstorm / find / ask in Slack, but **cannot create or edit Jira tickets from Slack** — the headline use case (Bohdan: *"тегаєш в #issue-log, говориш хто — і він створює"*) is unmet. Ticket creation exists only via the CLI (`npm run agent`, `npm run jira-write`).

The DM-write design (`phase-c-dm-design.md`) specified confirm-first writes but **DM-only**, explicitly deferring `@mention`-channel writes and the web tab. None of it was built (no `/api/agent/run`, `proposalExecutor`, `agentThread`, `agent_proposals`/`agent_threads`).

## Scope (this increment)

Confirm-first Jira **writes** over Slack on **both** surfaces:
- **DM** (`message.im`) — the conversation is the DM channel.
- **`@mention` in a channel** (`app_mention`) + **thread follow-ups** — the conversation is the thread; Bohdan's `#issue-log` flow.

**Out of scope (deferred):** the web Assistant/audit tab (→ C.3; the existing **Outbound** tab already records every bot send), streaming, and the Phase-B discriminated-union cleanup.

## Decisions (from brainstorming)

| Axis | Decision |
|------|----------|
| Surfaces | **Both** DM and `@mention`-in-channel (+ thread follow-ups). |
| Web tab | **Deferred to C.3.** CLI + Outbound tab satisfy the two-interface rule this increment. |
| Who confirms (channel) | **Only the requester** (the `@mention`/proposal author). A bystander's `так` never applies the write. |
| Execution model | Reused from the DM design: ack fast → `🤔 думаю…` placeholder → fire-and-forget self-invoke `/api/agent/run` → edit placeholder. |
| Proposal storage | Dedicated `agent_proposals` table (not the verdict `proposals` table). |
| Model | `claude-sonnet-5` (Phase B loop), full read+write tool set on the write path. |

## Architecture

### Execution model — ack-then-self-invoke (unchanged from the DM design)

Slack retries any event not 2xx'd within ~3s; the loop runs up to ~50s; `after()` is distrusted in this codebase (see `events/route.ts` header). So:

1. **`app/api/slack/events/route.ts`** (fast, <3s): verify signature → `claimSlackEvent(eventId)` → classify → for a new agent turn, post a `🤔 думаю…` placeholder, capture its `ts`, fire a **non-awaited** `fetch` to `/api/agent/run`, return 200.
2. **`app/api/agent/run/route.ts`** (new; `runtime="nodejs"`, `dynamic="force-dynamic"`; the 60s function): does the slow loop, edits the placeholder.

Fire-and-forget via `lib/selfOrigin.ts` (derive origin from request/`VERCEL_URL`); attach `.catch` that logs; the webhook still 200s if the fetch throws synchronously (placeholder stays `🤔 думаю…` — visible, debuggable, never a Slack retry).

### Unified conversation model — `conversationKey`

The single extension over the DM design: memory and proposals are **surface-aware** via one key.

| Surface | `conversationKey` | Rationale |
|---|---|---|
| DM | the DM `channelId` | the DM channel *is* the conversation |
| `@mention` in channel | the `thread_ts` (a top-level mention's own `ts`) | the thread *is* the conversation |

### Multi-turn memory — `agent_threads`

- Table `agent_threads`: `conversationKey` (PK), `surface` (`"dm" | "thread"`), `channelId`, `threadTs` (nullable — null for DM), `updatedAt`, `transcript` (jsonb).
- **Transcript = lightweight text turns only:** `Array<{role:"user"|"assistant", text:string}>`. Not raw `tool_use`/`tool_result`/`thinking` (stale, bloated, replay-fragile). Tools re-run fresh each turn.
- **On a turn:** load → drop >24h, keep last 10 → seed as prior `messages` → append new user turn → `runAgent` → persist `[…prior, {user}, {assistant final text}]` (capped on write). Cap logic is a pure, unit-tested helper.
- `lib/agentThread.ts`: `loadTranscript(conversationKey)`, `appendTurn(conversationKey, surface, channelId, threadTs, userText, assistantText)`.

### Confirm-first — `agent_proposals` (persist the action, not the closure)

Phase B's `Proposal.apply()` is an in-memory closure that cannot survive the round-trip to a later `так` (separate event → separate invocation). Persist the **resolved structured action** and rebuild the apply deterministically.

- Table `agent_proposals`: `id`, `conversationKey`, `channelId`, `threadTs` (nullable), `kind` (`jira_create|jira_comment|jira_transition|jira_update`), `params` (jsonb — resolved action, e.g. `{projectKey, summary, description, assigneeAccountId}`), `summaryUk`, `proposedBy` (Slack userId), `state` (`PENDING|APPLIED|CANCELLED|SUPERSEDED`), `createdAt`, `resolvedAt`. **Partial unique index: at most one `PENDING` per `conversationKey`.**
- `lib/proposalExecutor.ts`: `applyProposal({kind, params}): Promise<string>` — deterministic switch calling `lib/jira.ts` (Phase A) write fns, returning the Ukrainian result line. **This same executor backs the CLI `--yes` path** (`scripts/agent.ts` builds `params` from the Phase B `Proposal` and calls `applyProposal`) — one apply for CLI + Slack.
- `Proposal` (Phase B `lib/agent/tools/types.ts`) gains `params: Record<string, unknown>` alongside `kind`/`echoUk`, so the resolved action can be persisted. `apply()` stays for the CLI in-memory path, now equivalent to `applyProposal({kind, params})`. Backward-compatible.

### Ingress routing — three fast branches

1. **`message.im` (DM):** help (`formatDmHelp` — empty/greeting/`help`/`допомога`/`?`, deterministic) → allowlist gate (`allowedUserFor`) → **pending-proposal check** → else new-turn self-invoke.
2. **`app_mention` (channel):** allowlist gate → upsert an **agent thread** keyed by `thread_ts` (own `ts` if top-level) → post placeholder in-thread → self-invoke. (C.1 routes `app_mention` read-only; C.2 flips it to the full read+write path, keeping C.1's guard that a mention which is a reply under a verdict/ask thread defers to S6/S7.)
3. **thread reply** (`message` with `thread_ts`, non-bot, allowlisted): verdict/ask thread → **S6/S7** (existing); **agent thread** (in `agent_threads`) → pending-proposal check → else new-turn self-invoke; otherwise ignore.

### Confirm-first state machine (per `conversationKey`, requester-gated)

On each incoming message, **after** help/allowlist and **before** a new turn, look up the PENDING proposal for the `conversationKey`:

| Condition | Action |
|---|---|
| author ≠ `proposedBy` (channel bystander) | **no-op for confirm** — never applies another person's write; a non-requester thread reply is ignored in v1 |
| `так`/`ок`/`+`/👍 by requester | atomic `PENDING→APPLIED` claim (redelivered `так` → no-op) → `applyProposal` → edit/post `✅ <result>` — **inline, 200-acked** (fast Jira write) |
| `ні`/`скасуй`/👎 by requester | `PENDING→CANCELLED` → `Скасовано.` |
| anything else by requester | `PENDING→SUPERSEDED` → `Скасував попередню пропозицію, обробляю новий запит.` → new agent turn (self-invoke) |

In a DM the author is always the requester → collapses to the DM design's linear machine. Classifier `lib/agentConvo.ts` (help/confirm/cancel keyword sets incl. Ukrainian variants) is pure + unit-tested. Confirm/cancel are fast (single Jira write / status flip) → handled **inline** in the webhook. Only the new-turn branch self-invokes.

### `/api/agent/run` (the 60s runner)

Body `{surface, conversationKey, channelId, threadTs?, userId, placeholderTs}`, authed by the `x-agent-secret` header (`AGENT_RUN_SECRET`; never called by Slack). It:
- checks `ANTHROPIC_API_KEY` up front → missing → `updateMessage` the placeholder with a clear Ukrainian error + `console.error` (**fail loud**), return.
- `loadTranscript` → seed prior `messages` → `runAgent(text, { tools: <full read+write>, maxIters })`.
- **text/error result** → `updateMessage` the placeholder with the answer; `appendTurn`.
- **proposal result** → `updateMessage` the placeholder with the Ukrainian echo (showing the resolved project — Mr Lab transparency); persist a PENDING `agent_proposals` row; `appendTurn`.

### Phase-B carry-forward handled

The loop executes reads inline and **stops at the first write `tool_use`** to propose — so a "search-then-create" flow works across iterations. The hazard is only a single model message that *parallelizes* a read + a write (the read's `tool_result` is dropped). The system prompt instructs the model: **never emit a read tool and a write tool in the same turn.** Documented as a known constraint.

### Idempotency (3 layers, all existing mechanisms)

1. `claimSlackEvent(eventId)` — the whole event is processed at most once.
2. The `PENDING→APPLIED` conditional UPDATE — a write applies at most once even if layer 1 is bypassed by redelivery.
3. `lib/slack.ts` reserve-then-send — no duplicate outbound message/edit.

## Components (files)

- **New:** `app/api/agent/run/route.ts`; `lib/agentThread.ts` (+ pure cap helper); `lib/proposalExecutor.ts`; `lib/agentConvo.ts` (deterministic classifier: help/confirm/cancel; pure); `lib/selfOrigin.ts`; `agent_threads` + `agent_proposals` in `lib/schema.ts` (+ Drizzle migration).
- **Modified:** `app/api/slack/events/route.ts` (mention → read+write; thread-reply agent-thread branch; DM pending-proposal + new-turn self-invoke); `lib/agent/tools/types.ts` + `lib/agent/tools/jira.ts` (add `params` to `Proposal`); `lib/agent/slackAgent.ts` (offer read+write tools on the write path; keep a read-only entry if still used); `scripts/agent.ts` (apply via `applyProposal`); `CLAUDE.md`.
- **Reused unchanged:** `lib/agent/loop.ts`, `lib/slack.ts` (`postMessage`/`updateMessage`/`openDm`), `lib/slackEventClaim.ts`, `lib/allowedUsers.ts`, `lib/agent/access.ts`, `lib/dmHelp.ts`, `lib/slackEventParse.ts`, `lib/jira.ts`, `lib/jiraRouting.ts`.

## Error handling

- Missing `ANTHROPIC_API_KEY` in `/api/agent/run` → visible placeholder-edit error + log (fail loud; the console has been bitten by the silent no-op).
- `runAgent` throws → placeholder edited with Ukrainian "сталася помилка" + log; no proposal persisted.
- `applyProposal` throws (Jira 4xx/5xx) → proposal stays claimed (APPLIED) but posts the error; a human re-issues.
- The webhook always returns 200 to Slack (a sustained 5xx disables the subscription); failures surface in Slack + logs, never via Slack retries.

## Testing (pure libs + mocked clients, per the vitest `server-only`-alias pattern)

- `lib/agentConvo.ts` — help/confirm/cancel classification incl. Ukrainian variants + greeting set (pure).
- `agent_threads` cap helper — 24h window + last-10 (pure).
- `lib/proposalExecutor.ts` — each `kind` calls the right `lib/jira.ts` fn with stored `params` (mocked `fetch`); Mr-Lab create asserts `assigneeAccountId: null` + description prefix.
- events branches (mocked deps): DM help/gate/pending/new-turn; `app_mention` gate → placeholder + self-invoke (assert the non-awaited fetch); thread-reply verdict→S6/S7 vs agent-thread routing; **the requester-≠-`proposedBy` no-op**.
- `/api/agent/run` (mocked `runAgent` + `updateMessage`): text edits placeholder; proposal persists a PENDING row + edits; missing-key fails loud.

## Phasing (one spec, three implementation phases)

- **C2.1** — `agent_threads` + `agent_proposals` schema (+ migration), `lib/proposalExecutor.ts`, `Proposal.params`, and `scripts/agent.ts` sharing the executor. CLI still fully drives create/edit; nothing Slack-facing yet.
- **C2.2** — `lib/agentThread.ts` (memory + pure cap helper), `lib/selfOrigin.ts`, `app/api/agent/run/route.ts`. Runner drivable via a direct authed POST in tests.
- **C2.3** — `lib/agentConvo.ts` + events ingress (mention read+write, thread-reply agent branch, DM pending/new-turn) + requester-gated confirm machine.

## Open items (operator input, not code)

- Slack app: subscribe `message.im`; confirm `app_mention`; scopes `im:history`, `im:read`, `im:write`, `app_mentions:read`.
- Set `AGENT_RUN_SECRET` on Vercel (internal self-invoke auth).
- Set `JIRA_MRLAB_PROJECT` before a real Mr-Lab create confirms (Phase A/B carry-forward; default project is `ATP`, hardcoded).
