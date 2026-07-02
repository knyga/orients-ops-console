# Slack Conversational Agent — Phase B Implementation Plan (agent loop + tool registry + CLI twin)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real multi-turn Claude tool-use loop (`lib/agent/loop.ts`) with an extensible tool registry (Jira read + write tools) and a `npm run agent` CLI twin, so that `npm run agent -- "what was done in jira today"` answers from live Jira and `npm run agent -- "create a ticket for Тарас: fix export" --yes` routes + creates a ticket via the confirm-first proposal path — all without any Slack code.

**Architecture:** A pure-ish loop drives `claude-sonnet-5` with a tool set. Each tool declares `{ name, description, inputSchema, kind: "read" | "write", run }`. **Read** tools execute immediately and their result is fed back to the model; a **write** tool_use is NOT executed inside the loop — the loop resolves it into a `Proposal` (structured, resolved params + a Ukrainian echo) and stops, returning it. A deterministic executor (`proposal.apply()`) performs the write on confirmation. The CLI confirms via `--yes`; Phase C will confirm via a Slack "так"/👍 and persist proposals in the DB.

**Tech Stack:** TypeScript (strict), `@anthropic-ai/sdk` ^0.104.2 (already a dep), Vitest (with the `server-only`→`empty.js` alias), `node --conditions=react-server --import tsx` for the CLI. Reuses the Phase A `lib/jira.ts` write client + `lib/jiraRouting.ts`.

## Global Constraints

