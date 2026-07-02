# Slack Conversational Agent — Phase C.2: confirm-first DM writes + memory + safe execution

**Supersedes** the earlier full-Phase-C draft in this file. Phase **C.1** already shipped on `main` (commits `e92aa3f..91b6405`): read-only Q&A in Slack via **DM + @mention**, allowlist-gated (`lib/agent/access.ts`), through `lib/agent/slackAgent.ts` `askAgent` (read-only tool filter, fail-loud), wired in `app/api/slack/events/route.ts` (`runAgentReply`). So *answering* a DM question is done. C.1 explicitly deferred **writes**, **multi-turn memory**, and left the loop running **inline** in the webhook.

Phase C.2 adds the deferred pieces **and** fixes the one unsafe property of C.1.

## The safety problem C.2 must fix (decided: "do what's safe")

C.1 runs the agent loop **inline** and returns 200 only after it finishes. The loop makes ≥1 Anthropic call + tool calls — reliably **> 3s**. Slack retries any event not 2xx'd within ~3s and, after sustained timeouts, **disables the event subscription** — a silent, total failure of the feature (the exact silent-no-op class this console has been bitten by). The `claimSlackEvent` dedup stops the *retry* from double-processing, but does not stop Slack from seeing the first delivery as failed.

**Fix: ack-then-self-invoke**, applied to **both** the read (C.1) and the new write paths so both respect the 3s contract. (`after()` was rejected — the codebase found it unreliable on Vercel; inline is what we're replacing.)

## Scope

- **In:** move the agent turn off the request path (self-invoke); confirm-first **writes in DM** (`так`/`ні` + persisted proposal + deterministic executor); **multi-turn memory** per DM (`agent_threads`).
- **Unchanged from C.1:** allowlist gate (`isAllowedSlackUser`), DM help routing (`/^\/?(help|допомога)\??$/i` + empty → `formatDmHelp`), @mention read-only answering, the S6/S7 verdict-thread deferral.
- **Writes are DM-only.** @mention stays read-only (a channel thread write-confirm is out of scope; the user asked for DM-only writes).
- **Deferred:** web Assistant tab; `@mention` writes; streaming; the Phase-B carry-forward cleanups (discriminated-union `Tool`/`AgentResult`; mixed read+write single-turn handling).

## Architecture

### Execution — ack-then-self-invoke (replaces C.1 inline)

`app/api/slack/events/route.ts` — the agent branches become fast (< 3s) and never run the loop inline:

1. verify sig (existing) → `parseSlackEvent` (existing).
2. **DM help / empty** → `formatDmHelp` (unchanged, claims event, dedups).
3. agent turn (DM non-help, or @mention not deferred to S6/S7):
   - `claimSlackEvent(eventId)` (existing; redelivery → no-op).
   - `isAllowedSlackUser(userId)` false → post `AGENT_REFUSAL_UK`, done (existing).
   - **DM only:** pending `agent_proposals` on this channel? → confirm/cancel/supersede (see state machine) — confirm/cancel are a **fast** Jira write / status flip, handled **inline**, 200-ack.
   - otherwise **new turn:** post `🤔 думаю…` placeholder, capture its `ts`, 200-ack, then **fire-and-forget** POST to `/api/agent/run`.

`app/api/agent/run/route.ts` (new; `runtime="nodejs"`, `dynamic="force-dynamic"`, the 60s function). Body `{surface, channelId, userId, incomingTs, placeholderTs, threadTs?, question}`, authed by an internal `AGENT_RUN_SECRET` header (never called by Slack). It:
- fail-loud: missing `ANTHROPIC_API_KEY` → `updateMessage` the placeholder with a clear UA error + `console.error`; return.
- **DM:** load `agent_threads` transcript → seed as prior turns → run the **write-capable** agent (`runSlackTurn`, all tools) → text: `updateMessage` placeholder with the answer + append turn; proposal: `updateMessage` placeholder with the UA echo + persist a PENDING `agent_proposals` row + append turn.
- **@mention:** read-only (`askAgent`) → `updateMessage` placeholder with the answer (no memory, no proposal).
- any throw → `updateMessage` placeholder with a UA error + log.

`lib/selfOrigin.ts`: derive the self origin from the incoming request URL / `VERCEL_URL` for the fire-and-forget fetch. The webhook attaches `.catch(log)` and never awaits; if the fetch throws synchronously the webhook still 200s and the placeholder stays `🤔 думаю…` — visible, not silent.

### Write-capable agent turn — `lib/agent/slackTurn.ts`

C.1's `askAgent` filters the tool set to read-only. C.2 adds `runSlackTurn(question, history)` that runs `runAgent` with the **full** tool set and returns the `AgentResult` (`text` | `proposal` | `error`), plus the resolved history to persist. `askAgent` (read-only) stays for @mention. Both share `runAgent`; neither forks loop logic.

### Multi-turn memory — `agent_threads`

DM has no Slack threads; the DM channel *is* the conversation. Table `agent_threads(channelId PK, updatedAt, transcript jsonb)`. Transcript = **lightweight text turns only** `Array<{role, text}>` — not raw `tool_use`/`tool_result`/`thinking` (those go stale / drag in same-model replay rules; tools re-run fresh each turn). `lib/agentThread.ts`: `loadTranscript(channelId)`, `appendTurn(channelId, userText, assistantText)`. Pure cap helper (unit-tested): keep the **last 10 turns** and drop turns older than **24h**; older/empty → fresh conversation. No "clear" command in v1. @mention turns are stateless (no thread row).

### Confirm-first — `agent_proposals` (persist the action, not the closure)

Phase B's `Proposal.apply()` is an in-memory closure and cannot survive the round-trip between the proposal message and a later `так`. C.2 persists the **resolved action** and rebuilds apply deterministically.

- Table `agent_proposals(id, channelId, kind, params jsonb, summaryUk, proposedBy, state, createdAt, resolvedAt)`; `kind ∈ jira_create|jira_comment|jira_transition|jira_update`; `state ∈ PENDING|APPLIED|CANCELLED|SUPERSEDED`; partial unique index → at most one `PENDING` per `channelId`.
  - **Dedicated table, not the verdict `proposals` table.** The verdict `proposals` table (`lib/schema.ts`) has NOT NULL `date`/`axis`/`threadTs` + verdict-state semantics; overloading it would pollute it with nullable columns and blur two concerns. The confirm-first *pattern* is reused, the storage is separate. (Refines the Phase B plan's offhand "generalize `proposals`" note now that the real schema is visible.)
- `Proposal` (Phase B `lib/agent/tools/types.ts`) gains a `params: Record<string, unknown>` field so the resolved action can be persisted; `apply()` stays for the CLI and becomes equivalent to `applyProposal({kind, params})`.
- `lib/proposalExecutor.ts`: `applyProposal({kind, params}): Promise<string>` — deterministic switch calling `createIssue`/`addComment`/`transitionIssue`/`updateIssue`, returns the UA result line. **Shared by CLI `--yes` and the Slack confirm** — one apply path.

### Confirm-first state machine (linear DM)

On each incoming DM, after help/allowlist and before a new turn, check for a PENDING `agent_proposals` on this channel:

| Incoming text | Action | Speed |
|---|---|---|
| `так`/`ок`/`+`/👍 | atomic `PENDING→APPLIED` (redelivered `так` → no-op) → `applyProposal` → post `✅ <result>` | fast, **inline** |
| `ні`/`скасуй`/👎 | `PENDING→CANCELLED` → post `Скасовано.` | fast, **inline** |
| anything else | `PENDING→SUPERSEDED` → post `Скасував попередню пропозицію, обробляю новий запит.` → **new turn** (placeholder + self-invoke) | slow path |

The atomic `PENDING→APPLIED` conditional UPDATE is the write-idempotency guard. Classification is a deterministic keyword set (`lib/agentDm.ts`), no LLM.

### Idempotency (layers)

1. `claimSlackEvent(eventId)` — the DM/mention is processed at most once (existing).
2. `PENDING→APPLIED` conditional claim — a write applies at most once.
3. `lib/slack.ts` reserve-then-send dedup on every outbound message/edit (existing).

### CLI twin

`npm run agent` unchanged in behavior; now applies via `applyProposal` (shared executor). No Slack code in the CLI.

## Components

- **New:** `app/api/agent/run/route.ts`, `lib/agent/slackTurn.ts` (write-capable turn), `lib/agentThread.ts` (+ pure cap helper), `lib/proposalExecutor.ts`, `lib/agentDm.ts` (confirm/cancel classifier, pure), `lib/selfOrigin.ts`; `agent_threads` + `agent_proposals` in `lib/schema.ts`.
- **Modified:** `app/api/slack/events/route.ts` (`runAgentReply` → fast ack + placeholder + self-invoke; DM pending-proposal state machine), `lib/agent/tools/types.ts` + `lib/agent/tools/jira.ts` (add `params` to `Proposal`), `scripts/agent.ts` (apply via `applyProposal`), `CLAUDE.md`.
- **Reused unchanged:** `lib/agent/loop.ts`, `lib/agent/access.ts`, `lib/agent/slackAgent.ts` (askAgent, for @mention), `lib/slack.ts` (`postMessage`/`updateMessage`/`openDm`), `lib/slackEventClaim.ts`, `lib/dmHelp.ts`, `lib/jira.ts`, `lib/jiraRouting.ts`.

## Error handling

- Missing `ANTHROPIC_API_KEY` in `/api/agent/run` → visible placeholder-edit error + log (fail loud).
- `runSlackTurn`/`askAgent` throw → placeholder edited with a UA error + log; no proposal persisted.
- `applyProposal` throws (Jira 4xx/5xx) → proposal stays APPLIED but posts the error; a human re-issues.
- The webhook always returns 200 (a 5xx makes Slack retry and, sustained, disables the subscription); failures surface in Slack + logs.

## Testing (pure libs + mocked clients, vitest `server-only`-alias pattern)

- `lib/agentDm.ts` — confirm/cancel/other classification incl. UA variants (pure).
- `agent_threads` cap helper — 24h window + last-10-turns (pure).
- `lib/proposalExecutor.ts` — each `kind` calls the right `lib/jira.ts` fn with stored `params` (mocked `fetch`); Mr-Lab create asserts `assigneeAccountId:null` + description prefix.
- `lib/agent/slackTurn.ts` — text vs proposal result surfaced (mocked `runAgent`).
- events `message.im` branch — mocked deps: pending-proposal confirm/cancel/supersede; new turn fires the self-invoke (assert the fetch, not awaited); help + refusal unchanged.
- `/api/agent/run` — mocked turn + `updateMessage`: text edits placeholder; proposal persists PENDING + edits; missing-key fails loud; mention path is read-only.

## Open items (operator input, not code)

- `AGENT_RUN_SECRET` on Vercel (internal self-invoke auth) — new env var.
- `ANTHROPIC_API_KEY` on Vercel (already required by C.1 to go live).
- `JIRA_MRLAB_PROJECT` before a real Mr-Lab create confirms (Phase A/B carry-forward).
- Slack scopes for DM/mention already added for C.1 — no new subscriptions.
