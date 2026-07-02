# Slack Conversational Agent — Phase C: DM ingress (answer + confirm-first write)

**Problem.** The bot replies to every DM with a static Ukrainian help card (`app/api/slack/events/route.ts`, `message.im` branch → `formatDmHelp()`). A DM like *"what did the team do today based on Jira"* gets the cheat sheet, never an answer. Phase B built the real agent loop (`lib/agent/loop.ts` + Jira tools + `npm run agent`), but only in the terminal. Phase C wires that loop into DMs so the bot actually answers — and can create/route a Jira ticket confirm-first — while respecting Slack's 3-second ack and Vercel Hobby's 60-second function cap.

**Scope (this increment).** DM only (`message.im`). Reads **and** writes. Multi-turn memory per DM. Gated by the console allowlist. No `@mention`-in-channel, no web Assistant tab, no streaming (all deferred).

## Requirements (settled in brainstorming)

- **Routing.** A DM whose text is empty / a greeting / `help` / `допомога` / `?` → the existing `formatDmHelp()` card (unchanged, keyed by incoming ts for redelivery dedup). Anything else → the agent path. Classification is **deterministic** (a small keyword set), no LLM.
- **Access gate.** The agent path is gated by `allowedUserFor(userId)` (`lib/allowedUsers.ts`) — the same allowlist that gates the dashboard. Not allowed → one Ukrainian "немає доступу" reply; no loop, no self-invoke, no thread state.
- **Reads + writes, confirm-first.** A read answers directly. A write posts the Ukrainian proposal echo and applies **only** after the user confirms (`так`/`ок`/`+`/👍); `ні`/👎 cancels; any other message supersedes the pending proposal and starts a fresh turn.
- **Multi-turn memory.** A DM conversation remembers prior turns (per DM channel), so follow-ups keep context.
- **Fail loud.** Missing `ANTHROPIC_API_KEY` surfaces a visible DM error, never a silent no-op (the console has been bitten by this before).

## Architecture

### Execution model — ack-then-self-invoke (the crux)

Slack retries any event it doesn't see 2xx'd within ~3s; the agent loop runs up to ~50s. So the slow work cannot happen inside the webhook. Chosen model (approach A of three considered; `after()` rejected — the codebase already found it unreliable on Vercel, see `events/route.ts` header comment; inline rejected — a >3s loop triggers Slack retries):

1. **`app/api/slack/events/route.ts`** (`message.im` branch, fast — must finish < 3s):
   - verify signature (existing) → `claimSlackEvent(eventId)` (existing; redelivery → no-op) → parse DM (existing `parseSlackEvent` → `kind: "dm"`).
   - **help route** → `formatDmHelp()` (unchanged).
   - **not allowed** → post the "немає доступу" reply, done.
   - **pending proposal on this channel?** (confirm/cancel is a *fast* Jira write, < 3s) → handle **inline** and 200-ack (mirrors the existing approver-apply path).
   - **new agent turn** (slow) → post a `🤔 думаю…` placeholder, capture its `ts`, then fire a **fire-and-forget** POST to `/api/agent/run` and return 200 immediately.

2. **`app/api/agent/run/route.ts`** (new; `runtime = "nodejs"`, `dynamic = "force-dynamic"`, the 60s function): body `{channelId, userId, incomingTs, placeholderTs}`, authenticated by an **internal shared secret** header (`AGENT_RUN_SECRET`) — this route is never called by Slack, only by our own webhook. It:
   - checks `ANTHROPIC_API_KEY` up front; missing → `updateMessage` the placeholder with a clear error + `console.error`, return.
   - loads the DM transcript (`agent_threads`), seeds it as prior `messages`, runs `runAgent`.
   - **text/error result** → `updateMessage` the placeholder with the answer; persist the turn.
   - **proposal result** → `updateMessage` the placeholder with the Ukrainian echo; persist a PENDING `agent_proposals` row for this channel; persist the turn.

The placeholder edit doubles as immediate user feedback and as the message the answer lands in (one message per turn, no chat spam).

### Fire-and-forget invocation