- Model for the loop is `claude-sonnet-5` (the design's choice — strong tool use, fits the 60s cap). Existing one-shot classifiers use `claude-sonnet-4-6`; the loop is deliberately newer. Define it as a single `const MODEL` in `lib/agent/loop.ts`.
- `lib/agent/loop.ts` and the tool `run` functions are `server-only`-reachable (they read `ANTHROPIC_API_KEY` / `JIRA_*`); the CLI reaches them via `--conditions=react-server`, tests via the vitest `server-only`→`empty.js` alias. Follow the established discipline — do NOT import them from a `"use client"` file.
- The loop NEVER calls a Jira write endpoint directly. A write tool_use becomes a `Proposal`; only `proposal.apply()` (the deterministic executor) writes. This is the confirm-first guarantee.
- Loop guards: **≤ 8 tool iterations** and a **~50 s wall-clock budget**; on overrun return a Ukrainian "не встиг, спробуй ще" text result and stop.
- Language rule (system prompt): **mirror the user's language for free chat / answers; fixed Ukrainian for the write-proposal echo**. Matches house style.
- TypeScript `strict`; no `any` in exported signatures. Tests inject a mocked Anthropic client + mocked `fetch` so no network is hit.
- DRY / YAGNI / TDD / frequent commits — one commit per task.

## Scope (what is and isn't in Phase B)

- **In:** the loop, the registry, `jira_search` (read), `jira_create` / `jira_comment` / `jira_transition` / `jira_update` (write, proposal-gated), the `npm run agent` CLI (one-shot + `--yes`), full unit tests with mocked Anthropic + `fetch`.
- **Deferred to a later Phase-B increment (cheap, registry makes them drop-in):** `console_who`, `console_field_bonus`, `console_jira_report`, `console_github_report`, `slack_search`. They need input-assembly the CLIs currently do inline; not required to prove the loop or answer the driving use case.
- **Deferred to Phase C:** Slack ingress (mention/DM/thread), `agent_threads`, allowlist gate, the DB `proposals` generalization + `source_reply_ts` redelivery idempotency (a Slack concern), and the web Assistant tab.

## File Structure

- Create `lib/agent/tools/types.ts` — the `Tool`, `ToolResult`, `Proposal` types (pure).
- Create `lib/agent/tools/jira.ts` — the Jira read tool + the four write tools (schemas, read `run`, write→`Proposal` builders).
- Create `lib/agent/tools/registry.ts` — assembles the default tool list + `toAnthropicTools()` + `findTool()`.
- Create `lib/agent/loop.ts` — `runAgent()` multi-turn loop + system prompt.
- Create `scripts/agent.ts` — the CLI twin.
- Test: `lib/agent/tools/jira.test.ts`, `lib/agent/loop.test.ts`.
- Modify `package.json` (add `agent` script), `CLAUDE.md` (document it).

---

### Task 1: Tool types + registry (`lib/agent/tools/types.ts`, `registry.ts`)

Defines the tool contract and the registry helpers. Pure (no server-only) so the loop and tools share one vocabulary and tests need no network.

**Files:**
- Create: `lib/agent/tools/types.ts`
- Create: `lib/agent/tools/registry.ts`
- Test: `lib/agent/tools/registry.test.ts`

**Interfaces:**
- Produces:
  - `interface ToolResult { ok: boolean; content: string }`
  - `interface Proposal { kind: string; echoUk: string; apply(): Promise<string> }`
  - `interface Tool { name: string; description: string; inputSchema: Record<string, unknown>; kind: "read" | "write"; run?(args: Record<string, unknown>): Promise<ToolResult>; propose?(args: Record<string, unknown>): Promise<Proposal> }`
  - `function toAnthropicTools(tools: Tool[]): { name: string; description: string; input_schema: Record<string, unknown> }[]`
  - `function findTool(tools: Tool[], name: string): Tool | undefined`

- [ ] **Step 1: Write the failing test**

Create `lib/agent/tools/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Tool } from "./types";
import { toAnthropicTools, findTool } from "./registry";

const READ: Tool = {
  name: "demo_read",
  description: "d",
  inputSchema: { type: "object", properties: {} },
  kind: "read",
  run: async () => ({ ok: true, content: "x" }),
};

describe("toAnthropicTools", () => {
  it("maps inputSchema → input_schema and keeps name/description", () => {
    expect(toAnthropicTools([READ])).toEqual([
      { name: "demo_read", description: "d", input_schema: { type: "object", properties: {} } },
    ]);
  });
});

describe("findTool", () => {
  it("finds by name, undefined when absent", () => {
    expect(findTool([READ], "demo_read")).toBe(READ);
    expect(findTool([READ], "nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/agent/tools/registry.test.ts`
Expected: FAIL — `Cannot find module './types'` / `./registry`.

- [ ] **Step 3: Implement `lib/agent/tools/types.ts`**

```ts
/**
 * The agent tool contract. Pure — no server-only / node imports — so the loop,
 * the tools, and their tests share one vocabulary. A read tool executes inside
 * the loop (`run`); a write tool is never executed by the loop — it produces a
 * Proposal the caller applies after confirmation (`propose`).
 */
export interface ToolResult {
  ok: boolean;
  /** Text fed back to the model as the tool_result (or shown to the user). */
  content: string;
}

/** A confirm-first write: a resolved, structured action + its Ukrainian echo.
 *  `apply()` performs the write deterministically and returns a result string. */
export interface Proposal {
  kind: string;
  echoUk: string;
  apply(): Promise<string>;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the tool input (Anthropic `input_schema`). */
  inputSchema: Record<string, unknown>;
  kind: "read" | "write";
  /** Read tools only: execute now, return a result to feed back to the model. */
  run?(args: Record<string, unknown>): Promise<ToolResult>;
  /** Write tools only: resolve args into a confirm-first Proposal (no write yet). */
  propose?(args: Record<string, unknown>): Promise<Proposal>;
}
```

- [ ] **Step 4: Implement `lib/agent/tools/registry.ts`**

```ts
/**
 * Registry helpers: shape Tools for the Anthropic API and look them up by name.
 * The default tool set is assembled in loop.ts (which owns the server-only tool
 * modules); this module stays pure so it is unit-testable without a client.
 */
import type { Tool } from "./types";

export function toAnthropicTools(
  tools: Tool[],
): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run lib/agent/tools/registry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/agent/tools/types.ts lib/agent/tools/registry.ts lib/agent/tools/registry.test.ts
git commit -m "feat(agent): tool contract + registry helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Jira tools (`lib/agent/tools/jira.ts`)

The read tool (`jira_search`) wraps `searchIssues`; the four write tools resolve into Proposals. `jira_create` applies the Mr-Lab routing (`routeIssue` + `routingConfigFromEnv`) exactly like `scripts/jira-write.ts`, so the echo shows the resolved project.

**Files:**
- Create: `lib/agent/tools/jira.ts`
- Test: `lib/agent/tools/jira.test.ts`

**Interfaces:**
- Consumes: `searchIssues`, `createIssue`, `addComment`, `updateIssue`, `transitionIssue` (`lib/jira.ts`); `routeIssue`, `routingConfigFromEnv` (`lib/jiraRouting.ts`); `personByQuery` (`lib/people.ts`); `Tool`, `Proposal`, `ToolResult` (`./types`).
- Produces: `const jiraTools: Tool[]` (one read + four write), and `function jiraCreateProposal(args): Promise<Proposal>` (exported for direct testing).

- [ ] **Step 1: Write the failing test**

Create `lib/agent/tools/jira.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { jiraTools, jiraCreateProposal } from "./jira";
import { findTool } from "./registry";

const ENV = {
  JIRA_BASE_URL: "https://ex.atlassian.net",
  JIRA_EMAIL: "bot@ex.com",
  JIRA_API_TOKEN: "tok",
  JIRA_PROJECT_KEYS: "ATP",
  JIRA_STORY_POINTS_FIELD: "customfield_10016",
  JIRA_MRLAB_PROJECT: "MRLAB",
};
beforeEach(() => Object.assign(process.env, ENV));
afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, json: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(json), { status }));
}

