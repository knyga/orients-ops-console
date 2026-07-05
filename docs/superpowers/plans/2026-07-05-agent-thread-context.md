# Agent Thread-Context Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the bot is @mentioned inside a Slack thread, fetch the thread's messages live and prepend a capped transcript to the agent's question, so "create a jira ticket from this thread" works with full context.

**Architecture:** A new server-only helper `fetchThreadMessages` in `lib/slack.ts` pages `conversations.replies` for one thread. A new `lib/agent/threadContext.ts` formats a capped, roster-name-resolved transcript (pure `formatThreadContext` + `parseThreadRef`, plus a `fetchThreadContext` glue). `/api/agent/run` prepends the block to the question when `threadTs` is present. The CLI `npm run agent` gains `--thread <ref>` using the same module.

**Tech Stack:** Next.js 16 App Router (nodejs runtime), TypeScript strict, Vitest (server-only aliased to an empty module in `vitest.config.ts`; mock deps with `vi.hoisted` — house pattern).

**Spec:** `docs/superpowers/specs/2026-07-05-agent-thread-context-design.md`

## Global Constraints

- `lib/slack.ts` is SERVER-ONLY (`import "server-only"`); the CLI runs under `--conditions=react-server` so that import resolves to its empty module.
- Import alias `@/*` maps to the repo root.
- Thread-context fetch failure must NEVER fail the agent turn — log and proceed without context.
- Agent memory (`appendTurn`) stores the ORIGINAL question, not the augmented one.
- Caps: last 40 messages, ~8 000 chars (drop oldest first).
- All user-facing bot copy is Ukrainian; the transcript header is `Контекст треду (Slack):`.
- Commit after every task; run `npx vitest run <file>` per task and `npm test` + `npm run lint` at the end.

---

### Task 1: `fetchThreadMessages` in `lib/slack.ts`

**Files:**
- Modify: `lib/slack.ts` (add after `fetchRawMessages`, ~line 307)
- Test: `lib/slackThread.test.ts` (create)

**Interfaces:**
- Produces: `export interface ThreadMessage { ts: string; user?: string; botId?: string; text: string }` and `export async function fetchThreadMessages(channelId: string, threadTs: string): Promise<ThreadMessage[]>` — oldest-first, **parent included first** (unlike `fetchRawMessages`, which skips it).

- [ ] **Step 1: Write the failing test**

Create `lib/slackThread.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchThreadMessages } from "./slack";

function slackResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    headers: new Headers(),
  } as Response;
}

describe("fetchThreadMessages", () => {
  beforeEach(() => {
    process.env.SLACK_TOKEN = "xoxb-test";
    vi.restoreAllMocks();
  });

  it("pages conversations.replies and keeps the parent first", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        slackResponse({
          ok: true,
          messages: [
            { ts: "1.000", user: "U1", text: "parent" },
            { ts: "2.000", user: "U2", text: "reply one" },
          ],
          response_metadata: { next_cursor: "abc" },
        }),
      )
      .mockResolvedValueOnce(
        slackResponse({
          ok: true,
          messages: [{ ts: "3.000", bot_id: "B1", text: "bot reply" }],
        }),
      );

    const out = await fetchThreadMessages("C123", "1.000");
    expect(out).toEqual([
      { ts: "1.000", user: "U1", botId: undefined, text: "parent" },
      { ts: "2.000", user: "U2", botId: undefined, text: "reply one" },
      { ts: "3.000", user: undefined, botId: "B1", text: "bot reply" },
    ]);

    const firstUrl = String(fetchMock.mock.calls[0][0]);
    expect(firstUrl).toContain("conversations.replies");
    expect(firstUrl).toContain("channel=C123");
    expect(firstUrl).toContain("ts=1.000");
    const secondUrl = String(fetchMock.mock.calls[1][0]);
    expect(secondUrl).toContain("cursor=abc");
  });

  it("throws SlackError when Slack rejects the call", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      slackResponse({ ok: false, error: "channel_not_found" }),
    );
    await expect(fetchThreadMessages("C404", "1.000")).rejects.toThrow(/channel_not_found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/slackThread.test.ts`
Expected: FAIL — `fetchThreadMessages` is not exported from `./slack`.

- [ ] **Step 3: Write minimal implementation**

In `lib/slack.ts`, add after `fetchRawMessages` (before `downloadFileBase64`):