The webhook calls `fetch(<self-origin>/api/agent/run, {method:"POST", headers:{x-agent-secret}, body})` **without awaiting** (attach a `.catch` that logs). On Vercel, an un-awaited fetch to our own function reliably starts a second invocation. Self-origin is derived from the request URL / `VERCEL_URL` (a small `lib/selfOrigin.ts` helper). If the fetch itself throws synchronously (misconfig), the webhook still 200s (Slack must not retry) and the placeholder stays as `🤔 думаю…` — a visible, debuggable failure, not a silent one.

### Multi-turn memory — `agent_threads`

A DM has no Slack threads; the channel *is* the conversation. Memory is keyed by DM channel.

- Table `agent_threads`: `channelId` (PK), `updatedAt`, `transcript` (jsonb).
- **Transcript = lightweight text turns only:** `Array<{role: "user"|"assistant", text: string}>`. **Not** raw `tool_use`/`tool_result`/`thinking` blocks — tool results (Jira dumps) go stale and bloat the row, and storing `thinking` blocks drags in same-model replay rules. Tools re-run fresh each turn, so answers are always current.
- **On a turn:** load transcript → drop turns older than 24h and keep the last 10 → seed as prior `messages` → append the new user turn → `runAgent` → persist `[…prior, {user}, {assistant final text}]` (capped again on write). Older-than-24h or empty → a fresh conversation. No explicit "clear" command in v1.
- `lib/agentThread.ts`: `loadTranscript(channelId)`, `appendTurn(channelId, userText, assistantText)` (pure-ish DB accessors; the cap logic is a pure helper, unit-tested).

### Confirm-first — `agent_proposals` (persist the action, not the closure)

Phase B's `Proposal.apply()` is an in-memory closure — it cannot survive the round-trip between the proposal message and the later `так` (separate Slack event → separate invocation). Phase C persists the **resolved structured action** and rebuilds the apply deterministically.