describe("jira_search tool", () => {
  it("is a read tool and returns rows as text", async () => {
    const tool = findTool(jiraTools, "jira_search")!;
    expect(tool.kind).toBe("read");
    mockFetch(200, { issues: [{ key: "ATP-7", fields: { summary: "Fix", status: { name: "Done" } } }] });
    const res = await tool.run!({ jql: "resolved >= startOfDay()" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("ATP-7");
    expect(res.content).toContain("Fix");
  });
});

describe("jiraCreateProposal (Mr-Lab routing)", () => {
  it("routes Тарас to MRLAB with assignee in the description echo", async () => {
    const p = await jiraCreateProposal({ person: "Taras", summary: "Fix export", description: "broken CSV" });
    expect(p.kind).toBe("jira_create");
    expect(p.echoUk).toContain("MRLAB");
    expect(p.echoUk).toContain("Taras Panasyuk");
  });

  it("apply() POSTs and returns the created key + url", async () => {
    const f = mockFetch(201, { key: "MRLAB-3" });
    const p = await jiraCreateProposal({ person: "Taras", summary: "S", description: "" });
    const out = await p.apply();
    expect(out).toContain("MRLAB-3");
    const body = JSON.parse(String(f.mock.calls[0][1]?.body));
    expect(body.fields.project).toEqual({ key: "MRLAB" });
    expect("assignee" in body.fields).toBe(false); // named in description, not assigned
  });

  it("rejects an unknown person", async () => {
    await expect(jiraCreateProposal({ person: "Nobody McGhost", summary: "S", description: "" })).rejects.toThrow(
      /Unknown person/,
    );
  });
});

describe("jira write tools", () => {
  it("registers create/comment/transition/update as write tools with propose()", () => {
    for (const name of ["jira_create", "jira_comment", "jira_transition", "jira_update"]) {
      const t = findTool(jiraTools, name)!;
      expect(t.kind).toBe("write");
      expect(typeof t.propose).toBe("function");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/agent/tools/jira.test.ts`
Expected: FAIL — `Cannot find module './jira'`.

- [ ] **Step 3: Implement `lib/agent/tools/jira.ts`**

```ts
/**
 * Jira tools for the agent loop. The read tool (jira_search) executes live; the
 * write tools resolve into confirm-first Proposals — the loop never writes. The
 * create proposal applies the Mr-Lab routing rule (lib/jiraRouting.ts), so the
 * echo shows the resolved project and a misroute is caught before creation.
 *
 * Reachable only under server-only conditions (lib/jira.ts). Needs JIRA_* env.
 */
import { searchIssues, createIssue, addComment, updateIssue, transitionIssue } from "@/lib/jira";
import { routeIssue, routingConfigFromEnv } from "@/lib/jiraRouting";
import { personByQuery } from "@/lib/people";
import type { Proposal, Tool } from "./types";

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing required "${key}".`);
  return v.trim();
}
function optStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

/** Resolve {person, summary, description} → a create Proposal with Mr-Lab routing. */
export async function jiraCreateProposal(args: Record<string, unknown>): Promise<Proposal> {
  const personQuery = str(args, "person");
  const summary = str(args, "summary");
  const desc = optStr(args, "description");

  const resolved = personByQuery(personQuery);
  if ("unknown" in resolved) throw new Error(`Unknown person: ${personQuery}`);
  if ("ambiguous" in resolved) {
    throw new Error(`Ambiguous "${personQuery}": ${resolved.ambiguous.map((p) => p.name).join(", ")}`);
  }
  const person = resolved.person;
  const routing = routeIssue(person, routingConfigFromEnv());
  const description = routing.assignInDescription ? `Виконавець: ${person.name}\n\n${desc}`.trim() : desc;
  const assignee = routing.jiraAccountId ?? `(в описі) ${person.name}`;

  return {
    kind: "jira_create",
    echoUk: `📝 Створю задачу в проєкті ${routing.projectKey}, виконавець: ${assignee}\nЗаголовок: ${summary}\nОпис: ${description || "(порожній)"}\nСтворити? (так/ні)`,
    apply: async () => {
      const created = await createIssue({
        projectKey: routing.projectKey,
        summary,
        description,
        assigneeAccountId: routing.jiraAccountId,
      });
      return `✅ Створено ${created.key}: ${created.url}`;
    },
  };
}

async function jiraCommentProposal(args: Record<string, unknown>): Promise<Proposal> {
  const key = str(args, "key");
  const body = str(args, "body");
  return {
    kind: "jira_comment",
    echoUk: `📝 Додам коментар до ${key}:\n${body}\nДодати? (так/ні)`,
    apply: async () => {
      await addComment(key, body);
      return `✅ Коментар додано до ${key}`;
    },
  };
}

async function jiraTransitionProposal(args: Record<string, unknown>): Promise<Proposal> {
  const key = str(args, "key");
  const transitionId = str(args, "transitionId");
  return {
    kind: "jira_transition",
    echoUk: `📝 Переведу ${key} (transition ${transitionId}).\nПродовжити? (так/ні)`,
    apply: async () => {
      await transitionIssue(key, transitionId);
      return `✅ ${key} переведено`;
    },
  };
}

async function jiraUpdateProposal(args: Record<string, unknown>): Promise<Proposal> {
  const key = str(args, "key");
  const fields = (args.fields ?? {}) as Record<string, unknown>;
  return {
    kind: "jira_update",
    echoUk: `📝 Оновлю ${key}: ${JSON.stringify(fields)}\nПродовжити? (так/ні)`,
    apply: async () => {
      await updateIssue(key, fields);
      return `✅ ${key} оновлено`;
    },
  };
}

export const jiraTools: Tool[] = [
  {
    name: "jira_search",
    description:
      "Search Jira issues with a JQL query and return matching keys, summaries, and statuses. Use for questions like what was done/resolved, what is open, or to find an issue. JQL examples: 'resolved >= startOfDay()', 'project = ATP AND status = \"In Progress\"'.",
    inputSchema: {
      type: "object",
      properties: {
        jql: { type: "string", description: "A valid Jira JQL query." },
        max: { type: "number", description: "Max rows (default 20)." },
      },
      required: ["jql"],
    },
    kind: "read",
    run: async (args) => {
      const jql = str(args, "jql");
      const max = typeof args.max === "number" ? args.max : 20;
      const rows = await searchIssues(jql, max);
      if (!rows.length) return { ok: true, content: "No issues matched." };
      return { ok: true, content: rows.map((r) => `${r.key} [${r.status}] ${r.summary}`).join("\n") };
    },
  },
  {
    name: "jira_create",
    description:
      "Create a Jira ticket for a named person. Routing is automatic (Mr-Lab people go to the Mr Lab project). Provide the person's name, a summary, and an optional description.",
    inputSchema: {
      type: "object",
      properties: {
        person: { type: "string", description: "Who the ticket is for (name)." },
        summary: { type: "string", description: "Ticket summary." },
        description: { type: "string", description: "Ticket description (optional)." },
      },
      required: ["person", "summary"],
    },
    kind: "write",
    propose: jiraCreateProposal,
  },
  {
    name: "jira_comment",
    description: "Add a comment to a Jira issue.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Issue key, e.g. ATP-42." },
        body: { type: "string", description: "Comment text." },
      },
      required: ["key", "body"],
    },
    kind: "write",
    propose: jiraCommentProposal,
  },
  {
    name: "jira_transition",
    description: "Move a Jira issue to a new status via a transition id.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Issue key." },
        transitionId: { type: "string", description: "Jira transition id." },
      },
      required: ["key", "transitionId"],
    },
    kind: "write",
    propose: jiraTransitionProposal,
  },
  {
    name: "jira_update",
    description: "Update fields on a Jira issue.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Issue key." },
        fields: { type: "object", description: "Jira fields object to set." },
      },
      required: ["key", "fields"],
    },
    kind: "write",
    propose: jiraUpdateProposal,
  },
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/agent/tools/jira.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/tools/jira.ts lib/agent/tools/jira.test.ts
git commit -m "feat(agent): Jira tools — jira_search (read) + create/comment/transition/update (proposal-gated)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The agent loop (`lib/agent/loop.ts`)

The multi-turn tool-use cycle. Read tool_use → execute → append `tool_result` → continue. Write tool_use → build the Proposal and stop, returning it. Text-only → return the text. Injectable Anthropic client + tool list for tests.

**Files:**
- Create: `lib/agent/loop.ts`
- Test: `lib/agent/loop.test.ts`

**Interfaces:**
- Consumes: `Tool`, `Proposal` (`./tools/types`); `toAnthropicTools`, `findTool` (`./tools/registry`); `jiraTools` (`./tools/jira`); `@anthropic-ai/sdk`.
- Produces:
  - `interface AgentResult { kind: "text" | "proposal" | "error"; text: string; proposal?: Proposal }`
  - `interface RunAgentOptions { tools?: Tool[]; client?: AnthropicLike; maxIters?: number; now?: () => number }`
  - `type AnthropicLike = { messages: { create(body: unknown): Promise<{ stop_reason: string | null; content: unknown[] }> } }`
  - `async function runAgent(userText: string, opts?: RunAgentOptions): Promise<AgentResult>`

- [ ] **Step 1: Write the failing test**

Create `lib/agent/loop.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runAgent } from "./loop";
import type { Tool } from "./tools/types";

// A fake Anthropic client scripted with a queue of responses.
function fakeClient(responses: { stop_reason: string | null; content: unknown[] }[]) {
  const create = vi.fn();
  responses.forEach((r) => create.mockResolvedValueOnce(r));
  return { messages: { create } };
}

const readTool: Tool = {
  name: "demo_read",
  description: "d",
  inputSchema: { type: "object", properties: {} },
  kind: "read",
  run: async () => ({ ok: true, content: "RESULT-42" }),
};
const writeTool: Tool = {
  name: "demo_write",
  description: "d",
  inputSchema: { type: "object", properties: {} },
  kind: "write",
  propose: async () => ({ kind: "demo_write", echoUk: "ЕХО", apply: async () => "APPLIED" }),
};

describe("runAgent", () => {
  it("returns text when the model answers directly", async () => {
    const client = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "Привіт" }] }]);
    const res = await runAgent("hi", { client, tools: [readTool] });
    expect(res).toEqual({ kind: "text", text: "Привіт" });
  });

  it("executes a read tool then returns the follow-up text", async () => {
    const client = fakeClient([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "demo_read", input: {} }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Готово: RESULT-42" }] },
    ]);
    const res = await runAgent("do it", { client, tools: [readTool] });
    expect(res.kind).toBe("text");
    expect(res.text).toContain("RESULT-42");
    // second call must include a tool_result for t1
    const secondBody = client.messages.create.mock.calls[1][0] as { messages: { role: string; content: unknown }[] };
    const asString = JSON.stringify(secondBody.messages);
    expect(asString).toContain("tool_result");
    expect(asString).toContain("RESULT-42");
  });

  it("returns a proposal (does NOT apply) on a write tool_use", async () => {
    const client = fakeClient([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "w1", name: "demo_write", input: {} }] },
    ]);
    const res = await runAgent("create", { client, tools: [writeTool] });
    expect(res.kind).toBe("proposal");
    expect(res.text).toBe("ЕХО");
    expect(res.proposal?.kind).toBe("demo_write");
    // exactly one model call — the loop stops at the write
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("stops with an error text after exceeding maxIters", async () => {
    const toolUse = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "demo_read", input: {} }] };
    const client = fakeClient([toolUse, toolUse, toolUse]);
    const res = await runAgent("loop", { client, tools: [readTool], maxIters: 2 });
    expect(res.kind).toBe("error");
    expect(res.text).toContain("не встиг");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/agent/loop.test.ts`
Expected: FAIL — `Cannot find module './loop'`.

- [ ] **Step 3: Implement `lib/agent/loop.ts`**

```ts
/**
 * The agent's multi-turn tool-use loop. Drives claude-sonnet-5 with a tool set:
 * a read tool_use executes now and its result is fed back; a write tool_use is
 * turned into a confirm-first Proposal and the loop stops (the loop NEVER writes
 * to Jira directly). Text-only → answer. Guarded by an iteration cap and a
 * wall-clock budget so it fits Vercel's 60s function limit.
 *
 * SERVER-ONLY reachable (reads ANTHROPIC_API_KEY via the default Anthropic
 * client, and the tools read JIRA_*). Tests inject `client` + `tools` + `now`.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { Proposal, Tool } from "./tools/types";
import { toAnthropicTools, findTool } from "./tools/registry";
import { jiraTools } from "./tools/jira";

const MODEL = "claude-sonnet-5";
const MAX_ITERS = 8;
const BUDGET_MS = 50_000;

const SYSTEM = [
  "Ти — асистент інженерної команди Orients у Slack. Ти вмієш шукати і змінювати задачі в Jira через інструменти.",
  "Правило мови: у вільній розмові й відповідях відповідай мовою користувача; підтвердження та echo для записів — українською.",
  "Маршрутизація виконавців у Jira автоматична — просто передай імʼя людини в jira_create.",
  "Будь-яка зміна (створення/коментар/перехід/оновлення) НЕ виконується одразу: інструмент повертає пропозицію, яку користувач підтверджує окремо.",
  "Для питань про зроблене/відкрите використовуй jira_search з відповідним JQL.",
].join("\n");

export type AnthropicLike = {
  messages: { create(body: unknown): Promise<{ stop_reason: string | null; content: unknown[] }> };
};
export interface AgentResult {
  kind: "text" | "proposal" | "error";
  text: string;
  proposal?: Proposal;
}
export interface RunAgentOptions {
  tools?: Tool[];
  client?: AnthropicLike;
  maxIters?: number;
  now?: () => number;
}

interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
interface TextBlock { type: "text"; text: string }

function textOf(content: unknown[]): string {
  return content
    .filter((b): b is TextBlock => (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
function toolUsesOf(content: unknown[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => (b as { type?: string }).type === "tool_use");
}

export async function runAgent(userText: string, opts: RunAgentOptions = {}): Promise<AgentResult> {
  const tools = opts.tools ?? jiraTools;
  const client = (opts.client ?? new Anthropic()) as AnthropicLike;
  const maxIters = opts.maxIters ?? MAX_ITERS;
  const now = opts.now ?? (() => Date.now());
  const started = now();

  const anthropicTools = toAnthropicTools(tools);
  const messages: { role: "user" | "assistant"; content: unknown }[] = [
    { role: "user", content: userText },
  ];

  for (let i = 0; i < maxIters; i++) {
    if (now() - started > BUDGET_MS) {
      return { kind: "error", text: "Вибач, не встиг обробити запит — спробуй ще раз." };
    }
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      tools: anthropicTools,
      messages,
    });
    const uses = toolUsesOf(resp.content);
    if (!uses.length) {
      return { kind: "text", text: textOf(resp.content) };
    }
    // A write tool_use → confirm-first Proposal; stop the loop immediately.
    const write = uses.find((u) => findTool(tools, u.name)?.kind === "write");
    if (write) {
      const tool = findTool(tools, write.name)!;
      const proposal = await tool.propose!(write.input);
      return { kind: "proposal", text: proposal.echoUk, proposal };
    }
    // Otherwise execute all read tool_uses and feed results back.
    messages.push({ role: "assistant", content: resp.content });
    const results: unknown[] = [];
    for (const u of uses) {
      const tool = findTool(tools, u.name);
      let content: string;
      try {
        const r = tool?.run ? await tool.run(u.input) : { ok: false, content: `Unknown tool ${u.name}` };
        content = r.content;
      } catch (err) {
        content = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content });
    }
    messages.push({ role: "user", content: results });
  }
  return { kind: "error", text: "Вибач, не встиг обробити запит — спробуй ще раз." };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/agent/loop.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Confirm the full suite + lint still pass**

Run: `npm test && npm run lint`
Expected: no failures; no new lint errors in the new files.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/loop.ts lib/agent/loop.test.ts
git commit -m "feat(agent): multi-turn tool-use loop (read-exec, write→proposal, guarded)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: CLI twin (`scripts/agent.ts`) + docs

The mandatory second interface and primary manual harness: run the same loop from the terminal. Read tools execute live; a write prints the resolved Ukrainian echo and applies only with `--yes`.

**Files:**
- Create: `scripts/agent.ts`
- Modify: `package.json` (add the `agent` script)
- Modify: `CLAUDE.md` (document the command)

**Interfaces:**
- Consumes: `runAgent`, `AgentResult` (`../lib/agent/loop`).
- Produces: the `npm run agent` command. No new exported types.

- [ ] **Step 1: Add the npm script**

In `package.json` `scripts`, after the `jira-write` line, add:

```json
    "agent": "node --conditions=react-server --import tsx scripts/agent.ts",
```

- [ ] **Step 2: Implement `scripts/agent.ts`**

```ts
/**
 * CLI twin of the Slack conversational agent (Phase B). Runs the SAME
 * lib/agent/loop.ts from the terminal — no Slack.
 *
 * Usage:
 *   npm run agent -- "what was done in jira today"
 *   npm run agent -- "create a ticket for Тарас: fix the export bug" --yes
 *
 * Read tools execute live. A write returns a confirm-first proposal: without
 * --yes the CLI prints the Ukrainian echo and stops; with --yes it applies the
 * proposal and prints the result. Needs ANTHROPIC_API_KEY + JIRA_* env; runs
 * under --conditions=react-server (see package.json) so lib/jira's server-only
 * import resolves to its empty module.
 */
