# Slack Conversational Agent — Phase C.2 @mention-channel delta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the peer-built **DM** confirm-first write path to **@mention-in-channel** (Bohdan's `#issue-log` create flow) and **plain thread follow-ups**, with **requester-gated** confirm, memory + proposals keyed per-thread.

**Architecture:** The DM foundation already exists on `main` (self-invoke `/api/agent/run`, `runSlackTurn`, `agent_threads`/`agent_proposals`, `applyProposal`, `classifyDmReply`). This delta introduces a `conversationKey` (DM → `channelId`; channel → `thread_ts`) reusing the existing `channel_id` key column (no migration — Slack channel ids and numeric thread_ts never collide), makes the run route write-capable for `@mention` keyed by that key, and adds channel ingress: the mention branch routes through a generalized `handleAgentConversation` with requester-gating, and a new branch handles plain thread replies (the `так`/follow-up that carries no mention) in known agent threads.

**Tech Stack:** TypeScript strict, Next 16 route handlers (`runtime="nodejs"`), Drizzle/Neon, Vitest (`server-only`→`empty.js` alias), Slack Events API.

## Global Constraints

- **Shared checkout / peer code.** These files were just committed by a peer. Modify surgically; do NOT rename their exports, columns, or reshape the DM path. Stage ONLY the files each task names via explicit `git add <path>` — never `git add -A`. Leave `next-env.d.ts` (generated) untouched.
- **No DB migration.** Reuse the existing `agent_proposals.channel_id` / `agent_threads.channel_id` columns as the conversation key.
- **conversationKey:** DM → `channelId`; `@mention`/thread → `threadTs` (which `parseSlackEvent` sets to `thread_ts ?? ts`).
- **Requester-gating (channel only):** only the proposal's `proposedBy` may confirm/cancel/supersede. A non-requester reply while a proposal is PENDING is ignored (no supersede, no new turn). In a DM the proposer is always the sole participant, so the check is a no-op there.
- **Sibling-event partition:** a message that leads with a Slack mention token (`<@…>`) is the app_mention's sibling and is handled by the mention branch; the plain-reply branch must skip it.
- **Ukrainian** for all team-facing Slack text (echoes/acks/results) — reuse the existing constants/format already in the DM path.
- **Webhook never 5xx** to Slack; the loop runs off-request via the existing `deferAgentTurn` self-invoke; confirm/cancel/supersede stay inline (fast DB + post).
- Frequent commits: one per task.

---

### Task 1: Per-thread existence check + leading-mention helper

Two small pure-ish additions the ingress needs: detect whether a `thread_ts` is a known agent conversation, and detect whether a reply leads with a bot mention (to partition sibling events).

**Files:**
- Modify: `lib/agentThread.ts` (add `agentThreadExists`)
- Modify: `lib/slackEventParse.ts` (add `hasLeadingMention`)
- Test: `lib/agentThread.test.ts` (create or extend), `lib/slackEventParse.test.ts` (extend)

**Interfaces:**
- Produces:
  - `agentThreadExists(conversationKey: string): Promise<boolean>` — true iff an `agent_threads` row exists for the key (independent of the 24h transcript cap).
  - `hasLeadingMention(text: string): boolean` — true iff `text` (after leading whitespace) starts with a `<@…>` token.

- [ ] **Step 1: Write the failing test for `hasLeadingMention`**

Add to `lib/slackEventParse.test.ts`:

```ts
import { hasLeadingMention } from "./slackEventParse";

describe("hasLeadingMention", () => {
  it("is true for a leading mention token", () => {
    expect(hasLeadingMention("<@U123> створи задачу")).toBe(true);
    expect(hasLeadingMention("  <@U123|bot> hi")).toBe(true);
  });
  it("is false for a plain reply", () => {
    expect(hasLeadingMention("так")).toBe(false);
    expect(hasLeadingMention("ні, скасуй")).toBe(false);
    expect(hasLeadingMention("зроби це <@U123>")).toBe(false); // mention not leading
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run lib/slackEventParse.test.ts -t hasLeadingMention`
Expected: FAIL — `hasLeadingMention` not exported.