- New table `agent_proposals`: `id`, `channelId`, `kind` (`jira_create|jira_comment|jira_transition|jira_update`), `params` (jsonb — the resolved action, e.g. `{projectKey, summary, description, assigneeAccountId}`), `summaryUk`, `proposedBy` (userId), `state` (`PENDING|APPLIED|CANCELLED|SUPERSEDED`), `createdAt`, `resolvedAt`. Partial unique index: at most one `PENDING` row per `channelId`.
  - **Decision — a dedicated table, not the existing `proposals` table.** The verdict `proposals` table (`lib/schema.ts`) has NOT NULL `date`/`axis`/`threadTs` and verdict-specific semantics; overloading it for Jira-write proposals would pollute it with nullable columns and blur two concerns. The confirm-first *pattern* (PROPOSED→CONFIRMED/CANCELLED/SUPERSEDED + idempotent claim) is reused; the storage is separate. (This refines the Phase B plan's offhand "generalize `proposals`" note, now that the actual schema is visible.)
- `lib/proposalExecutor.ts`: `applyProposal({kind, params}): Promise<string>` — a deterministic switch over `kind` calling `createIssue`/`addComment`/`transitionIssue`/`updateIssue` (Phase A `lib/jira.ts`), returning the Ukrainian result line. **This same executor backs the CLI `--yes` path** — `scripts/agent.ts` builds `params` from the Phase B `Proposal` and calls `applyProposal`, so CLI and Slack share one apply.
- `Proposal` (Phase B `lib/agent/tools/types.ts`) gains a `params: Record<string, unknown>` field alongside `kind`/`echoUk` so the resolved action can be persisted. `apply()` stays for the CLI's in-memory path but is now equivalent to `applyProposal({kind, params})`. (Small, backward-compatible extension.)

### Confirm-first state machine (linear DM)

On each incoming DM, **after** the help/allowlist checks and **before** routing to a new agent turn, check for a PENDING `agent_proposals` row on this channel:

| Incoming text | Action |
|---|---|
| `так` / `ок` / `+` / 👍 (deterministic set) | atomically claim `PENDING→APPLIED` (redelivered `так` → no-op); `applyProposal`; `updateMessage`/post `✅ <result>` |
| `ні` / `скасуй` / 👎 | `PENDING→CANCELLED`; post `Скасовано.` |
| anything else | `PENDING→SUPERSEDED`; post `Скасував попередню пропозицію, обробляю новий запит.`; process as a **new agent turn** (self-invoke) |

Confirm and cancel are **fast** (a single Jira write or a status flip) → handled **inline** in the webhook, 200-acked directly. Only the "new turn" branch self-invokes. The atomic `PENDING→APPLIED` claim (a conditional UPDATE) is the write-idempotency guard against Slack redelivery.

### Idempotency (layers)

1. `claimSlackEvent(eventId)` at the webhook — the whole DM is processed at most once.
2. The `PENDING→APPLIED` conditional claim — a write applies at most once even if the event-id layer is bypassed.
3. The existing `lib/slack.ts` reserve-then-send dedup on every outbound message/edit.

### CLI twin (two-interface rule)

`npm run agent` continues to work and now shares the deterministic executor. No Slack code in the CLI. `npm run agent -- "…"` (read) and `-- "…" --yes` (write via `applyProposal`) remain the primary manual harness.

## Components (files)

- **New:** `app/api/agent/run/route.ts` (self-invoked runner), `lib/agentThread.ts` (+ pure cap helper), `lib/proposalExecutor.ts`, `lib/agentDm.ts` (deterministic DM classifier: help / confirm / cancel; pure, unit-tested), `lib/selfOrigin.ts`, `agent_threads` + `agent_proposals` in `lib/schema.ts`.
- **Modified:** `app/api/slack/events/route.ts` (the `message.im` branch: help → gate → pending-proposal → new-turn/self-invoke), `lib/agent/tools/types.ts` + `lib/agent/tools/jira.ts` (add `params` to `Proposal`), `scripts/agent.ts` (apply via `applyProposal`), `CLAUDE.md`.
- **Reused unchanged:** `lib/agent/loop.ts`, `lib/slack.ts` (`postMessage`/`updateMessage`/`openDm`), `lib/slackEventClaim.ts`, `lib/allowedUsers.ts`, `lib/dmHelp.ts`, `lib/jira.ts`, `lib/jiraRouting.ts`.

## Error handling

- Missing `ANTHROPIC_API_KEY` in `/api/agent/run` → visible placeholder-edit error + log (fail loud).
- `runAgent` throws → placeholder edited with a Ukrainian "сталася помилка" + log; no proposal persisted.
- `applyProposal` throws (Jira 4xx/5xx) → the proposal stays claimed (APPLIED) but posts the error; a human re-issues. (Matches the "don't silently swallow" webhook stance.)
- The webhook always returns 200 to Slack (a 5xx makes Slack retry and, sustained, disables the subscription); failures surface in the DM + logs, not via Slack retries.

## Testing (pure libs + mocked clients, per the vitest `server-only`-alias pattern)

- `lib/agentDm.ts` — help/confirm/cancel classification incl. Ukrainian variants and the greeting set (pure).
- `agent_threads` cap helper — 24h window + last-10-turns (pure).
- `lib/proposalExecutor.ts` — each `kind` calls the right `lib/jira.ts` function with the stored `params` (mocked `fetch`); Mr-Lab create asserts `assigneeAccountId: null` + description prefix.
- The events `message.im` branch — mocked deps: help route, not-allowed route, pending-proposal confirm/cancel/supersede branches, new-turn fires the self-invoke (assert the fetch, not awaited).
- `/api/agent/run` — mocked `runAgent` + `updateMessage`: text result edits the placeholder; proposal result persists a PENDING row + edits; missing-key fails loud.

## Open items (operator input, not code)

- Slack app: subscribe `message.im`; scopes `im:history`, `im:read`, `im:write` (some already present for the help feature — confirm).
- Set `AGENT_RUN_SECRET` on Vercel (new env var for the internal self-invoke auth).
- `JIRA_MRLAB_PROJECT` must be set before a real Mr-Lab create confirms (Phase A/B carry-forward).

## Deferred (not this increment)

- `@mention`-in-channel ingress (`app_mention`) and the second (threaded) confirm-first shape.
- Web Assistant/audit tab.
- Streaming responses in Slack (the placeholder-edit + 50s budget make it unnecessary).
- Narrowing `Tool`/`AgentResult` to discriminated unions on `kind` (Phase B carry-forward cleanup).
- Handling a single model turn that mixes a read + a write tool_use (Phase B carry-forward: the loop currently stops at the write and drops the read; acceptable while turns stay simple, revisit if it surfaces).