```typescript
/** One message of a single thread, as fetchThreadMessages returns it. */
export interface ThreadMessage {
  ts: string;
  user?: string;
  botId?: string;
  text: string;
}

/**
 * Fetch ONE thread's messages (parent first, then replies, oldest-first) via
 * conversations.replies. Live — used by the agent's thread-context injection,
 * which runs on Vercel where the local mirror files don't exist.
 */
export async function fetchThreadMessages(
  channelId: string,
  threadTs: string,
): Promise<ThreadMessage[]> {
  token();
  const out: ThreadMessage[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ channel: channelId, ts: threadTs, limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const page = await call<RawHistoryResponse>("conversations.replies", params);
    for (const m of page.messages ?? []) {
      out.push({ ts: m.ts, user: m.user, botId: m.bot_id, text: m.text ?? "" });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}
```

(`RawHistoryMessage` already carries `user?`, `bot_id?`, `ts`, `text?` — no interface changes needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/slackThread.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/slack.ts lib/slackThread.test.ts
git commit -m "feat(slack): fetchThreadMessages — live single-thread reader"
```

---

### Task 2: `lib/agent/threadContext.ts` — format + parse + fetch glue

**Files:**
- Create: `lib/agent/threadContext.ts`
- Test: `lib/agent/threadContext.test.ts`

**Interfaces:**
- Consumes: `fetchThreadMessages(channelId, threadTs): Promise<ThreadMessage[]>` and `type ThreadMessage` from `@/lib/slack` (Task 1); `personForSlackId(id): Person | undefined` from `@/lib/people`.
- Produces:
  - `export function formatThreadContext(messages: ThreadMessage[], opts?: { excludeTs?: string[]; maxMessages?: number; maxChars?: number }): string | null`
  - `export function parseThreadRef(ref: string): { channelId: string; threadTs: string } | null`
  - `export async function fetchThreadContext(channelId: string, threadTs: string, excludeTs?: string[]): Promise<string | null>`

- [ ] **Step 1: Write the failing tests**

Create `lib/agent/threadContext.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ fetchThreadMessages: vi.fn() }));
vi.mock("@/lib/slack", () => ({ fetchThreadMessages: h.fetchThreadMessages }));

import { formatThreadContext, parseThreadRef, fetchThreadContext } from "./threadContext";

// U08G4EC244X is Oleksandr K in the real lib/people.ts registry.
const KNOWN = "U08G4EC244X";

describe("formatThreadContext", () => {
  it("renders oldest-first with roster names, raw <@U…> for unknowns, [бот] for bots", () => {
    const out = formatThreadContext([
      { ts: "1.0", user: KNOWN, text: "перше" },
      { ts: "2.0", user: "U_UNKNOWN", text: "друге" },
      { ts: "3.0", botId: "B1", text: "від бота" },
    ]);
    expect(out).toBe(
      "Контекст треду (Slack):\n[Oleksandr K]: перше\n[<@U_UNKNOWN>]: друге\n[бот]: від бота",
    );
  });

  it("excludes excludeTs messages (the incoming mention + placeholder)", () => {
    const out = formatThreadContext(
      [
        { ts: "1.0", user: KNOWN, text: "context" },
        { ts: "9.0", user: "U2", text: "@bot створи тікет" },
        { ts: "9.1", botId: "B1", text: "🤔 думаю…" },
      ],
      { excludeTs: ["9.0", "9.1"] },
    );
    expect(out).toBe("Контекст треду (Slack):\n[Oleksandr K]: context");
  });

  it("returns null when nothing remains", () => {
    expect(formatThreadContext([], {})).toBeNull();
    expect(formatThreadContext([{ ts: "9.0", user: "U2", text: "hi" }], { excludeTs: ["9.0"] })).toBeNull();
  });

  it("keeps only the newest maxMessages and notes the drop", () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      ts: `${i}.0`,
      user: "U2",
      text: `msg${i}`,
    }));
    const out = formatThreadContext(msgs, { maxMessages: 2 });
    expect(out).toBe(
      "Контекст треду (Slack):\n(3 старіших повідомлень пропущено)\n[<@U2>]: msg3\n[<@U2>]: msg4",
    );
  });

  it("drops oldest lines until under maxChars", () => {
    const msgs = [
      { ts: "1.0", user: "U2", text: "a".repeat(100) },
      { ts: "2.0", user: "U2", text: "b".repeat(100) },
      { ts: "3.0", user: "U2", text: "tail" },
    ];
    const out = formatThreadContext(msgs, { maxChars: 150 })!;
    expect(out).toContain("tail");
    expect(out).not.toContain("a".repeat(100));
    expect(out).toContain("пропущено");
    expect(out.length).toBeLessThanOrEqual(150 + "Контекст треду (Slack):\n(2 старіших повідомлень пропущено)\n".length);
  });
});