- [ ] **Step 3: Implement `hasLeadingMention`**

Add to `lib/slackEventParse.ts` (next to `stripBotMention`, reusing the same anchor):

```ts
/** True iff `text` begins (after leading whitespace) with a Slack mention token. */
export function hasLeadingMention(text: string): boolean {
  return /^\s*<@[^>]+>/.test(text);
}
```

- [ ] **Step 4: Write the failing test for `agentThreadExists`**

Create `lib/agentThread.test.ts` (mock the db module the way the repo's DB-touching tests do — mirror an existing `*.test.ts` that mocks `./db`; use `vi.hoisted` for the mock handles):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("./db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve(h.rows) }) }),
  },
  schema: { agentThreads: { channelId: "channel_id" } },
}));

import { agentThreadExists } from "./agentThread";

beforeEach(() => { h.rows = []; });

describe("agentThreadExists", () => {
  it("is false when no row", async () => {
    h.rows = [];
    expect(await agentThreadExists("111.222")).toBe(false);
  });
  it("is true when a row exists", async () => {
    h.rows = [{ channelId: "111.222", updatedAt: new Date().toISOString(), transcript: [] }];
    expect(await agentThreadExists("111.222")).toBe(true);
  });
});
```

> Note for implementer: if an existing `lib/*.test.ts` already mocks `./db` with a richer chainable stub, copy that exact stub shape instead of the minimal one above so the mock matches the repo pattern.

- [ ] **Step 5: Run it, verify it fails**

Run: `npx vitest run lib/agentThread.test.ts`
Expected: FAIL — `agentThreadExists` not exported.

- [ ] **Step 6: Implement `agentThreadExists`**

Add to `lib/agentThread.ts`:

```ts
/** True iff an agent conversation row exists for this key (ignores the 24h cap —
 *  used only for ingress routing, not for seeding history). */
export async function agentThreadExists(conversationKey: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(schema.agentThreads)
    .where(eq(schema.agentThreads.channelId, conversationKey));
  return rows.length > 0;
}
```

- [ ] **Step 7: Run both tests + lint**

Run: `npx vitest run lib/agentThread.test.ts lib/slackEventParse.test.ts && npm run lint`
Expected: PASS; no new lint errors.

- [ ] **Step 8: Commit**

```bash
git add lib/agentThread.ts lib/agentThread.test.ts lib/slackEventParse.ts lib/slackEventParse.test.ts
git commit -m "feat(agent): agentThreadExists + hasLeadingMention (C.2 @mention delta)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Run route — conversationKey-keyed, write-capable for both surfaces

Make `/api/agent/run` drive the **write-capable** loop for `@mention` too, and key memory + proposals by `conversationKey` (not `channelId`), while still posting via `channelId`/`placeholderTs`. This unifies the DM and mention branches.

**Files:**
- Modify: `app/api/agent/run/route.ts`
- Test: `app/api/agent/run/route.test.ts` (extend)

**Interfaces:**
- Consumes: `runSlackTurn` (`lib/agent/slackTurn`), `loadTranscript`/`appendTurn` (`lib/agentThread`), `insertPending` (`lib/agentProposals`), `applyProposal` `ProposalKind` (`lib/proposalExecutor`), `updateMessage` (`lib/slack`).
- Produces: `RunBody` now includes `conversationKey: string`. Both surfaces use `runSlackTurn` + memory + proposals keyed by `conversationKey`.

- [ ] **Step 1: Write the failing test**

Extend `app/api/agent/run/route.test.ts` with a mention-write case. Match the file's existing mock setup (it already mocks `runSlackTurn`/`askAgent`/`loadTranscript`/`appendTurn`/`insertPending`/`updateMessage`); add:

