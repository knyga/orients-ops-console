# Slack Conversational Agent — Phase C.1 Implementation Plan (read-only Slack ingress)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Slack bot actually answer a free-form question (e.g. "what was done in jira today") when a team member **DMs it** or **@mentions it** — by routing that text into the existing Phase-B agent loop (`runAgent`) with **read-only tools**, gated by a people allowlist, and posting the answer. No writes over Slack in this increment.

**Architecture:** Reuse the already-built Slack ingress. The events webhook (`app/api/slack/events/route.ts`) already recognises DMs (`parseSlackEvent` → `kind: "dm"`), dedups by `event_id`, and posts via `postMessage`. This plan (1) adds an `@mention` parse variant, (2) adds a pure allowlist gate, (3) adds a thin `askAgent(text)` wrapper over `runAgent` restricted to read tools, and (4) wires the DM + mention branches of the route to call it. Execution stays **inline** (the codebase's deliberate choice — `after()` is unreliable on Vercel); Slack's 3s-ack retries are neutralised by the existing `event_id` claim, and the loop's ~50s budget stays under the Vercel 60s cap.

**Tech Stack:** TypeScript (strict), Next.js 16 route handler, `@anthropic-ai/sdk` (via Phase-B `lib/agent/loop.ts`), Vitest (`server-only`→`empty.js` alias). Reuses Phase A (`lib/jira.ts`, `lib/jiraRouting.ts`) + Phase B (`lib/agent/loop.ts`, `lib/agent/tools/*`).

## Global Constraints

- **Read-only in Slack (this increment):** the Slack path passes ONLY `kind: "read"` tools to `runAgent`. Write tools (`jira_create` etc.) are never offered over Slack in C.1 — confirm-first writes over Slack are C.2. This avoids posting a write proposal the bot cannot yet apply.
- **Allowlist:** a Slack user is allowed iff `personForSlackId(userId)` resolves (they are in `lib/people.ts`). An unknown user gets a fixed Ukrainian refusal and no agent run. (Design: broader than the 2 approvers — the whole roster.)
- **Fail loud on missing key:** if `ANTHROPIC_API_KEY` is absent, `askAgent` throws a clear error (the console has been bitten by a silent no-op when this env var is missing on Vercel). The route surfaces it, never silently no-ops.
- **No regression:** the existing verdict/approver (S7) and question (S6) thread-reply handling, and the `/help` DM reply, MUST keep working unchanged. DM + mention agent handling is added *alongside*, and the DM `/help` cheat-sheet still answers a help request.
- **Inline execution + `event_id` dedup:** do NOT introduce `after()`/`waitUntil`. Claim the event before running (existing pattern) so a Slack retry dedups to one run.
- **Language:** the loop already mirrors the user's language for answers; the allowlist refusal is fixed Ukrainian.
- TypeScript `strict`; no `any` in exported signatures. Pure libs stay pure + unit-tested. Frequent commits — one per task.

## Scope

- **In:** `@mention` parsing + mention-strip; allowlist gate; `askAgent` (read-only loop wrapper, fail-loud on missing key); wiring the DM + mention route branches; unit tests for the pure/mocked pieces.
- **Deferred to C.2:** confirm-first **writes** over Slack (DB `proposals` generalization + a Slack confirm turn), `agent_threads` multi-turn follow-ups (no re-tag), the read-only web **Assistant** tab. Operator Slack-app config (event subscriptions + scopes) is an out-of-code prerequisite, documented in Open items.

## File Structure

- Create `lib/agent/access.ts` — pure allowlist gate + Ukrainian refusal.
- Modify `lib/slackEventParse.ts` — add `kind: "mention"` + `stripBotMention()`.
- Create `lib/agent/slackAgent.ts` — `askAgent(text)`: read-only `runAgent` wrapper, fail-loud.
- Modify `lib/outboundKeys.ts` — add `agentReplyKey`.
- Modify `app/api/slack/events/route.ts` — route DM (non-help) + mention → `askAgent` → post.
- Tests: `lib/agent/access.test.ts`, `lib/slackEventParse.test.ts` (extend), `lib/agent/slackAgent.test.ts`.
- Modify `CLAUDE.md` — note the Slack Q&A surface.

---

### Task 1: Allowlist gate (`lib/agent/access.ts`)

Pure gate over the existing `personForSlackId` registry, plus the fixed Ukrainian refusal string the route posts to an unknown user.

**Files:**
- Create: `lib/agent/access.ts`
- Test: `lib/agent/access.test.ts`

**Interfaces:**
- Consumes: `personForSlackId` (`lib/people.ts`).
- Produces:
  - `function isAllowedSlackUser(userId: string): boolean`
  - `const AGENT_REFUSAL_UK: string`

- [ ] **Step 1: Write the failing test**

Create `lib/agent/access.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isAllowedSlackUser, AGENT_REFUSAL_UK } from "./access";
import { PEOPLE } from "../people";

describe("isAllowedSlackUser", () => {
  it("allows a known roster Slack id", () => {
    const known = PEOPLE.find((p) => p.slackId)!.slackId!;
    expect(isAllowedSlackUser(known)).toBe(true);
  });
  it("refuses an unknown id and empty input", () => {
    expect(isAllowedSlackUser("U_NOT_REAL")).toBe(false);
    expect(isAllowedSlackUser("")).toBe(false);
  });
});

describe("AGENT_REFUSAL_UK", () => {
  it("is a non-empty Ukrainian string", () => {
    expect(AGENT_REFUSAL_UK.length).toBeGreaterThan(0);
    expect(AGENT_REFUSAL_UK).toMatch(/[іїєґА-Яа-я]/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/agent/access.test.ts`
Expected: FAIL — `Cannot find module './access'`.

- [ ] **Step 3: Implement `lib/agent/access.ts`**

```ts
/**
 * Who may talk to the Slack agent. Pure — reuses the hardcoded people registry
 * (lib/people.ts): anyone with a Slack id in the roster is allowed (broader than
 * the 2 verdict approvers). An unknown user gets a fixed Ukrainian refusal.
 */
import { personForSlackId } from "../people";

export function isAllowedSlackUser(userId: string): boolean {
  if (!userId) return false;
  return personForSlackId(userId) !== undefined;
}

export const AGENT_REFUSAL_UK =
  "Вибач, я тебе не впізнаю — не можу виконати запит. Звернись до адміністратора, щоб тебе додали.";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/agent/access.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/access.ts lib/agent/access.test.ts
git commit -m "feat(agent): Slack allowlist gate (roster) + Ukrainian refusal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Parse `@mention` events (`lib/slackEventParse.ts`)

Add an `app_mention` → `kind: "mention"` branch and a pure `stripBotMention()` that removes a leading `<@BOTID>` token so the agent sees the plain question. Threads to the mention's own ts when it is a top-level mention.

**Files:**
- Modify: `lib/slackEventParse.ts`
- Test: `lib/slackEventParse.test.ts` (extend)

**Interfaces:**
- Produces (added to the existing exports):
  - a new union member `{ kind: "mention"; eventId: string | null; channelId: string; userId: string; text: string; ts: string; threadTs: string }`
  - `function stripBotMention(text: string): string`

- [ ] **Step 1: Write the failing test (append to `lib/slackEventParse.test.ts`)**

Add these cases (keep all existing tests):

```ts
import { parseSlackEvent, stripBotMention } from "./slackEventParse";

describe("app_mention → mention", () => {
  it("parses a top-level mention, threadTs defaults to its own ts", () => {
    const p = parseSlackEvent({
      type: "event_callback",
      event_id: "Ev1",
      event: { type: "app_mention", user: "U1", text: "<@U0BOT> what was done in jira today", ts: "111.1", channel: "C1" },
    });
    expect(p).toEqual({
      kind: "mention",
      eventId: "Ev1",
      channelId: "C1",
      userId: "U1",
      text: "<@U0BOT> what was done in jira today",
      ts: "111.1",
      threadTs: "111.1",
    });
  });

  it("uses thread_ts when the mention is inside a thread", () => {
    const p = parseSlackEvent({
      type: "event_callback",
      event: { type: "app_mention", user: "U1", text: "<@U0BOT> hi", ts: "222.2", thread_ts: "200.0", channel: "C1" },
    });
    expect(p.kind).toBe("mention");
    if (p.kind === "mention") expect(p.threadTs).toBe("200.0");
  });

  it("ignores a bot's own app_mention (bot_id present)", () => {
    const p = parseSlackEvent({
      type: "event_callback",
      event: { type: "app_mention", bot_id: "B1", user: "U1", text: "<@U0BOT> x", ts: "1.1", channel: "C1" },
    });
    expect(p.kind).toBe("skip");
  });
});

describe("stripBotMention", () => {
  it("removes a leading mention token and trims", () => {
    expect(stripBotMention("<@U0BOT> what was done")).toBe("what was done");
    expect(stripBotMention("  <@U0BOT>   spaced  ")).toBe("spaced");
  });
  it("leaves text without a leading mention unchanged", () => {
    expect(stripBotMention("no mention here")).toBe("no mention here");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/slackEventParse.test.ts`
Expected: FAIL — `stripBotMention` is not exported / `kind: "mention"` not produced.

- [ ] **Step 3: Implement in `lib/slackEventParse.ts`**

Add `mention` to the `ParsedSlackEvent` union (after the `dm` member):

```ts
  | { kind: "mention"; eventId: string | null; channelId: string; userId: string; text: string; ts: string; threadTs: string }
```

Add the parse branch inside `parseSlackEvent`, BEFORE the DM branch (an `app_mention` is its own event type, never a DM):

```ts
  // An @mention of the bot in any channel → run the agent. Bot's own posts carry
  // bot_id and are ignored (no self-mention loop). threadTs = thread when the
  // mention is a reply, else the mention's own ts (so the answer threads under it).
  if (e?.type === "app_mention" && !e.bot_id && e.user && e.ts && e.channel) {
    return {
      kind: "mention",
      eventId: body.event_id ?? null,
      channelId: e.channel,
      userId: e.user,
      text: e.text ?? "",
      ts: e.ts,
      threadTs: e.thread_ts ?? e.ts,
    };
  }
```

Add the exported helper at the end of the file:

```ts
/** Remove a single leading Slack mention token (`<@U…>`/`<@U…|name>`) and trim. */
export function stripBotMention(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*/, "").trim();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/slackEventParse.test.ts`
Expected: PASS (existing + new cases).

- [ ] **Step 5: Commit**

```bash
git add lib/slackEventParse.ts lib/slackEventParse.test.ts
git commit -m "feat(agent): parse app_mention → mention + stripBotMention

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Read-only agent wrapper (`lib/agent/slackAgent.ts`)

A thin server-side wrapper: fail loud if `ANTHROPIC_API_KEY` is missing, then run the Phase-B loop with ONLY read tools and a bounded iteration count, returning the answer text. Keeps the route handler small and is unit-testable with a mocked `runAgent`.

**Files:**
- Create: `lib/agent/slackAgent.ts`
- Test: `lib/agent/slackAgent.test.ts`

**Interfaces:**
- Consumes: `runAgent`, `type AgentResult` (`./loop`); `jiraTools` (`./tools/jira`).
- Produces: `async function askAgent(text: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `lib/agent/slackAgent.test.ts` (mocks `./loop` with the repo's `vi.hoisted` pattern):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock("./loop", () => ({ runAgent: runAgentMock }));

import { askAgent } from "./slackAgent";
import { jiraTools } from "./tools/jira";

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  runAgentMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("askAgent", () => {
  it("passes ONLY read tools to runAgent and returns its text", async () => {
    runAgentMock.mockResolvedValue({ kind: "text", text: "ATP-7 [Done] Fix" });
    const out = await askAgent("what was done today");
    expect(out).toBe("ATP-7 [Done] Fix");
    const opts = runAgentMock.mock.calls[0][1] as { tools: { kind: string }[] };
    expect(opts.tools.length).toBeGreaterThan(0);
    expect(opts.tools.every((t) => t.kind === "read")).toBe(true);
    // sanity: there IS at least one write tool in the full set that we excluded
    expect(jiraTools.some((t) => t.kind === "write")).toBe(true);
  });

  it("returns the loop's text for an error result too (already Ukrainian)", async () => {
    runAgentMock.mockResolvedValue({ kind: "error", text: "Вибач, не встиг." });
    expect(await askAgent("x")).toBe("Вибач, не встиг.");
  });

  it("throws loudly when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(askAgent("x")).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(runAgentMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/agent/slackAgent.test.ts`
Expected: FAIL — `Cannot find module './slackAgent'`.

- [ ] **Step 3: Implement `lib/agent/slackAgent.ts`**

```ts
/**
 * Slack-facing wrapper over the Phase-B agent loop. Runs the loop with ONLY read
 * tools (Slack C.1 is read-only — no confirm-first writes yet) and a bounded
 * iteration count, and fails loud when ANTHROPIC_API_KEY is missing (the console
 * has been bitten by a silent no-op when this env var is absent on Vercel).
 *
 * SERVER-ONLY reachable (loop + tools read env). Tests mock ./loop.
 */
import { runAgent } from "./loop";
import { jiraTools } from "./tools/jira";

/** Slack answers use a slightly tighter iteration bound than the CLI default. */
const SLACK_MAX_ITERS = 6;

export async function askAgent(text: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set on the server.");
  }
  const readTools = jiraTools.filter((t) => t.kind === "read");
  const result = await runAgent(text, { tools: readTools, maxIters: SLACK_MAX_ITERS });
  return result.text;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/agent/slackAgent.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/slackAgent.ts lib/agent/slackAgent.test.ts
git commit -m "feat(agent): askAgent — read-only Slack loop wrapper, fail-loud on missing key

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire the route + outbound key + docs

Route a non-help DM and an @mention to `askAgent`, gated by the allowlist, and post the answer. Keep `/help` and the existing verdict/ask handlers untouched.

**Files:**
- Modify: `lib/outboundKeys.ts` (add `agentReplyKey`)
- Modify: `app/api/slack/events/route.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `isAllowedSlackUser`, `AGENT_REFUSAL_UK` (`@/lib/agent/access`); `askAgent` (`@/lib/agent/slackAgent`); `stripBotMention` (`@/lib/slackEventParse`); `postMessage` (`@/lib/slack`); `claimSlackEvent` (existing); `agentReplyKey` (new).
- Produces: `const agentReplyKey = (userId: string, ts: string): string`

- [ ] **Step 1: Add the outbound key**

In `lib/outboundKeys.ts`, after `dmHelpKey`, add:

```ts
export const agentReplyKey = (userId: string, ts: string): string => `agent:${userId}:${ts}`;
```

- [ ] **Step 2: Extend the events route**

In `app/api/slack/events/route.ts`:

(a) Extend the imports:

```ts
import { formatDmHelp } from "@/lib/dmHelp";
import { isAllowedSlackUser, AGENT_REFUSAL_UK } from "@/lib/agent/access";
import { askAgent } from "@/lib/agent/slackAgent";
import { stripBotMention } from "@/lib/slackEventParse";
import { contentRev, dmHelpKey, agentReplyKey, webhookFailureKey } from "@/lib/outboundKeys";
```

(b) Add a shared helper (above `POST`) that claims the event, gates, runs, and posts. Placed near `failVisibly`:

```ts
/** DM/mention → agent. Claims the event (dedup), gates on the allowlist, runs the
 *  read-only agent, and posts the answer. Inline (Slack retries dedup on event_id;
 *  the loop's ~50s budget stays under Vercel's 60s cap). Info-only in C.1. */
async function runAgentReply(
  channelId: string,
  userId: string,
  question: string,
  ts: string,
  eventId: string | null,
  threadTs: string | undefined,
  surface: "dm" | "mention",
): Promise<Response> {
  if (eventId) {
    const fresh = await claimSlackEvent(eventId, new Date().toISOString(), { eventType: "message" });
    if (!fresh) return ack({ skipped: "duplicate-event", event_id: eventId });
  }
  if (!isAllowedSlackUser(userId)) {
    try {
      await postMessage(channelId, AGENT_REFUSAL_UK, { key: agentReplyKey(userId, ts), feature: "agent", channel: surface, trigger: "webhook" }, threadTs);
    } catch (err) {
      console.error("slack events: refusal post failed:", err);
    }
    return ack({ handled: "agent", refused: true, user: userId });
  }
  try {
    const answer = await askAgent(question);
    await postMessage(channelId, answer, { key: agentReplyKey(userId, ts), feature: "agent", channel: surface, trigger: "webhook" }, threadTs);
    console.log(`slack events: agent (${surface}) replied to ${userId}`);
    return ack({ handled: "agent", surface, user: userId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`slack events: agent (${surface}) failed:`, err);
    try {
      await postMessage(channelId, formatWebhookFailureNotice(message), { key: agentReplyKey(userId, `${ts}:err`), feature: "webhook-failure", channel: surface, trigger: "webhook" }, threadTs);
    } catch (postErr) {
      console.error("slack events: agent failure notice post failed:", postErr);
    }
    return ack({ handled: "agent", surface, error: message });
  }
}
```

(c) Add the mention branch immediately after the `parsed.kind === "skip"` early return and BEFORE the DM branch:

```ts
  // An @mention anywhere → the conversational agent (read-only in C.1).
  if (parsed.kind === "mention") {
    return await runAgentReply(
      parsed.channelId,
      parsed.userId,
      stripBotMention(parsed.text),
      parsed.ts,
      parsed.eventId,
      parsed.threadTs,
      "mention",
    );
  }
```

(d) Replace the body of the existing `if (parsed.kind === "dm") { ... }` block so a help request still gets the cheat sheet, and anything else goes to the agent. Keep the existing event claim for the help path; the agent path claims inside `runAgentReply`:

```ts
  if (parsed.kind === "dm") {
    const q = parsed.text.trim();
    const isHelp = q === "" || /^\/?help\??$/i.test(q);
    if (!isHelp) {
      return await runAgentReply(parsed.channelId, parsed.userId, q, parsed.ts, parsed.eventId, undefined, "dm");
    }
    if (parsed.eventId) {
      const fresh = await claimSlackEvent(parsed.eventId, new Date().toISOString(), { eventType: "message" });
      if (!fresh) return ack({ skipped: "duplicate-event", event_id: parsed.eventId });
    }
    try {
      await postMessage(parsed.channelId, formatDmHelp(), {
        key: dmHelpKey(parsed.userId, parsed.ts),
        feature: "help",
        channel: "dm",
        trigger: "webhook",
      });
      console.log(`slack events: dm-help replied to ${parsed.userId} in ${parsed.channelId}`);
      return ack({ handled: "dm-help", user: parsed.userId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("slack events: dm-help post failed:", err);
      return ack({ handled: "dm-help", error: message });
    }
  }
```

- [ ] **Step 3: Confirm the suite, lint, and build pass**

Run: `npm test && npm run lint && npm run build`
Expected: full suite passes (existing + new tests); no new lint errors; the Next build compiles the route with the new imports.

- [ ] **Step 4: Document in `CLAUDE.md`**

Under `## Commands`, extend the `npm run agent` bullet's tail (or add a sentence after it):

```markdown
  - **In Slack (Phase C.1, read-only):** DM the bot a question or @mention it in a channel and it answers via the same loop (read tools only — `jira_search`). Gated by the `lib/people.ts` roster allowlist (unknown users get a Ukrainian refusal). Handled inline in `app/api/slack/events/route.ts` (mention/DM branches → `askAgent`), deduped by `event_id`. Confirm-first **writes** over Slack, thread follow-ups, and the web Assistant tab are C.2. Operator prerequisite: subscribe the Slack app to `app_mention` + `message.im` events and add scopes `app_mentions:read`, `im:history`, `im:read`, `im:write` (plus the existing `chat:write`).
```

- [ ] **Step 5: Commit**

```bash
git add app/api/slack/events/route.ts lib/outboundKeys.ts CLAUDE.md
git commit -m "feat(agent): Slack ingress — DM + @mention route to read-only agent (Phase C.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Phase C.1 scope):**
- Ingress for DM + @mention → agent → Task 2 (mention parse) + Task 4 (route). ✓
- Allowlist gate (roster) + Ukrainian refusal → Task 1 + Task 4. ✓
- Read-only tool restriction → Task 3 (`askAgent` filters to `kind: "read"`). ✓
- Fail-loud on missing `ANTHROPIC_API_KEY` → Task 3 + route error path. ✓
- No regression to S6/S7 + `/help` → Task 4 keeps the verdict/ask handlers and the help reply; agent branches added alongside. ✓
- Inline + `event_id` dedup (no `after()`) → Task 4 (`runAgentReply` claims before running). ✓
- Deferred (documented in Scope, not gaps): Slack writes/confirm-first, `agent_threads` follow-ups, web Assistant tab.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The Next `build` is the integration check for the route (whose full behavior needs live Slack + keys — a manual smoke, not automatable here). ✓

**Type consistency:** `isAllowedSlackUser`/`AGENT_REFUSAL_UK` (Task 1) consumed in Task 4. `kind:"mention"` + `stripBotMention` (Task 2) consumed in Task 4. `askAgent` (Task 3) consumed in Task 4. `agentReplyKey` (Task 4 Step 1) consumed in Task 4 Step 2. `postMessage(channelId, text, meta, threadTs?)` matches `lib/slack.ts`. `runAgent(text, { tools, maxIters })` + `AgentResult.text` match `lib/agent/loop.ts`. ✓

## Open items (operator / follow-on)

- **Operator (no code):** in the Slack app config, subscribe to `app_mention` + `message.im` events and add scopes `app_mentions:read`, `im:history`, `im:read`, `im:write`. Set `ANTHROPIC_API_KEY` + `JIRA_*` on Vercel (already required elsewhere). Without the subscriptions Slack never delivers a mention/DM; without the key `askAgent` fails loud into the thread.
- **C.2:** confirm-first writes over Slack (generalize the `proposals` table with a `jira_write` kind storing the structured tool call + `source_reply_ts` idempotency; a Slack confirm turn applies it), `agent_threads` for no-re-tag thread follow-ups, and the read-only web **Assistant** tab (`GET /api/assistant`).
- Carried from Phase B: a mixed read+write turn currently stops at the write (reads in the same turn are dropped) — irrelevant while Slack is read-only, but must be handled when C.2 enables writes.