import { runAgent } from "../lib/agent/loop";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const yes = argv.includes("--yes");
  const prompt = argv.filter((a) => a !== "--yes").join(" ").trim();
  if (!prompt) {
    console.error('Usage: npm run agent -- "<your message>" [--yes]');
    process.exit(1);
  }

  const res = await runAgent(prompt);
  if (res.kind === "text" || res.kind === "error") {
    console.log(res.text);
    if (res.kind === "error") process.exit(1);
    return;
  }
  // proposal
  console.log(res.text);
  if (!yes) {
    console.log("\n(Re-run with --yes to apply.)");
    return;
  }
  const applied = await res.proposal!.apply();
  console.log(applied);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 3: Verify the loop end-to-end (needs real ANTHROPIC_API_KEY + JIRA_*)**

This step hits the live Anthropic + Jira APIs — run it only when those env vars are set (e.g. from `.env`). It is a manual smoke check, not an automated test.

Run (read path):
```bash
npm run agent -- "what was resolved in jira in the last 7 days"
```
Expected: the agent calls `jira_search` and prints a list of `KEY [status] summary` rows (or "No issues matched.").

Run (write path, dry):
```bash
npm run agent -- "create a ticket for Тарас: fix the export bug"
```
Expected: prints a Ukrainian echo naming project `MRLAB` and `Taras Panasyuk`, then "(Re-run with --yes to apply.)" — and creates nothing.