```ts
it("mention proposal is keyed by conversationKey (thread_ts), posts in the real channel", async () => {
  process.env.AGENT_RUN_SECRET = "s";
  // arrange mocks: runSlackTurn → { kind:"proposal", proposal:{kind:"jira_create", params:{...}, echoUk:"echo" } }
  //               loadTranscript → []
  const req = new Request("http://x/api/agent/run", {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-secret": "s" },
    body: JSON.stringify({
      surface: "mention",
      conversationKey: "111.222",   // thread_ts
      channelId: "C-issue-log",
      userId: "U1",
      incomingTs: "111.900",
      placeholderTs: "111.901",
      threadTs: "111.222",
      question: "створи задачу для Тараса",
    }),
  });
  const res = await POST(req);
  expect(res.status).toBe(200);
  // insertPending called with channelId === conversationKey ("111.222"), proposedBy "U1"
  expect(insertPendingMock).toHaveBeenCalledWith(
    expect.objectContaining({ channelId: "111.222", proposedBy: "U1", kind: "jira_create" }),
  );
  // loadTranscript + appendTurn keyed by conversationKey
  expect(loadTranscriptMock).toHaveBeenCalledWith("111.222");
  expect(appendTurnMock).toHaveBeenCalledWith("111.222", "створи задачу для Тараса", "echo");
  // placeholder edited in the REAL channel
  expect(updateMessageMock).toHaveBeenCalledWith("C-issue-log", "111.901", "echo", expect.anything());
});
```

