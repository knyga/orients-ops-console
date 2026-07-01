# Slack Conversational Agent (Jira + console tools) — Design

**Date:** 2026-07-01
**Status:** Design approved; implementation pending
**Author:** Oleksandr Knyga (with Claude)

## Motivation

The team wants to *talk to the bot* in Slack — @mention it, DM it, reply in a thread —
to create/edit/find Jira tickets and to brainstorm. The concrete anchor use case, from
the Head of Engineering (Bohdan Forostianyi):

> Тегаєш в #issue-log, говориш хто — і він створює. І якщо це Любомир, Андріан, Тарас,
> то створює на **Mr Lab** і в опис додає те, до кого приписав.

Today the bot is a set of **one-shot forced-tool classifiers** (verdict-thread
instructions, flight extraction, etc.). There is **no multi-turn agentic tool-use loop**,
the Slack webhook only handles **verdict/ask thread replies** (no @mention / DM), and
`lib/jira.ts` is **read-only** (`fetchResolvedIssues` only). This feature adds a real
conversational agent with an **extensible tool registry**.

## Decisions (from brainstorming)

| Axis | Decision |
|------|----------|
| Scope | **General assistant with an extensible tool registry** (Jira first; more tools drop in later). |
| v1 tools | **Jira write + search** *and* **read-only console tools** (who / field-bonus / jira & github reports / Slack search). Free-text brainstorming needs no tool. |
| Surfaces | **@mention in channels**, **DMs**, and **thread follow-ups** (no re-tag needed once a thread is the agent's). |
| Write safety | **Everything confirms first** — every Jira write echoes a Ukrainian proposal and applies only after `так`/👍. |
| Who can use | **A team allowlist** (the roster in `lib/people.ts`), broader than the 2 approvers; unknown users get a polite refusal. |
| Model | `claude-sonnet-5` for the loop (strong tool use, fast, fits the 60s cap). |

## Key architectural principle: every turn is stateless

Each Slack message is **one webhook invocation**. Conversation state is **the Slack thread
itself** — reconstructed by reading thread history each turn. There is no long-lived
process and no queue. This is what makes the feature fit **Vercel Hobby (60s function cap)**
against Slack's **3-second ack** requirement:

```
Slack event → verify signature → dedup by event_id   (both already exist)
  ↓ ack 200 immediately (<3s)
  ↓ after()/waitUntil (background, <60s):
      allowlist check → run one agent turn → post reply via sendTracked
```

A single turn does at most ~8 tool iterations within a ~50s wall-clock budget, then posts.
Multi-turn conversations are just many independent invocations sharing the thread as memory.

## Component map

### 1. Slack ingress — extend `app/api/slack/events/route.ts`

Add a branch **alongside** (not replacing) the existing verdict/ask handling:

- Classify the event:
  - `app_mention` → **agent** (new)
  - `message.im` (DM) → **agent** (new)
  - thread reply in an **agent thread** → **agent follow-up** (new)
  - thread reply in a **verdict/ask thread** → existing handlers (unchanged)
- **Bot user id** — currently unknown to the code. Discover via `auth.test`, cache in
  `SLACK_BOT_USER_ID` env / module memo; used to strip the mention text and to prevent
  self-reply loops (ignore events authored by the bot).
- **Agent-thread detection** — a new `agent_threads` table keyed by `thread_ts` records
  threads the agent owns, so follow-ups route to the agent without a re-tag and stay
  cleanly separate from verdict threads.
- **Allowlist gate** — reuse `lib/people.ts`: any person with a Slack id in the registry
  is allowed. Unknown users get a polite Ukrainian "не впізнаю тебе" and no action.
- **Slack app config (operator action):** subscribe to `app_mention` + `message.im`
  events; add scopes `app_mentions:read`, `im:history`, `im:read`, `im:write` (plus the
  existing `chat:write`). Documented in the plan; applied by the operator in Slack admin.

### 2. The agent loop — `lib/agent/loop.ts` (new core infra)

A real multi-turn tool-use cycle (distinct from all existing one-shot calls):

```
messages = history → Anthropic format   (human → user, bot → assistant)
loop (max ~8 iterations, ~50s budget):
  resp = Claude(system, tools, messages)         # claude-sonnet-5
  if text-only        → post it; done            # brainstorm / answer / proposal echo
  if read-tool use    → execute now; append tool_result; continue
  if write-tool use   → record a proposal; echo "📝 …Так?"; done  (NOT executed here)
```

- **System prompt** carries: bot identity, the people-routing rules, the confirm-first
  protocol, and the language rule — **mirror the user's language for free chat; fixed
  Ukrainian templates for echoes / acks / results** (house style).
- **Context reconstruction** — `lib/agent/history.ts` (pure, tested) maps thread messages
  (from the **Slack mirror** when present, else live Slack API) to Anthropic message format.
- **Guards:** ≤8 tool iterations + ~50s wall-clock budget → stays under the 60s Vercel cap;
  on overrun, post a Ukrainian "не встиг, спробуй ще" and log.

### 3. Tool registry — `lib/agent/tools/`

Each tool: `{ name, description, inputSchema (JSON Schema), kind: "read" | "write", run(args) }`.
The loop introspects `kind` to decide execute-now vs. proposal-gate.

- **Read tools (execute immediately):** `jira_search` (JQL), `console_who`,
  `console_field_bonus`, `console_jira_report`, `console_github_report`, `slack_search`
  — thin wrappers over existing `lib/` functions.
- **Write tools (proposal-gated):** `jira_create`, `jira_update`, `jira_transition`,
  `jira_comment`.

### 4. Confirm-first — generalize the existing `proposals` machinery

The codebase already has a confirm-first `proposal → "так"/👍 → apply` flow
(`lib/applyInstructionReply.ts`, `proposals` table, unique on `source_reply_ts`,
redelivery-idempotent). **Generalize it**: a proposal gains a `kind` (`"jira_write"`
alongside the existing verdict kinds) and stores the **exact structured tool call**.

- **Turn 1 (instruction):** the agent decides to write → the framework records the proposal
  with concrete, resolved params and posts the Ukrainian echo (which shows the **resolved
  project**, e.g. "Mr Lab", making routing transparent and correctable). *The LLM proposes;
  a deterministic executor applies.* The LLM never calls Jira write endpoints directly.
- **Turn 2 (confirmation):** `так`/👍 → the existing confirm path looks up the stored
  proposal and executes it **exactly** (no model re-derivation, no drift). `ні` cancels;
  a question is a no-op.

Benefits: deterministic writes, idempotency for free, audit trail for free, no new
confirm protocol to invent.

### 5. Jira write client + people routing

- Extend **`lib/jira.ts`** (keep `server-only`) with `searchIssues(jql)`, `createIssue(...)`,
  `updateIssue(...)`, `transitionIssue(...)`, `addComment(...)` against Jira Cloud REST v3,
  reusing the existing `JIRA_*` auth. Add the **"Mr Lab"** project key to config
  (`JIRA_PROJECT_KEYS` is already multi-project).
- **`lib/jiraRouting.ts` (pure, unit-tested):** `person → { projectKey, assignInDescription,
  jiraAccountId? }`. Default project for most; **Любомир / Андріан / Тарас → Mr Lab,
  `assignInDescription: true`** — since they are not real assignees on that board, the
  executor writes `Виконавець: <name>` into the description instead of an assignee field.
  This encodes Bohdan's rule exactly. Routing data lives as a `jira` field on `lib/people.ts`
  entries.

### 6. CLI twin — `npm run agent` (mandatory second interface + primary test harness)

Runs the **same** `lib/agent/loop.ts`:

- `npm run agent -- "create a ticket for Тарас: fix the export bug"` (one-shot), or a REPL
  for multi-turn.
- Read tools execute live; writes print the **resolved proposal** and require confirmation
  (`--yes` to auto-apply). Exercises the whole loop, routing, and Jira writes **without Slack**.
- Runs under Node with `--conditions=react-server` (established server-only discipline);
  needs `ANTHROPIC_API_KEY` + `JIRA_*`.

### 7. Web representation — read-only "Assistant" tab

`GET /api/assistant?period=` renders recent agent conversations and the Jira writes
performed (joined from `agent_threads` + `proposals` + `outbound_messages`). An
audit/history surface — **not** a chat UI (the chat *is* Slack / CLI). Fits the house
hybrid pattern; no new write path from the web.

## Safety & idempotency

- `event_id` dedup → no double-processing on Slack retries. *(existing)*
- `proposals` unique on `source_reply_ts` → redelivery-idempotent. *(existing, generalized)*
- `sendTracked` reserve-then-send → no double posts; every send auto-lands in the Outbound tab. *(existing)*
- Confirm-first → no accidental writes; the echo shows resolved routing so a misroute is
  caught before the ticket is created.
- Loop caps (≤8 iterations, ~50s) → under the 60s Vercel cap.
- **`ANTHROPIC_API_KEY` presence check** on the webhook path with an operator DM — the
  console has been bitten by a silent no-op when this env var is missing on Vercel; fail loud.

## Testing

Pure libs + mocked clients, per the established vitest `server-only`-alias pattern:

- **Pure/unit:** `jiraRouting` (esp. the Mr-Lab-3 rule), the `history` mapper, tool
  input-schema validation, proposal derivation.
- **Loop with a mocked Anthropic client:** simulate a read-tool turn, a write→proposal turn,
  and the confirm→apply turn.
- **Jira write client** with mocked `fetch`.

## Implementation phases (one spec, three phases — matches repo convention)

- **Phase A — Jira write client + `jiraRouting` + `people.ts` routing data.**
  Pure + client, fully CLI/test-drivable. Ends with `npm run agent` able to create/route a
  ticket (with `--yes`).
- **Phase B — agent loop + tool registry + read tools + generalized proposals.**
  CLI multi-turn works end-to-end including confirm-first.
- **Phase C — Slack ingress (mention / DM / thread) + `agent_threads` + allowlist + web
  Assistant tab.** Wires B into Slack; bot user id, event subscriptions, scopes.

## Open items (operator input, not code)

- Slack app: add the `app_mention` + `message.im` event subscriptions and the listed scopes.
- Confirm the **"Mr Lab" Jira project key** and the **default project key** for everyone
  else. Phase A leaves clearly-marked config placeholders until these are provided.

## Out of scope (v1)

- GitHub / Vimeo / Drive **write** tools (registry makes them cheap to add later).
- A web chat UI (chat lives in Slack + CLI; web is audit-only).
- Streaming responses in Slack (post the final turn text; the 50s budget makes streaming
  unnecessary).