If `ANTHROPIC_API_KEY` is absent, expect a clear error from the Anthropic client; that is the same fail-loud behavior Phase C relies on.

- [ ] **Step 4: Document the command in `CLAUDE.md`**

Add under `## Commands` (after the `npm run jira-write` bullet):

```markdown
- `npm run agent -- "<message>" [--yes]` — the Slack conversational agent's CLI twin (Phase B). Runs the same `lib/agent/loop.ts` multi-turn Claude tool-use loop from the terminal: read tools (`jira_search`) execute live to answer questions (e.g. "what was done in jira today"); a write (`jira_create`/`jira_comment`/`jira_transition`/`jira_update`) returns a **confirm-first** Ukrainian proposal that the CLI applies only with `--yes` (`jira_create` shows the resolved Mr-Lab routing). Model `claude-sonnet-5`, ≤8 tool iterations / ~50s budget. Needs `ANTHROPIC_API_KEY` + `JIRA_*` (incl. `JIRA_MRLAB_PROJECT` for Mr-Lab creates). Phase C wires this same loop into Slack (@mention/DM/thread). (See `docs/superpowers/specs/2026-07-01-slack-conversational-agent-design.md`.)
```

- [ ] **Step 5: Commit**

```bash
git add scripts/agent.ts package.json CLAUDE.md
git commit -m "feat(agent): npm run agent CLI twin (read live, write confirm-first)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Phase B scope):**
- Agent loop (read-exec / write→proposal / caps) → Task 3. ✓
- Tool registry + contract → Task 1. ✓
- Read tool + proposal-gated write tools (Jira) → Task 2. ✓
- CLI twin, confirm-first / `--yes` → Task 4. ✓
- System prompt with routing + confirm-first + language rule → Task 3 (`SYSTEM`). ✓
- Loop tested with a mocked Anthropic client (read turn, write→proposal turn, cap) → Task 3 test. ✓ Jira write client tested with mocked `fetch` → Task 2 test (Phase A already tested `lib/jira.ts` directly). ✓
- Deliberately deferred (documented in Scope): other console read tools; DB `proposals` generalization + Slack idempotency; Slack ingress; web Assistant tab. These are Phase C or a later Phase-B increment per the design's phase split — not gaps.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the one manual/live step (Task 4 Step 3) is explicitly labelled as a smoke check, not an automated test, because it needs real API keys. ✓

**Type consistency:** `Tool`/`ToolResult`/`Proposal` defined in Task 1 are consumed unchanged in Tasks 2–3. `jiraTools`/`jiraCreateProposal` (Task 2) are consumed in Task 3 + its default. `runAgent`/`AgentResult`/`RunAgentOptions`/`AnthropicLike` (Task 3) are consumed in Task 4. `searchIssues`/`createIssue`/`addComment`/`updateIssue`/`transitionIssue` (Phase A) match Task 2's imports. ✓

## Open items (carried forward)

- Set `JIRA_MRLAB_PROJECT` before a real `jira_create --yes` for Любомир/Андріан/Тарас (Mr Lab key still unknown).
- Phase C will: add Slack ingress (`app_mention`/`message.im`/agent-thread), the allowlist gate, bot-user-id discovery, the DB `proposals` generalization (add a nullable-date / `kind` path so a `jira_write` proposal persists with `source_reply_ts` idempotency), and the read-only web Assistant tab. Operator action: subscribe the events + add scopes (`app_mentions:read`, `im:history`, `im:read`, `im:write`).