> Implementer: reuse the exact mock handles already declared at the top of this test file (names may differ — adapt `insertPendingMock` etc. to the file's existing handles). If the file has no mention test yet, model the arrange/act after its existing DM proposal test.

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/api/agent/run/route.test.ts -t "conversationKey"`
Expected: FAIL — current mention branch uses read-only `askAgent`, never calls `insertPending`/`loadTranscript`.

- [ ] **Step 3: Rewrite the route body to be conversationKey-keyed for both surfaces**

Replace the body of `app/api/agent/run/route.ts` (keep the header comment, `runtime`/`dynamic`, and the auth + catch blocks) with a single unified path. New `RunBody` + `POST` core:

```ts
interface RunBody {
  surface: "dm" | "mention";
  conversationKey: string; // DM → channelId; @mention → thread_ts
  channelId: string;       // real Slack channel (for posting/editing)
  userId: string;
  incomingTs: string;
  placeholderTs: string;
  threadTs?: string;
  question: string;
}
```

```ts
  const body = (await req.json()) as RunBody;
  const meta = {
    key: agentReplyKey(body.userId, `${body.incomingTs}:run`),
    feature: "agent",
    channel: body.surface,
    trigger: "webhook" as const,
  };

  try {
    const history = await loadTranscript(body.conversationKey);
    const result = await runSlackTurn(body.question, history);
    if (result.kind === "proposal" && result.proposal) {
      await updateMessage(body.channelId, body.placeholderTs, result.proposal.echoUk, meta);
      await insertPending({
        channelId: body.conversationKey,
        kind: result.proposal.kind as ProposalKind,
        params: result.proposal.params,
        summaryUk: result.proposal.echoUk,
        proposedBy: body.userId,
      });
      await appendTurn(body.conversationKey, body.question, result.proposal.echoUk);
      return Response.json({ ok: true, surface: body.surface, proposal: result.proposal.kind });
    }
    const answer = result.text.trim() || "Не маю відповіді на це.";
    await updateMessage(body.channelId, body.placeholderTs, answer, meta);
    await appendTurn(body.conversationKey, body.question, answer);
    return Response.json({ ok: true, surface: body.surface });
  } catch (err) {
    // ...unchanged catch block (fail-loud on ANTHROPIC_API_KEY)...
  }
```

Delete the now-unused `askAgent` import (mention is no longer read-only). Keep `runSlackTurn` importing `Turn`/history as-is.

- [ ] **Step 4: Run the route tests + type-check**

Run: `npx vitest run app/api/agent/run/route.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors (confirm the existing DM tests still pass — they must now pass `conversationKey`; update those test bodies to include `conversationKey: <channelId>` where they previously omitted it).

- [ ] **Step 5: Commit**

```bash
git add app/api/agent/run/route.ts app/api/agent/run/route.test.ts
git commit -m "feat(agent): run route keyed by conversationKey, write-capable @mention (C.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Events ingress — generalized handler, requester-gating, thread-reply branch + docs

Generalize the DM handler to a surface-agnostic `handleAgentConversation`, route the `@mention` branch through it (write path + requester-gating), add a new branch for plain thread replies (the `так`/follow-up without a mention) in known agent threads, and thread `conversationKey` through `deferAgentTurn` to the run route.

**Files:**
- Modify: `app/api/slack/events/route.ts`
- Modify: `CLAUDE.md` (note @mention writes now supported)
- Modify: `docs/superpowers/specs/2026-07-02-slack-agent-phase-c2-writes-design.md` (mark DM done by peer; this plan = the @mention delta)
- Test: `app/api/slack/events/route.test.ts` (extend)

**Interfaces:**
- Consumes Task 1 (`agentThreadExists`, `hasLeadingMention`) + Task 2 (`RunBody.conversationKey`).
- Produces: `handleAgentConversation` replaces `handleDmAgent`; `deferAgentTurn` gains a `conversationKey` argument.

- [ ] **Step 1: Write the failing tests**

Extend `app/api/slack/events/route.test.ts` (match its existing mock harness for `postMessage`/`readPendingProposal`/`claimApply`/`applyProposal`/`setState`/`agentThreadExists`/`fetch`). Add:

```ts
// (a) plain "так" reply in an agent thread, BY the requester → applies inline
it("thread reply 'так' by requester applies the pending proposal", async () => {
  // agentThreadExists → true; readPendingProposal → { id:"p1", proposedBy:"U1", kind:"jira_create", params:{} }
  // claimApply → true; applyProposal → "✅ Створено ATP-1: url"
  const res = await POST(actionableEvent({ threadTs: "T1", user: "U1", text: "так", channel: "C1" }));
  expect(res.status).toBe(200);
  expect(claimApplyMock).toHaveBeenCalledWith("p1");
  expect(applyProposalMock).toHaveBeenCalled();
  // fetch (self-invoke) NOT called — confirm is inline
  expect(fetchMock).not.toHaveBeenCalled();
});

// (b) same thread, "так" by a NON-requester → ignored (no apply, no new turn)
it("thread reply by a non-requester is ignored while a proposal is pending", async () => {
  // readPendingProposal → { id:"p1", proposedBy:"U1", ... }
  const res = await POST(actionableEvent({ threadTs: "T1", user: "U2", text: "так", channel: "C1" }));
  expect(claimApplyMock).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

// (c) a mention-sibling message (leads with <@...>) in an agent thread → skipped here
it("skips the message sibling of an @mention in an agent thread", async () => {
  const res = await POST(actionableEvent({ threadTs: "T1", user: "U1", text: "<@U0BOT> ще задача", channel: "C1" }));
  expect(res.status).toBe(200);
  // neither the proposal path nor a deferred turn fired from THIS event
  expect(claimApplyMock).not.toHaveBeenCalled();
});

// (d) @mention new turn defers with conversationKey === thread_ts
it("mention defers a turn keyed by thread_ts", async () => {
  process.env.AGENT_RUN_SECRET = "s";
  // no pending proposal
  const res = await POST(mentionEvent({ ts: "M1", threadTs: "M1", user: "U1", channel: "C1", text: "<@U0BOT> створи" }));
  expect(res.status).toBe(200);
  const [, opts] = fetchMock.mock.calls[0];
  expect(JSON.parse(opts.body).conversationKey).toBe("M1");
  expect(JSON.parse(opts.body).surface).toBe("mention");
});
```

> Implementer: adapt `actionableEvent`/`mentionEvent` to the test file's existing Slack-envelope builders + signature-mock. Add mock handles for `agentThreadExists` and `hasLeadingMention` (or import the real `hasLeadingMention` — it's pure).

- [ ] **Step 2: Run them, verify they fail**

Run: `npx vitest run app/api/slack/events/route.test.ts -t "thread reply|non-requester|sibling|thread_ts"`
Expected: FAIL — no thread-reply agent branch; mention doesn't send `conversationKey`; no requester-gating.

- [ ] **Step 3: Generalize `handleDmAgent` → `handleAgentConversation`**

Replace `handleDmAgent` with a surface-agnostic handler. It takes an explicit `conversationKey`, the real `channelId`, and optional `threadTs`:

```ts
interface AgentTurnInput {
  surface: "dm" | "mention" | "thread";
  conversationKey: string;
  channelId: string;
  threadTs: string | undefined;
  userId: string;
  text: string;
  eventId: string | null;
}

async function handleAgentConversation(req: Request, inp: AgentTurnInput): Promise<Response> {
  if (inp.eventId) {
    const fresh = await claimSlackEvent(inp.eventId, new Date().toISOString(), { eventType: "message" });
    if (!fresh) return ack({ skipped: "duplicate-event", event_id: inp.eventId });
  }
  if (!isAllowedSlackUser(inp.userId)) {
    try {
      await postMessage(inp.channelId, AGENT_REFUSAL_UK, { key: agentReplyKey(inp.userId, inp.text ? `${inp.conversationKey}:${inp.userId}` : inp.conversationKey), feature: "agent", channel: inp.surface, trigger: "webhook" }, inp.threadTs);
    } catch (err) {
      console.error("slack events: refusal post failed:", err);
    }
    return ack({ handled: "agent", refused: true, user: inp.userId });
  }

  const q = inp.text.trim();
  const pending = await readPendingProposal(inp.conversationKey);
  if (pending) {
    // Requester-gating: in a channel, only the proposer drives the pending write.
    if (inp.surface !== "dm" && pending.proposedBy !== inp.userId) {
      return ack({ handled: "agent", ignored: "not-requester", user: inp.userId });
    }
    const decision = classifyDmReply(q);
    if (decision === "confirm") {
      const won = await claimApply(pending.id);
      const result = won ? await applyProposal(pending.kind, pending.params) : "Вже застосовано.";
      await postMessage(inp.channelId, result, { key: agentReplyKey(inp.userId, `${inp.conversationKey}:apply`), feature: "agent", channel: inp.surface, trigger: "webhook" }, inp.threadTs);
      return ack({ handled: "agent", applied: won });
    }
    if (decision === "cancel") {
      await setState(pending.id, "CANCELLED");
      await postMessage(inp.channelId, "Скасовано.", { key: agentReplyKey(inp.userId, `${inp.conversationKey}:cancel`), feature: "agent", channel: inp.surface, trigger: "webhook" }, inp.threadTs);
      return ack({ handled: "agent", cancelled: true });
    }
    await setState(pending.id, "SUPERSEDED");
    await postMessage(inp.channelId, "Скасував попередню пропозицію, обробляю новий запит.", { key: agentReplyKey(inp.userId, `${inp.conversationKey}:supersede`), feature: "agent", channel: inp.surface, trigger: "webhook" }, inp.threadTs);
  }
  return deferAgentTurn(req, inp.channelId, inp.userId, q, inp.conversationKey, inp.threadTs, inp.surface, inp.conversationKey);
}
```

> Keep `agentReplyKey` uniqueness stable: DM previously keyed on `parsed.ts`; keying on `conversationKey`+suffix keeps the confirm/cancel/supersede/apply posts distinct and redelivery-deduped. If a reviewer flags that two turns in one DM could collide on `${conversationKey}:apply`, note the `claimApply` idempotency already guards double-apply; this is a Minor for the final review.

- [ ] **Step 4: Update `deferAgentTurn` to carry `conversationKey`**

Change `deferAgentTurn`'s signature to accept `conversationKey` and `surface: "dm"|"mention"|"thread"`, use `conversationKey` in the self-invoke body, and normalize surface to `"dm"|"mention"` for the run route (`thread` → `"mention"`, since the run route only distinguishes DM memory-keying, now unified anyway):

```ts
async function deferAgentTurn(
  req: Request,
  channelId: string,
  userId: string,
  question: string,
  ts: string,                 // used only for placeholder key uniqueness
  threadTs: string | undefined,
  surface: "dm" | "mention" | "thread",
  conversationKey: string,
): Promise<Response> {
  const runSurface = surface === "thread" ? "mention" : surface;
  let placeholderTs: string;
  try {
    placeholderTs = await postMessage(
      channelId, "🤔 думаю…",
      { key: agentReplyKey(userId, `${ts}:ph`), feature: "agent", channel: surface, trigger: "webhook" },
      threadTs,
    );
  } catch (err) {
    console.error("slack events: placeholder post failed:", err);
    return ack({ handled: "agent", error: "placeholder-failed" });
  }
  const secret = process.env.AGENT_RUN_SECRET;
  if (secret) {
    void fetch(`${selfOrigin(req)}/api/agent/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-secret": secret },
      body: JSON.stringify({ surface: runSurface, conversationKey, channelId, userId, incomingTs: ts, placeholderTs, threadTs, question }),
    }).catch((err) => console.error("slack events: self-invoke failed:", err));
  } else {
    console.error("slack events: AGENT_RUN_SECRET not set — cannot dispatch agent turn");
  }
  return ack({ handled: "agent", surface, deferred: true });
}
```

> `deferAgentTurn` is called from `handleAgentConversation` with `ts = conversationKey`; that only feeds the placeholder key's uniqueness suffix, which is fine.

- [ ] **Step 5: Route the mention branch through the generalized handler**

In the `parsed.kind === "mention"` block, keep the existing verdict/ask deferral guard, then replace the `runAgentReply(...)` call with:

```ts
    return await handleAgentConversation(req, {
      surface: "mention",
      conversationKey: parsed.threadTs,   // thread_ts (== ts for a top-level mention)
      channelId: parsed.channelId,
      threadTs: parsed.threadTs,
      userId: parsed.userId,
      text: stripBotMention(parsed.text),
      eventId: parsed.eventId,
    });
```

Delete the now-unused `runAgentReply` function (its allowlist + defer logic is subsumed by `handleAgentConversation`).

- [ ] **Step 6: Route the DM branch through the generalized handler**

Replace the `if (!isHelp) return await handleDmAgent(req, parsed);` call with:

```ts
    if (!isHelp) {
      return await handleAgentConversation(req, {
        surface: "dm",
        conversationKey: parsed.channelId,
        channelId: parsed.channelId,
        threadTs: undefined,
        userId: parsed.userId,
        text: parsed.text,
        eventId: parsed.eventId,
      });
    }
```

- [ ] **Step 7: Add the plain-thread-reply agent branch (before the tracked-channel filter)**

Immediately after the `dm` block and before `const channel = TRACKED_CHANNELS.find(...)`, add:

```ts
  // A plain thread reply (no bot mention) — e.g. "так" / a follow-up — inside a
  // known agent conversation. The mention-sibling of an @mention leads with a
  // mention token and is handled by the mention branch, so skip those here to
  // avoid double-processing. Runs BEFORE the tracked-channel filter because an
  // agent thread can live in any channel (e.g. #issue-log needn't be tracked).
  if (parsed.kind === "actionable" && !hasLeadingMention(parsed.replyText)) {
    let isAgent = false;
    try {
      isAgent = await agentThreadExists(parsed.threadTs);
    } catch (err) {
      console.error("slack events: agentThreadExists lookup failed:", err);
    }
    if (isAgent) {
      return await handleAgentConversation(req, {
        surface: "thread",
        conversationKey: parsed.threadTs,
        channelId: parsed.channelId,
        threadTs: parsed.threadTs,
        userId: parsed.userId,
        text: parsed.replyText,
        eventId: parsed.eventId,
      });
    }
  }
```

Add the imports at the top: `agentThreadExists` from `@/lib/agentThread`, `hasLeadingMention` from `@/lib/slackEventParse` (extend the existing import line). `handleAgentConversation` claims the event, so verdict/ask threads (never agent threads) are untouched and still reach S6/S7 below.

- [ ] **Step 8: Run the events tests + full type-check + lint**

Run: `npx vitest run app/api/slack/events/route.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS (including the peer's existing DM tests — adjust any that referenced `handleDmAgent` or omitted `conversationKey`); no type errors; no new lint errors.

- [ ] **Step 9: Update docs**

In `CLAUDE.md`, extend the agent/Slack description to note: *@mention-in-channel and plain thread follow-ups now support confirm-first Jira writes (requester-gated), not just DMs.* In the C.2 spec (`…phase-c2-writes-design.md`), add a short note at the top: *DM write path implemented by a peer session (commits through `c63dc46`); this plan implements the @mention/thread delta on top of it.*

- [ ] **Step 10: Run the full suite once**

Run: `npm test`
Expected: green (record the pass count).

- [ ] **Step 11: Commit**

```bash
git add app/api/slack/events/route.ts app/api/slack/events/route.test.ts CLAUDE.md docs/superpowers/specs/2026-07-02-slack-agent-phase-c2-writes-design.md
git commit -m "feat(agent): @mention + thread-reply confirm-first writes, requester-gated (C.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (the @mention delta of the C.2 spec):**
- @mention-in-channel writes → Task 2 (run route write-capable) + Task 3 (mention branch through the write handler). ✓
- Thread follow-ups without re-tagging → Task 3 Step 7 (actionable-in-agent-thread branch). ✓
- `conversationKey` unification (DM→channelId, channel→thread_ts), no migration → Tasks 2–3. ✓
- Requester-gated confirm → Task 3 Step 3 (`pending.proposedBy !== userId` for non-DM). ✓
- Sibling-event partition → Task 1 (`hasLeadingMention`) + Task 3 Step 7. ✓
- Idempotency preserved (event claim, `claimApply`, reserve-then-send) → reused unchanged. ✓
- (DM write path itself: already implemented by the peer — out of this plan.)

**Placeholder scan:** No TBD/TODO. Test steps that adapt to the peer's existing mock harness say so explicitly and give the concrete assertions to reach; they are integration tests against real, already-committed files, so the exact mock-handle names must match the target file (called out per step).

**Type consistency:** `conversationKey` added to `RunBody` (Task 2) and sent by `deferAgentTurn` (Task 3). `handleAgentConversation`'s `AgentTurnInput` fields match the three call sites (mention/dm/thread). `ProposalKind`, `readPendingProposal`, `claimApply`, `setState`, `applyProposal` used exactly as the peer defined them.

## Open items (operator; carried from the spec)

- Slack app: confirm `app_mention` subscription + `app_mentions:read`; the `message.im` + `im:*` scopes already serve DMs. A channel agent thread needs the bot present in the channel (invite it to `#issue-log`).
- `AGENT_RUN_SECRET` already required by the peer's DM work — no new env.
- `JIRA_MRLAB_PROJECT` before a real Mr-Lab create confirms (default project `ATP` hardcoded).