describe("parseThreadRef", () => {
  it("parses channelId:ts", () => {
    expect(parseThreadRef("C09M551C9UK:1783244631.100559")).toEqual({
      channelId: "C09M551C9UK",
      threadTs: "1783244631.100559",
    });
  });

  it("parses a Slack permalink", () => {
    expect(
      parseThreadRef("https://orientsai.slack.com/archives/C09M551C9UK/p1783244631100559"),
    ).toEqual({ channelId: "C09M551C9UK", threadTs: "1783244631.100559" });
  });

  it("prefers the thread_ts query param on a reply permalink", () => {
    expect(
      parseThreadRef(
        "https://orientsai.slack.com/archives/C09M551C9UK/p1783250000123456?thread_ts=1783244631.100559&cid=C09M551C9UK",
      ),
    ).toEqual({ channelId: "C09M551C9UK", threadTs: "1783244631.100559" });
  });

  it("returns null on garbage", () => {
    expect(parseThreadRef("not-a-ref")).toBeNull();
    expect(parseThreadRef("https://example.com/foo")).toBeNull();
  });
});

describe("fetchThreadContext", () => {
  it("fetches and formats, passing excludeTs through", async () => {
    h.fetchThreadMessages.mockResolvedValue([
      { ts: "1.0", user: KNOWN, text: "context" },
      { ts: "9.0", user: "U2", text: "mention" },
    ]);
    const out = await fetchThreadContext("C1", "1.0", ["9.0"]);
    expect(h.fetchThreadMessages).toHaveBeenCalledWith("C1", "1.0");
    expect(out).toBe("Контекст треду (Slack):\n[Oleksandr K]: context");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agent/threadContext.test.ts`
Expected: FAIL — cannot resolve `./threadContext`.

- [ ] **Step 3: Write the implementation**

Create `lib/agent/threadContext.ts`:

```typescript
/**
 * Thread-context injection for the Slack agent (and its CLI twin).
 *
 * When the bot is @mentioned inside a thread, the agent loop otherwise sees only
 * the mention text + its own memory — never the surrounding human messages. This
 * module fetches the thread LIVE (the local Slack mirror is not on Vercel) and
 * renders a capped, oldest-first transcript that /api/agent/run prepends to the
 * question. formatThreadContext/parseThreadRef are pure; fetchThreadContext is
 * the server-only glue (via @/lib/slack).
 */
import { fetchThreadMessages, type ThreadMessage } from "@/lib/slack";
import { personForSlackId } from "@/lib/people";

const HEADER = "Контекст треду (Slack):";
const DEFAULT_MAX_MESSAGES = 40;
const DEFAULT_MAX_CHARS = 8_000;

export interface ThreadContextOptions {
  /** ts values to omit — the incoming mention and the bot's «думаю…» placeholder. */
  excludeTs?: string[];
  maxMessages?: number;
  maxChars?: number;
}

function authorLabel(m: ThreadMessage): string {
  if (m.user) return personForSlackId(m.user)?.name ?? `<@${m.user}>`;
  return "бот";
}

/** Render the transcript block, or null when no messages survive the filters. */
export function formatThreadContext(
  messages: ThreadMessage[],
  opts: ThreadContextOptions = {},
): string | null {
  const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const excluded = new Set(opts.excludeTs ?? []);

  const kept = messages.filter((m) => !excluded.has(m.ts));
  if (kept.length === 0) return null;

  let lines = kept.map((m) => `[${authorLabel(m)}]: ${m.text}`);
  let dropped = 0;
  if (lines.length > maxMessages) {
    dropped = lines.length - maxMessages;
    lines = lines.slice(dropped);
  }
  // Drop oldest lines until the body fits the char budget.
  while (lines.length > 1 && lines.join("\n").length > maxChars) {
    lines.shift();
    dropped += 1;
  }

  const parts = [HEADER];
  if (dropped > 0) parts.push(`(${dropped} старіших повідомлень пропущено)`);
  parts.push(...lines);
  return parts.join("\n");
}

/**
 * Parse a thread reference: either "C123:1783244631.100559" or a Slack permalink
 * (https://…/archives/<CHANNEL>/p<16 digits>[?thread_ts=…]). A reply permalink's
 * thread_ts query param (the ROOT of the thread) wins over the p-ts.
 */
export function parseThreadRef(ref: string): { channelId: string; threadTs: string } | null {
  const pair = /^([A-Z][A-Z0-9]{6,}):(\d{10}\.\d{6})$/.exec(ref);
  if (pair) return { channelId: pair[1], threadTs: pair[2] };

  const url = /\/archives\/([A-Z][A-Z0-9]{6,})\/p(\d{16})/.exec(ref);
  if (!url) return null;
  const fromQuery = /[?&]thread_ts=(\d{10}\.\d{6})/.exec(ref)?.[1];
  const pTs = `${url[2].slice(0, 10)}.${url[2].slice(10)}`;
  return { channelId: url[1], threadTs: fromQuery ?? pTs };
}

/** Live fetch + format. Callers treat a throw as "proceed without context". */
export async function fetchThreadContext(
  channelId: string,
  threadTs: string,
  excludeTs?: string[],
): Promise<string | null> {
  const messages = await fetchThreadMessages(channelId, threadTs);
  return formatThreadContext(messages, { excludeTs });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/agent/threadContext.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/threadContext.ts lib/agent/threadContext.test.ts
git commit -m "feat(agent): thread-context transcript — format, permalink parse, live fetch"
```

---

### Task 3: Wire into `/api/agent/run`

**Files:**
- Modify: `app/api/agent/run/route.ts`
- Test: `app/api/agent/run/route.test.ts` (extend)

**Interfaces:**
- Consumes: `fetchThreadContext(channelId, threadTs, excludeTs?): Promise<string | null>` from `@/lib/agent/threadContext` (Task 2).
- Produces: no new exports — behavior change only. `runSlackTurn` receives `"<context>\n\n<question>"` when `threadTs` is present and context is non-null; `appendTurn` keeps storing the ORIGINAL question.

- [ ] **Step 1: Write the failing tests**

In `app/api/agent/run/route.test.ts`:

Add to the `vi.hoisted` block (line 3-9):

```typescript
const h = vi.hoisted(() => ({
  runSlackTurn: vi.fn(),
  loadTranscript: vi.fn(),
  appendTurn: vi.fn(),
  insertPending: vi.fn(),
  updateMessage: vi.fn(),
  fetchThreadContext: vi.fn(),
}));
```

Add after the existing `vi.mock` calls (line 17):

```typescript
vi.mock("@/lib/agent/threadContext", () => ({ fetchThreadContext: h.fetchThreadContext }));
```

Add inside `beforeEach` (after `h.loadTranscript.mockResolvedValue([]);`):

```typescript
h.fetchThreadContext.mockResolvedValue(null);
```

Add these tests at the end of the `describe` block:

```typescript
  it("mention with threadTs → prepends the thread transcript to the question", async () => {
    h.fetchThreadContext.mockResolvedValue("Контекст треду (Slack):\n[Oleksandr K]: bug details");
    h.runSlackTurn.mockResolvedValue({ kind: "text", text: "answer" });
    const mentionReq = {
      surface: "mention",
      conversationKey: "111.222",
      channelId: "C-issue-log",
      userId: "U1",
      incomingTs: "111.900",
      placeholderTs: "111.901",
      threadTs: "111.222",
      question: "створи тікет з цього треду",
    };
    const res = await POST(req(mentionReq));
    expect(res.status).toBe(200);
    expect(h.fetchThreadContext).toHaveBeenCalledWith("C-issue-log", "111.222", ["111.900", "111.901"]);
    expect(h.runSlackTurn).toHaveBeenCalledWith(
      "Контекст треду (Slack):\n[Oleksandr K]: bug details\n\nствори тікет з цього треду",
      [],
    );
    // memory stores the ORIGINAL question, not the augmented one
    expect(h.appendTurn).toHaveBeenCalledWith("111.222", "створи тікет з цього треду", "answer");
  });

  it("DM (no threadTs) → never fetches thread context", async () => {
    h.runSlackTurn.mockResolvedValue({ kind: "text", text: "answer" });
    await POST(req(base));
    expect(h.fetchThreadContext).not.toHaveBeenCalled();
    expect(h.runSlackTurn).toHaveBeenCalledWith("q", []);
  });

  it("thread-context fetch failure → turn still runs on the bare question", async () => {
    h.fetchThreadContext.mockRejectedValue(new Error("slack down"));
    h.runSlackTurn.mockResolvedValue({ kind: "text", text: "answer" });
    const res = await POST(req({ ...base, surface: "mention", threadTs: "111.222" }));
    expect(res.status).toBe(200);
    expect(h.runSlackTurn).toHaveBeenCalledWith("q", []);
    expect(h.updateMessage).toHaveBeenCalledWith("C1", "2", "answer", expect.anything());
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run app/api/agent/run/route.test.ts`
Expected: the 3 new tests FAIL (`fetchThreadContext` never called / question not augmented); the existing 7 still pass.

- [ ] **Step 3: Implement**

In `app/api/agent/run/route.ts`:

Add import (after line 16):

```typescript
import { fetchThreadContext } from "@/lib/agent/threadContext";
```

In `POST`, replace:

```typescript
    const history = await loadTranscript(body.conversationKey);
    const result = await runSlackTurn(body.question, history);
```

with:

```typescript
    const history = await loadTranscript(body.conversationKey);
    // A mention/thread turn carries threadTs: inject the surrounding thread as
    // context ("create a ticket from this thread"). Best-effort — a Slack
    // hiccup must not kill the turn. Memory (appendTurn) keeps the original.
    let question = body.question;
    if (body.threadTs) {
      try {
        const ctx = await fetchThreadContext(body.channelId, body.threadTs, [
          body.incomingTs,
          body.placeholderTs,
        ]);
        if (ctx) question = `${ctx}\n\n${body.question}`;
      } catch (err) {
        console.error("agent run: thread-context fetch failed:", err);
      }
    }
    const result = await runSlackTurn(question, history);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/api/agent/run/route.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/agent/run/route.ts app/api/agent/run/route.test.ts
git commit -m "feat(agent): inject live thread transcript into mention/thread turns"
```

---

### Task 4: CLI `--thread` flag + docs

**Files:**
- Modify: `scripts/agent.ts`
- Modify: `CLAUDE.md` (the `npm run agent` bullet)

No new unit tests: the flag parsing delegates to `parseThreadRef` (tested in Task 2) and the fetch to `fetchThreadContext` (glue). Verification is a live CLI run.

**Interfaces:**
- Consumes: `parseThreadRef`, `fetchThreadContext` from `@/lib/agent/threadContext` (Task 2).
- Produces: `npm run agent -- --thread <channelId:ts | permalink URL> "<message>" [--yes]`.

- [ ] **Step 1: Implement the flag**

In `scripts/agent.ts`, replace the whole `main` body's argument parsing and `runAgent` call:

```typescript
import { runAgent } from "../lib/agent/loop";
import { parseThreadRef, fetchThreadContext } from "../lib/agent/threadContext";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const yes = argv.includes("--yes");
  const threadIdx = argv.indexOf("--thread");
  const threadRef = threadIdx >= 0 ? argv[threadIdx + 1] : undefined;
  const rest = argv.filter((a, i) => a !== "--yes" && a !== "--thread" && i !== threadIdx + 1);
  const prompt = rest.join(" ").trim();
  if (!prompt || (threadIdx >= 0 && !threadRef)) {
    console.error('Usage: npm run agent -- "<your message>" [--thread <channelId:ts | permalink>] [--yes]');
    process.exit(1);
  }

  let message = prompt;
  if (threadRef) {
    const ref = parseThreadRef(threadRef);
    if (!ref) {
      console.error(`--thread: cannot parse "${threadRef}" (want C123:1234567890.123456 or a Slack permalink)`);
      process.exit(1);
    }
    const ctx = await fetchThreadContext(ref.channelId, ref.threadTs);
    if (ctx) message = `${ctx}\n\n${prompt}`;
    else console.error("(thread has no messages — running without context)");
  }

  const res = await runAgent(message);
```

(The rest of `main` — the text/proposal/`--yes` handling — is unchanged.)

- [ ] **Step 2: Verify end-to-end (real thread, dry-run)**

Run (needs `SLACK_TOKEN` + `ANTHROPIC_API_KEY` + `JIRA_*` in `.env`):

```bash
npm run agent -- --thread https://orientsai.slack.com/archives/C09M551C9UK/p1783244631100559 "створи джира тікет з цього треду"
```

Expected: a Ukrainian confirm-first `jira_create` proposal whose summary/description reflect the thread's content (NOT applied — no `--yes`). If the env lacks tokens locally, verify at least the parse error path and `--thread` without a value exits 1 with usage.

- [ ] **Step 3: Update CLAUDE.md**

In the `npm run agent` bullet, after the sentence about `--yes`, add:

```
`--thread <channelId:ts | permalink URL>` prepends the live Slack thread's transcript (same `lib/agent/threadContext.ts` the Slack @mention surface uses) so "створи тікет з цього треду" works from the terminal.
```

And in the Phase C.2 sub-bullet (**In Slack:**), after "it answers via the same loop", add:

```
An @mention inside a thread (and plain-thread-reply follow-ups) auto-injects the thread's live transcript (capped, roster-resolved — `lib/agent/threadContext.ts`) into the turn, so "створи джира тікет з цього треду" uses the whole thread as context.
```

- [ ] **Step 4: Full suite + lint**

Run: `npm test && npm run lint`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/agent.ts CLAUDE.md
git commit -m "feat(agent-cli): --thread flag — same thread-context path as Slack"
```
