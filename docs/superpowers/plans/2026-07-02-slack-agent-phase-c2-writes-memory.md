# Slack Agent Phase C.2 — confirm-first DM writes + memory + safe execution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a DM to the bot create/route a Jira ticket confirm-first, remember prior turns, and run the agent loop off the request path so Slack's 3s ack is never blocked — building on the shipped read-only C.1 ingress.

**Architecture:** The events webhook becomes fast: it claims the event, gates by allowlist, handles a pending DM proposal inline (fast Jira write), or posts a `🤔 думаю…` placeholder and fire-and-forgets to a new `/api/agent/run` (the 60s function) which runs the loop and edits the placeholder with the answer or a confirm-first proposal echo. Writes persist a resolved action (`agent_proposals`) applied deterministically on `так`; DM conversation history persists in `agent_threads` as lightweight text turns.

**Tech Stack:** Next 16 App Router (nodejs runtime), TypeScript strict, Drizzle + Neon Postgres, `@anthropic-ai/sdk`, Vitest (with the `server-only`→`empty.js` alias). Reuses Phase A `lib/jira.ts`, Phase B `lib/agent/loop.ts` + tools, and C.1 `lib/agent/{access,slackAgent}.ts`.

## Global Constraints

- **Shared checkout — peer sessions commit to `main` concurrently.** Stage ONLY your own files with explicit `git add <path>`; NEVER `git add -A`/`git add .`/`git commit -a`. Leave `next-env.d.ts` and unrelated files untouched. Commit on `main`. Per-task review base = `<taskcommit>^`.
- **Confirm-first guarantee:** the loop NEVER writes to Jira. Only `applyProposal` (invoked on an explicit `так`/`--yes`) writes.
- **Writes are DM-only.** @mention stays read-only (`askAgent`), but its turn still runs through the self-invoke runner so it respects the 3s ack.
- **Fail loud:** a missing `ANTHROPIC_API_KEY` on the run path must produce a visible Ukrainian error in Slack + a `console.error`, never a silent no-op.
- **The webhook always returns 200 to Slack** (a 5xx makes Slack retry and, sustained, disables the subscription). Failures surface in Slack + logs.
- **server-only / react-server discipline:** `lib/agent/loop.ts`, `lib/agent/tools/jira.ts`, `lib/jira.ts` are server-only-reachable; do not import them from a `"use client"` file. Tests reach them via the vitest `server-only`→`empty.js` alias; the `@`→repo-root vitest alias is already configured.
- TypeScript `strict`; no `any` in exported signatures. All UA copy for user-facing writes/acks; English internal.
- Commit message trailer on every commit:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## File Structure

- **New:** `lib/proposalExecutor.ts` (deterministic apply), `lib/agentProposals.ts` (DB accessors + atomic claim), `lib/agentThread.ts` (DB accessors) + `lib/agentThreadCap.ts` (pure cap helper), `lib/agentDm.ts` (pure confirm/cancel classifier), `lib/selfOrigin.ts`, `lib/agent/slackTurn.ts` (write-capable turn), `app/api/agent/run/route.ts` (self-invoke runner).
- **Modified:** `lib/agent/tools/types.ts` + `lib/agent/tools/jira.ts` (`Proposal.params` + delegate `apply` to `applyProposal`), `lib/agent/loop.ts` (`history` option), `scripts/agent.ts` (apply via `applyProposal` — unchanged behavior), `lib/schema.ts` (2 tables), `app/api/slack/events/route.ts` (fast ack + placeholder + self-invoke; DM pending-proposal state machine), `CLAUDE.md`.
- **DB migration:** `npm run db:generate` after the schema edit produces a new `drizzle/*.sql`; it is applied to Neon at deploy (operator step — noted, not run by task subagents).

---

### Task 1: `Proposal.params` + `runAgent` history option (Phase B extensions)

Adds the two backward-compatible extensions the rest of C.2 needs: a serializable `params` on every `Proposal`, and a `history` seed on the loop.

**Files:**
- Modify: `lib/agent/tools/types.ts`
- Modify: `lib/agent/loop.ts`
- Test: `lib/agent/loop.test.ts` (add one case)

**Interfaces:**
- Consumes: existing `Proposal`, `runAgent`, `RunAgentOptions`, `AgentResult`.
- Produces: `Proposal` now has `params: Record<string, unknown>`; `RunAgentOptions` now has `history?: Array<{ role: "user" | "assistant"; text: string }>`.

- [ ] **Step 1: Add `params` to the `Proposal` interface**

In `lib/agent/tools/types.ts`, extend `Proposal`:

```ts
/** A confirm-first write: a resolved, structured action + its Ukrainian echo.
 *  `params` is the resolved action (serializable — persisted across a Slack
 *  round-trip); `apply()` performs the write deterministically. */
export interface Proposal {
  kind: string;
  /** Resolved, JSON-serializable action params (the deterministic executor's input). */
  params: Record<string, unknown>;
  echoUk: string;
  apply(): Promise<string>;
}
```

- [ ] **Step 2: Write the failing test for the history seed**

In `lib/agent/loop.test.ts`, add inside `describe("runAgent", ...)`:

```ts
it("seeds prior history before the new user message", async () => {
  const client = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }]);
  await runAgent("new question", {
    client,
    tools: [readTool],
    history: [
      { role: "user", text: "earlier q" },
      { role: "assistant", text: "earlier a" },
    ],
  });
  const body = client.messages.create.mock.calls[0][0] as { messages: { role: string; content: unknown }[] };
  expect(body.messages).toEqual([
    { role: "user", content: "earlier q" },
    { role: "assistant", content: "earlier a" },
    { role: "user", content: "new question" },
  ]);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run lib/agent/loop.test.ts -t "seeds prior history"`
Expected: FAIL — `history` is ignored, `messages` has only the new user turn.

- [ ] **Step 4: Add the `history` option and seed it**

In `lib/agent/loop.ts`, add to `RunAgentOptions`:

```ts
export interface RunAgentOptions {
  tools?: Tool[];
  client?: AnthropicLike;
  maxIters?: number;
  now?: () => number;
  /** Prior conversation turns (lightweight text) seeded before the new user message. */
  history?: Array<{ role: "user" | "assistant"; text: string }>;
}
```

Change the initial `messages` construction (currently `[{ role: "user", content: userText }]`) to:

```ts
  const messages: { role: "user" | "assistant"; content: unknown }[] = [
    ...(opts.history ?? []).map((h) => ({ role: h.role, content: h.text as unknown })),
    { role: "user", content: userText },
  ];
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run lib/agent/loop.test.ts`
Expected: PASS (existing 5 + the new history test).

- [ ] **Step 6: Fix the `Proposal` construction sites the new field breaks**

`lib/agent/tools/jira.ts` builds `Proposal` objects that now lack `params` (TS error). This is repaired fully in Task 2; for now, run `npx tsc --noEmit` and confirm the ONLY new errors are missing-`params` in `lib/agent/tools/jira.ts`. Do not fix them here — Task 2 owns that file. If any OTHER file errors, stop and report.

Run: `npx tsc --noEmit 2>&1 | grep -c "params"` (expect a small count, all in jira.ts).

- [ ] **Step 7: Commit**

```bash
git add lib/agent/tools/types.ts lib/agent/loop.ts lib/agent/loop.test.ts
git commit -m "feat(agent): Proposal.params + runAgent history seed (Phase C.2 extensions)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(The tsc `params` errors in jira.ts are expected and resolved in Task 2 — that's why this commit and Task 2's commit are adjacent.)

---

### Task 2: deterministic executor `lib/proposalExecutor.ts` + wire `jira.ts` proposals

One apply path shared by the CLI (`--yes`) and the Slack confirm. The Jira proposal builders set `params` and delegate `apply()` to it.

**Files:**
- Create: `lib/proposalExecutor.ts`
- Modify: `lib/agent/tools/jira.ts`
- Test: `lib/proposalExecutor.test.ts`; `lib/agent/tools/jira.test.ts` (assert `params` shape)

**Interfaces:**
- Consumes: `createIssue`, `addComment`, `transitionIssue`, `updateIssue` (`@/lib/jira`); `Proposal` (`@/lib/agent/tools/types`).
- Produces: `type ProposalKind = "jira_create" | "jira_comment" | "jira_transition" | "jira_update"`; `async function applyProposal(kind: ProposalKind, params: Record<string, unknown>): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Create `lib/proposalExecutor.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { applyProposal } from "./proposalExecutor";

const ENV = {
  JIRA_BASE_URL: "https://ex.atlassian.net",
  JIRA_EMAIL: "bot@ex.com",
  JIRA_API_TOKEN: "tok",
  JIRA_PROJECT_KEYS: "ATP",
};
beforeEach(() => Object.assign(process.env, ENV));
afterEach(() => vi.restoreAllMocks());
function mockFetch(status: number, json: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(json), { status }));
}

describe("applyProposal", () => {
  it("jira_create POSTs project + no assignee when accountId null, returns UA line with key+url", async () => {
    const f = mockFetch(201, { key: "MRLAB-3" });
    const out = await applyProposal("jira_create", {
      projectKey: "MRLAB",
      summary: "S",
      description: "Виконавець: Taras Panasyuk",
      assigneeAccountId: null,
    });
    expect(out).toContain("MRLAB-3");
    const body = JSON.parse(String(f.mock.calls[0][1]?.body));
    expect(body.fields.project).toEqual({ key: "MRLAB" });
    expect("assignee" in body.fields).toBe(false);
  });

  it("jira_comment calls the comment endpoint", async () => {
    const f = mockFetch(201, {});
    const out = await applyProposal("jira_comment", { key: "ATP-7", body: "hi" });
    expect(out).toContain("ATP-7");
    expect(String(f.mock.calls[0][0])).toContain("/rest/api/3/issue/ATP-7/comment");
  });

  it("rejects an unknown kind", async () => {
    await expect(applyProposal("nope" as never, {})).rejects.toThrow(/Unknown proposal kind/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/proposalExecutor.test.ts`
Expected: FAIL — `Cannot find module './proposalExecutor'`.

- [ ] **Step 3: Implement `lib/proposalExecutor.ts`**

```ts
/**
 * Deterministic confirm-first executor: given a resolved proposal (kind + params)
 * perform the Jira write and return a Ukrainian result line. This is the ONE apply
 * path — shared by the CLI (`npm run agent --yes`) and the Slack confirm (`так`),
 * so a proposal that survives a DB round-trip (lib/agentProposals) applies exactly
 * like the in-memory CLI path. No LLM here; the model already resolved the params.
 *
 * SERVER-ONLY reachable (lib/jira reads JIRA_* env).
 */
import { createIssue, addComment, transitionIssue, updateIssue } from "@/lib/jira";

export type ProposalKind = "jira_create" | "jira_comment" | "jira_transition" | "jira_update";

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing required "${key}".`);
  return v;
}

export async function applyProposal(kind: ProposalKind, params: Record<string, unknown>): Promise<string> {
  switch (kind) {
    case "jira_create": {
      const accountId = params.assigneeAccountId;
      const created = await createIssue({
        projectKey: str(params, "projectKey"),
        summary: str(params, "summary"),
        description: typeof params.description === "string" ? params.description : "",
        assigneeAccountId: typeof accountId === "string" ? accountId : null,
      });
      return `✅ Створено ${created.key}: ${created.url}`;
    }
    case "jira_comment":
      await addComment(str(params, "key"), str(params, "body"));
      return `✅ Коментар додано до ${str(params, "key")}`;
    case "jira_transition":
      await transitionIssue(str(params, "key"), str(params, "transitionId"));
      return `✅ ${str(params, "key")} переведено`;
    case "jira_update": {
      const fields = (params.fields ?? {}) as Record<string, unknown>;
      await updateIssue(str(params, "key"), fields);
      return `✅ ${str(params, "key")} оновлено`;
    }
    default:
      throw new Error(`Unknown proposal kind: ${kind}`);
  }
}
```

- [ ] **Step 4: Point the `jira.ts` proposal builders at the executor**

In `lib/agent/tools/jira.ts`, each proposal builder now sets `params` and delegates `apply`. Replace `jiraCreateProposal`'s returned object with:

```ts
  const params = { projectKey: routing.projectKey, summary, description, assigneeAccountId: routing.jiraAccountId };
  return {
    kind: "jira_create",
    params,
    echoUk: `📝 Створю задачу в проєкті ${routing.projectKey}, виконавець: ${assignee}\nЗаголовок: ${summary}\nОпис: ${description || "(порожній)"}\nСтворити? (так/ні)`,
    apply: () => applyProposal("jira_create", params),
  };
```

Do the same for the other three builders — each sets `params` to the exact object it passed to its Jira call before, and `apply: () => applyProposal("<kind>", params)`. Add the import: `import { applyProposal } from "@/lib/proposalExecutor";`. Keep every `echoUk` string byte-for-byte unchanged. Remove the now-unused direct `createIssue`/`addComment`/`transitionIssue`/`updateIssue` imports from `jira.ts` if nothing else uses them (the read tool uses `searchIssues` only).

- [ ] **Step 5: Add a `params`-shape assertion to the existing jira test**

In `lib/agent/tools/jira.test.ts`, in the Mr-Lab create test, after the existing `echoUk` assertions add:

```ts
    expect(p.params).toEqual({
      projectKey: "MRLAB",
      summary: "Fix export",
      description: "Виконавець: Taras Panasyuk\n\nbroken CSV",
      assigneeAccountId: null,
    });
```

(Confirm the exact `description` string matches what `jiraCreateProposal` composes for the Mr-Lab path; adjust the literal to match the real builder output if it differs.)

- [ ] **Step 6: Run tests + tsc**

Run: `npx vitest run lib/proposalExecutor.test.ts lib/agent/tools/jira.test.ts` → all pass.
Run: `npx tsc --noEmit` → **zero** errors (the Task 1 `params` errors are now resolved).

- [ ] **Step 7: Commit**

```bash
git add lib/proposalExecutor.ts lib/proposalExecutor.test.ts lib/agent/tools/jira.ts lib/agent/tools/jira.test.ts
git commit -m "feat(agent): deterministic applyProposal executor, shared by CLI + Slack confirm

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `agent_proposals` table + accessors (`lib/agentProposals.ts`)

Durable PENDING proposal per DM, with an atomic `PENDING→APPLIED` claim for write-idempotency.

**Files:**
- Modify: `lib/schema.ts`
- Create: `lib/agentProposals.ts`
- Test: `lib/agentProposals.test.ts` (accessor logic with a mocked `db`)

**Interfaces:**
- Consumes: `db`, `schema` (`@/lib/db`); `ProposalKind` (`@/lib/proposalExecutor`).
- Produces: `interface AgentProposal { id; channelId; kind: ProposalKind; params: Record<string,unknown>; summaryUk; proposedBy; state; createdAt; resolvedAt }`; `readPendingProposal(channelId): Promise<AgentProposal|null>`; `insertPending(p): Promise<void>`; `claimApply(id): Promise<boolean>` (true iff this call flipped PENDING→APPLIED); `setState(id, state): Promise<void>`.

- [ ] **Step 1: Add the table to `lib/schema.ts`**

Append (the imports `jsonb, text, uuid, uniqueIndex, index` are already present):

```ts
/** Confirm-first Jira-write proposals from a DM agent turn (Phase C.2). At most
 *  one PENDING per DM channel; applied deterministically via lib/proposalExecutor. */
export const agentProposals = pgTable(
  "agent_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: text("channel_id").notNull(),
    kind: text("kind").notNull(),
    params: jsonb("params").notNull(),
    summaryUk: text("summary_uk").notNull(),
    proposedBy: text("proposed_by").notNull(),
    state: text("state").notNull(), // PENDING|APPLIED|CANCELLED|SUPERSEDED
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (t) => [
    uniqueIndex("agent_proposals_one_pending").on(t.channelId).where(sql`state = 'PENDING'`),
    index("agent_proposals_channel").on(t.channelId),
  ],
);
```

Add `sql` to the drizzle import if not present: `import { sql } from "drizzle-orm";` (check the top of `lib/schema.ts`; add only if missing).

- [ ] **Step 2: Write the failing test (accessor logic, mocked db)**

Create `lib/agentProposals.test.ts`. Mock `@/lib/db` with `vi.hoisted` (the repo pattern) exposing a chainable `db` whose `.update().set().where().returning()` returns a controllable row array, and `.insert().values()` / `.select().from().where()` spies. Test:
- `claimApply(id)` returns `true` when the mocked `returning()` yields one row, `false` when it yields `[]` (already claimed).
- `readPendingProposal(channelId)` maps a selected row to `AgentProposal` and returns `null` on no rows.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const rows = vi.hoisted(() => ({ update: [] as unknown[], select: [] as unknown[] }));
vi.mock("@/lib/db", () => {
  const chain = (kind: "update" | "select") => ({
    set: () => chain(kind),
    values: () => Promise.resolve(),
    from: () => chain(kind),
    where: () => (kind === "select" ? Promise.resolve(rows.select) : chain(kind)),
    returning: () => Promise.resolve(rows.update),
  });
  return { db: { update: () => chain("update"), insert: () => chain("update"), select: () => chain("select") }, schema: { agentProposals: {} } };
});
import { claimApply, readPendingProposal } from "./agentProposals";

beforeEach(() => { rows.update = []; rows.select = []; });

describe("claimApply", () => {
  it("true when a row flips, false when none", async () => {
    rows.update = [{ id: "p1" }];
    expect(await claimApply("p1")).toBe(true);
    rows.update = [];
    expect(await claimApply("p1")).toBe(false);
  });
});

describe("readPendingProposal", () => {
  it("null when no PENDING row", async () => {
    rows.select = [];
    expect(await readPendingProposal("C1")).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run lib/agentProposals.test.ts`
Expected: FAIL — `Cannot find module './agentProposals'`.

- [ ] **Step 4: Implement `lib/agentProposals.ts`**

```ts
/**
 * Durable confirm-first store for DM agent write proposals (Phase C.2). At most one
 * PENDING per channel (partial unique index). `claimApply` is the atomic guard: a
 * conditional UPDATE from PENDING→APPLIED that returns the row only for the caller
 * that won the race — so a redelivered `так` applies the write at most once.
 *
 * NOT server-only (CLI-safe like lib/proposals.ts); only read/write hit the DB.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "./db";
import type { ProposalKind } from "./proposalExecutor";

export interface AgentProposal {
  id: string;
  channelId: string;
  kind: ProposalKind;
  params: Record<string, unknown>;
  summaryUk: string;
  proposedBy: string;
  state: "PENDING" | "APPLIED" | "CANCELLED" | "SUPERSEDED";
  createdAt: string;
  resolvedAt: string | null;
}

export interface NewAgentProposal {
  channelId: string;
  kind: ProposalKind;
  params: Record<string, unknown>;
  summaryUk: string;
  proposedBy: string;
}

export async function readPendingProposal(channelId: string): Promise<AgentProposal | null> {
  const rows = await db
    .select()
    .from(schema.agentProposals)
    .where(and(eq(schema.agentProposals.channelId, channelId), eq(schema.agentProposals.state, "PENDING")));
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    channelId: r.channelId,
    kind: r.kind as ProposalKind,
    params: r.params as Record<string, unknown>,
    summaryUk: r.summaryUk,
    proposedBy: r.proposedBy,
    state: r.state as AgentProposal["state"],
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
  };
}

export async function insertPending(p: NewAgentProposal): Promise<void> {
  await db.insert(schema.agentProposals).values({ ...p, state: "PENDING", createdAt: new Date().toISOString() });
}

/** Atomic PENDING→APPLIED. Returns true iff THIS call flipped it (redelivery-safe). */
export async function claimApply(id: string): Promise<boolean> {
  const flipped = await db
    .update(schema.agentProposals)
    .set({ state: "APPLIED", resolvedAt: new Date().toISOString() })
    .where(and(eq(schema.agentProposals.id, id), eq(schema.agentProposals.state, "PENDING")))
    .returning({ id: schema.agentProposals.id });
  return flipped.length > 0;
}

export async function setState(id: string, state: "CANCELLED" | "SUPERSEDED"): Promise<void> {
  await db
    .update(schema.agentProposals)
    .set({ state, resolvedAt: new Date().toISOString() })
    .where(eq(schema.agentProposals.id, id));
}
```

- [ ] **Step 5: Run tests + generate the migration**

Run: `npx vitest run lib/agentProposals.test.ts` → pass.
Run: `npm run db:generate` → creates a new `drizzle/*.sql` including `agent_proposals`. (Applied to Neon at deploy — operator step; do not run `db:migrate` against production here.)

- [ ] **Step 6: Commit**

```bash
git add lib/schema.ts lib/agentProposals.ts lib/agentProposals.test.ts drizzle/
git commit -m "feat(agent): agent_proposals table + accessors (atomic PENDING->APPLIED claim)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `agent_threads` memory (`lib/agentThread.ts` + pure cap `lib/agentThreadCap.ts`)

Per-DM lightweight text transcript for multi-turn context.

**Files:**
- Modify: `lib/schema.ts`
- Create: `lib/agentThreadCap.ts`, `lib/agentThread.ts`
- Test: `lib/agentThreadCap.test.ts`

**Interfaces:**
- Produces: `type Turn = { role: "user" | "assistant"; text: string }`; `capTranscript(turns: Turn[], nowMs: number, updatedAtMs: number): Turn[]` (pure — 24h window + last-10-turns); `loadTranscript(channelId): Promise<Turn[]>`; `appendTurn(channelId, userText, assistantText): Promise<void>`.

- [ ] **Step 1: Add the table to `lib/schema.ts`**

```ts
/** Per-DM agent conversation memory (Phase C.2). transcript = lightweight text
 *  turns only (no tool/thinking blocks). Capped on read+write to last 10 turns. */
export const agentThreads = pgTable("agent_threads", {
  channelId: text("channel_id").primaryKey(),
  updatedAt: text("updated_at").notNull(),
  transcript: jsonb("transcript").notNull(),
});
```

- [ ] **Step 2: Write the failing test for the pure cap helper**

Create `lib/agentThreadCap.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { capTranscript, type Turn } from "./agentThreadCap";

const turns = (n: number): Turn[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `t${i}` }) as Turn);

describe("capTranscript", () => {
  it("keeps only the last 10 turns", () => {
    const out = capTranscript(turns(14), 1000, 900);
    expect(out).toHaveLength(10);
    expect(out[0].text).toBe("t4");
  });
  it("drops everything when the thread is older than 24h", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(capTranscript(turns(4), day + 2000, 1000)).toEqual([]);
  });
  it("keeps a fresh short thread unchanged", () => {
    expect(capTranscript(turns(4), 5000, 4000)).toHaveLength(4);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run lib/agentThreadCap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the pure cap helper**

Create `lib/agentThreadCap.ts`:

```ts
/** Pure transcript window policy for DM agent memory (Phase C.2). */
export type Turn = { role: "user" | "assistant"; text: string };

const MAX_TURNS = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Keep the last MAX_TURNS turns, unless the thread's last activity is older than
 *  WINDOW_MS — then treat it as a fresh conversation (drop all prior turns). */
export function capTranscript(turns: Turn[], nowMs: number, updatedAtMs: number): Turn[] {
  if (nowMs - updatedAtMs > WINDOW_MS) return [];
  return turns.slice(-MAX_TURNS);
}
```

- [ ] **Step 5: Implement the DB accessors**

Create `lib/agentThread.ts`:

```ts
/**
 * Per-DM agent conversation memory (Phase C.2). Stores lightweight text turns only
 * (no raw tool_use/tool_result/thinking blocks — those go stale and drag in
 * same-model replay rules; tools re-run fresh each turn). Applies the pure
 * capTranscript window on both read and write. NOT server-only.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { capTranscript, type Turn } from "./agentThreadCap";

export type { Turn } from "./agentThreadCap";

export async function loadTranscript(channelId: string): Promise<Turn[]> {
  const rows = await db.select().from(schema.agentThreads).where(eq(schema.agentThreads.channelId, channelId));
  if (rows.length === 0) return [];
  const r = rows[0];
  return capTranscript(r.transcript as Turn[], Date.now(), Date.parse(r.updatedAt));
}

export async function appendTurn(channelId: string, userText: string, assistantText: string): Promise<void> {
  const prior = await loadTranscript(channelId);
  const next = capTranscript(
    [...prior, { role: "user", text: userText }, { role: "assistant", text: assistantText }],
    Date.now(),
    Date.now(),
  );
  const nowIso = new Date().toISOString();
  await db
    .insert(schema.agentThreads)
    .values({ channelId, updatedAt: nowIso, transcript: next })
    .onConflictDoUpdate({ target: schema.agentThreads.channelId, set: { updatedAt: nowIso, transcript: next } });
}
```

(`Date.now()` is fine in server code — the `no-Date.now` rule is a workflow-script constraint, not an app-code one.)

- [ ] **Step 6: Run tests + generate migration**

Run: `npx vitest run lib/agentThreadCap.test.ts` → pass.
Run: `npm run db:generate` → migration includes `agent_threads`.

- [ ] **Step 7: Commit**

```bash
git add lib/schema.ts lib/agentThreadCap.ts lib/agentThreadCap.test.ts lib/agentThread.ts drizzle/
git commit -m "feat(agent): agent_threads DM memory (lightweight transcript + pure 24h/10-turn cap)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: DM confirm/cancel classifier `lib/agentDm.ts` (pure)

Deterministic interpretation of a reply while a proposal is PENDING.

**Files:**
- Create: `lib/agentDm.ts`
- Test: `lib/agentDm.test.ts`

**Interfaces:**
- Produces: `type DmReply = "confirm" | "cancel" | "other"`; `classifyDmReply(text: string): DmReply`.

- [ ] **Step 1: Write the failing test**

Create `lib/agentDm.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyDmReply } from "./agentDm";

describe("classifyDmReply", () => {
  it.each(["так", "Так", "ок", "ok", "+", "👍", " так "])("confirm: %s", (t) =>
    expect(classifyDmReply(t)).toBe("confirm"));
  it.each(["ні", "Ні", "скасуй", "ні, скасуй", "👎"])("cancel: %s", (t) =>
    expect(classifyDmReply(t)).toBe("cancel"));
  it.each(["створи задачу для Тараса", "а що по jira?", ""])("other: %s", (t) =>
    expect(classifyDmReply(t)).toBe("other"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/agentDm.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `lib/agentDm.ts`**

```ts
/** Deterministic reply classification for a linear DM with a PENDING proposal
 *  (Phase C.2). No LLM. "other" supersedes the pending proposal and starts a new turn. */
export type DmReply = "confirm" | "cancel" | "other";

const CONFIRM = new Set(["так", "ок", "ok", "+", "👍", "да", "yes", "y"]);
const CANCEL = new Set(["ні", "ni", "no", "n", "скасуй", "скасувати", "👎"]);

export function classifyDmReply(text: string): DmReply {
  const t = text.trim().toLowerCase();
  if (CONFIRM.has(t)) return "confirm";
  if (CANCEL.has(t)) return "cancel";
  if (/^ні\b/.test(t)) return "cancel"; // "ні, скасуй"
  return "other";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/agentDm.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agentDm.ts lib/agentDm.test.ts
git commit -m "feat(agent): deterministic DM confirm/cancel classifier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: write-capable turn `lib/agent/slackTurn.ts` + self-origin `lib/selfOrigin.ts`

`runSlackTurn` runs the loop with the FULL tool set + seeded history and returns the structured `AgentResult`. `selfOrigin` derives the base URL for the fire-and-forget call.

**Files:**
- Create: `lib/agent/slackTurn.ts`, `lib/selfOrigin.ts`
- Test: `lib/agent/slackTurn.test.ts`, `lib/selfOrigin.test.ts`

**Interfaces:**
- Consumes: `runAgent`, `AgentResult` (`./loop`); `jiraTools` (`./tools/jira`); `Turn` (`@/lib/agentThread`).
- Produces: `async function runSlackTurn(text: string, history: Turn[]): Promise<AgentResult>`; `function selfOrigin(req: Request): string`.

- [ ] **Step 1: Write the failing tests**

Create `lib/agent/slackTurn.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runAgent = vi.hoisted(() => vi.fn());
vi.mock("./loop", () => ({ runAgent }));
import { runSlackTurn } from "./slackTurn";

beforeEach(() => { process.env.ANTHROPIC_API_KEY = "k"; runAgent.mockReset(); });
afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

describe("runSlackTurn", () => {
  it("passes full tools + history and returns the AgentResult", async () => {
    runAgent.mockResolvedValue({ kind: "text", text: "answer" });
    const res = await runSlackTurn("q", [{ role: "user", text: "prev" }]);
    expect(res).toEqual({ kind: "text", text: "answer" });
    const opts = runAgent.mock.calls[0][1];
    expect(opts.history).toEqual([{ role: "user", text: "prev" }]);
    expect(Array.isArray(opts.tools)).toBe(true); // full set, not filtered to read
  });
  it("fails loud when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(runSlackTurn("q", [])).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
```

Create `lib/selfOrigin.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { selfOrigin } from "./selfOrigin";

afterEach(() => { delete process.env.VERCEL_URL; });

describe("selfOrigin", () => {
  it("derives origin from the request URL", () => {
    expect(selfOrigin(new Request("https://console.example.com/api/slack/events"))).toBe("https://console.example.com");
  });
  it("prefers VERCEL_URL when set", () => {
    process.env.VERCEL_URL = "my-app.vercel.app";
    expect(selfOrigin(new Request("http://localhost/api/x"))).toBe("https://my-app.vercel.app");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/agent/slackTurn.test.ts lib/selfOrigin.test.ts` → FAIL (modules not found).

- [ ] **Step 3: Implement `lib/selfOrigin.ts`**

```ts
/** Base URL for a fire-and-forget call to our own function (Phase C.2 self-invoke). */
export function selfOrigin(req: Request): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return new URL(req.url).origin;
}
```

- [ ] **Step 4: Implement `lib/agent/slackTurn.ts`**

```ts
/**
 * Write-capable Slack agent turn (Phase C.2). Runs the Phase-B loop with the FULL
 * tool set (read + proposal-gated writes) and seeded DM history; returns the
 * structured AgentResult (text | proposal | error). Fails loud on a missing key.
 * The read-only sibling (@mention) stays in lib/agent/slackAgent.askAgent.
 * SERVER-ONLY reachable. Tests mock ./loop.
 */
import { runAgent, type AgentResult } from "./loop";
import { jiraTools } from "./tools/jira";
import type { Turn } from "@/lib/agentThread";

const SLACK_MAX_ITERS = 6;

export async function runSlackTurn(text: string, history: Turn[]): Promise<AgentResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set on the server.");
  }
  return runAgent(text, { tools: jiraTools, maxIters: SLACK_MAX_ITERS, history });
}
```

- [ ] **Step 5: Run tests + tsc**

Run: `npx vitest run lib/agent/slackTurn.test.ts lib/selfOrigin.test.ts` → pass.
Run: `npx tsc --noEmit` → zero errors.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/slackTurn.ts lib/agent/slackTurn.test.ts lib/selfOrigin.ts lib/selfOrigin.test.ts
git commit -m "feat(agent): write-capable runSlackTurn + selfOrigin helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: the self-invoke runner `app/api/agent/run/route.ts`

Runs the loop off the request path and edits the placeholder; persists memory + a PENDING proposal for a DM write.

**Files:**
- Create: `app/api/agent/run/route.ts`
- Test: `app/api/agent/run/route.test.ts`

**Interfaces:**
- Consumes: `runSlackTurn` (`@/lib/agent/slackTurn`), `askAgent` (`@/lib/agent/slackAgent`), `loadTranscript`/`appendTurn` (`@/lib/agentThread`), `insertPending` (`@/lib/agentProposals`), `updateMessage` (`@/lib/slack`).
- Produces: `POST` handler. Request body JSON: `{ surface: "dm"|"mention"; channelId; userId; incomingTs; placeholderTs; threadTs?: string; question: string }`; header `x-agent-secret: <AGENT_RUN_SECRET>`.

- [ ] **Step 1: Write the failing test**

Create `app/api/agent/run/route.test.ts`. Mock `@/lib/agent/slackTurn`, `@/lib/agent/slackAgent`, `@/lib/agentThread`, `@/lib/agentProposals`, `@/lib/slack` with `vi.hoisted` spies. Cases:
- unauthorized (missing/wrong `x-agent-secret`) → 401, no `updateMessage`.
- DM text result → `updateMessage(placeholder)` with the answer + `appendTurn` called.
- DM proposal result → `updateMessage(placeholder)` with `echoUk` + `insertPending` called with the proposal's `kind`/`params`/`summaryUk`.
- missing `ANTHROPIC_API_KEY` (mock `runSlackTurn` to throw `/ANTHROPIC_API_KEY/`) → `updateMessage` with a UA error containing "ANTHROPIC_API_KEY" wording; 200.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  runSlackTurn: vi.fn(), askAgent: vi.fn(), loadTranscript: vi.fn(), appendTurn: vi.fn(),
  insertPending: vi.fn(), updateMessage: vi.fn(),
}));
vi.mock("@/lib/agent/slackTurn", () => ({ runSlackTurn: h.runSlackTurn }));
vi.mock("@/lib/agent/slackAgent", () => ({ askAgent: h.askAgent }));
vi.mock("@/lib/agentThread", () => ({ loadTranscript: h.loadTranscript, appendTurn: h.appendTurn }));
vi.mock("@/lib/agentProposals", () => ({ insertPending: h.insertPending }));
vi.mock("@/lib/slack", () => ({ updateMessage: h.updateMessage }));
import { POST } from "./route";

const SECRET = "s3cret";
beforeEach(() => {
  Object.values(h).forEach((f) => f.mockReset());
  h.loadTranscript.mockResolvedValue([]);
  process.env.AGENT_RUN_SECRET = SECRET;
});
function req(body: unknown, secret = SECRET) {
  return new Request("https://x/api/agent/run", {
    method: "POST", headers: { "x-agent-secret": secret, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const base = { surface: "dm", channelId: "C1", userId: "U1", incomingTs: "1", placeholderTs: "2", question: "q" };

describe("POST /api/agent/run", () => {
  it("401 on bad secret", async () => {
    const res = await POST(req(base, "wrong"));
    expect(res.status).toBe(401);
    expect(h.updateMessage).not.toHaveBeenCalled();
  });
  it("DM text → edits placeholder + appends turn", async () => {
    h.runSlackTurn.mockResolvedValue({ kind: "text", text: "answer" });
    await POST(req(base));
    expect(h.updateMessage).toHaveBeenCalledWith("C1", "2", "answer", expect.anything());
    expect(h.appendTurn).toHaveBeenCalledWith("C1", "q", "answer");
  });
  it("DM proposal → edits with echo + persists PENDING", async () => {
    h.runSlackTurn.mockResolvedValue({ kind: "proposal", text: "ECHO", proposal: { kind: "jira_create", params: { a: 1 }, echoUk: "ECHO", apply: vi.fn() } });
    await POST(req(base));
    expect(h.updateMessage).toHaveBeenCalledWith("C1", "2", "ECHO", expect.anything());
    expect(h.insertPending).toHaveBeenCalledWith(expect.objectContaining({ channelId: "C1", kind: "jira_create", params: { a: 1 }, summaryUk: "ECHO", proposedBy: "U1" }));
  });
  it("missing key → fails loud in the placeholder", async () => {
    h.runSlackTurn.mockRejectedValue(new Error("ANTHROPIC_API_KEY is not set on the server."));
    const res = await POST(req(base));
    expect(res.status).toBe(200);
    expect(String(h.updateMessage.mock.calls[0][2])).toMatch(/ключ|помилка|ANTHROPIC/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/api/agent/run/route.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `app/api/agent/run/route.ts`**

```ts
/**
 * Internal self-invoke runner (Phase C.2). NOT called by Slack — only fire-and-forget
 * from the events webhook, authed by AGENT_RUN_SECRET. Runs the agent loop off the
 * request path (Slack's 3s ack is respected by the webhook), then edits the
 * `🤔 думаю…` placeholder with the answer / proposal echo. DM turns use the
 * write-capable loop + memory; @mention is read-only. SERVER-ONLY route.
 */
import { runSlackTurn } from "@/lib/agent/slackTurn";
import { askAgent } from "@/lib/agent/slackAgent";
import { loadTranscript, appendTurn } from "@/lib/agentThread";
import { insertPending } from "@/lib/agentProposals";
import { updateMessage } from "@/lib/slack";
import { agentReplyKey } from "@/lib/outboundKeys";
import type { ProposalKind } from "@/lib/proposalExecutor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RunBody {
  surface: "dm" | "mention";
  channelId: string;
  userId: string;
  incomingTs: string;
  placeholderTs: string;
  threadTs?: string;
  question: string;
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.AGENT_RUN_SECRET;
  if (!secret || req.headers.get("x-agent-secret") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = (await req.json()) as RunBody;
  const meta = { key: agentReplyKey(body.userId, `${body.incomingTs}:run`), feature: "agent", channel: body.surface, trigger: "webhook" as const };

  try {
    if (body.surface === "mention") {
      const answer = await askAgent(body.question);
      await updateMessage(body.channelId, body.placeholderTs, answer, meta);
      return Response.json({ ok: true, surface: "mention" });
    }
    const history = await loadTranscript(body.channelId);
    const result = await runSlackTurn(body.question, history);
    if (result.kind === "proposal" && result.proposal) {
      await updateMessage(body.channelId, body.placeholderTs, result.proposal.echoUk, meta);
      await insertPending({
        channelId: body.channelId,
        kind: result.proposal.kind as ProposalKind,
        params: result.proposal.params,
        summaryUk: result.proposal.echoUk,
        proposedBy: body.userId,
      });
      await appendTurn(body.channelId, body.question, result.proposal.echoUk);
      return Response.json({ ok: true, surface: "dm", proposal: result.proposal.kind });
    }
    const answer = result.text.trim() || "Не маю відповіді на це.";
    await updateMessage(body.channelId, body.placeholderTs, answer, meta);
    await appendTurn(body.channelId, body.question, answer);
    return Response.json({ ok: true, surface: "dm" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("agent run failed:", err);
    const uaError = /ANTHROPIC_API_KEY/.test(message)
      ? "Помилка: на сервері не налаштований ключ ANTHROPIC_API_KEY."
      : "Сталася помилка під час обробки запиту.";
    try {
      await updateMessage(body.channelId, body.placeholderTs, uaError, meta);
    } catch (editErr) {
      console.error("agent run: placeholder edit failed:", editErr);
    }
    return Response.json({ ok: true, error: message });
  }
}
```

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run app/api/agent/run/route.test.ts` → pass.
Run: `npm run build 2>&1 | grep -i "api/agent/run" || echo OK` → route compiles.

- [ ] **Step 5: Commit**

```bash
git add app/api/agent/run/route.ts app/api/agent/run/route.test.ts
git commit -m "feat(agent): /api/agent/run self-invoke runner (loop off request path, edits placeholder)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: rewire the events webhook — fast ack + placeholder + self-invoke + DM confirm state machine

The webhook stops running the loop inline; it acks fast and defers, and handles a pending DM proposal inline.

**Files:**
- Modify: `app/api/slack/events/route.ts`
- Test: `app/api/slack/events/route.test.ts` (add C.2 cases; keep existing help/refusal cases green)

**Interfaces:**
- Consumes: `classifyDmReply` (`@/lib/agentDm`), `readPendingProposal`/`claimApply`/`setState` (`@/lib/agentProposals`), `applyProposal` (`@/lib/proposalExecutor`), `selfOrigin` (`@/lib/selfOrigin`), existing `postMessage`/`claimSlackEvent`/`isAllowedSlackUser`/`AGENT_REFUSAL_UK`/`agentReplyKey`.
- Produces: no new exports; behavior change to the `dm` and `mention` branches.

- [ ] **Step 1: Add the deferred-turn helper**

In `app/api/slack/events/route.ts`, add a helper that replaces the inline `askAgent` call. It posts the placeholder, fires the self-invoke, and returns 200 immediately:

```ts
async function deferAgentTurn(
  req: Request,
  channelId: string,
  userId: string,
  question: string,
  ts: string,
  threadTs: string | undefined,
  surface: "dm" | "mention",
): Promise<Response> {
  let placeholderTs: string;
  try {
    placeholderTs = await postMessage(channelId, "🤔 думаю…", { key: agentReplyKey(userId, `${ts}:ph`), feature: "agent", channel: surface, trigger: "webhook" }, threadTs);
  } catch (err) {
    console.error("slack events: placeholder post failed:", err);
    return ack({ handled: "agent", error: "placeholder-failed" });
  }
  const secret = process.env.AGENT_RUN_SECRET;
  if (secret) {
    void fetch(`${selfOrigin(req)}/api/agent/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-secret": secret },
      body: JSON.stringify({ surface, channelId, userId, incomingTs: ts, placeholderTs, threadTs, question }),
    }).catch((err) => console.error("slack events: self-invoke failed:", err));
  } else {
    console.error("slack events: AGENT_RUN_SECRET not set — cannot dispatch agent turn");
  }
  return ack({ handled: "agent", surface, deferred: true });
}
```

- [ ] **Step 2: Rewrite `runAgentReply` to gate + defer (no inline loop)**

Replace the body of `runAgentReply` so that, after the existing event claim + allowlist refusal, it calls `deferAgentTurn(req, ...)` instead of `await askAgent(...)`. `runAgentReply` needs the `req` object — thread it through from the call sites. Keep the existing `claimSlackEvent` and `isAllowedSlackUser`→`AGENT_REFUSAL_UK` behavior verbatim.

- [ ] **Step 3: Add the DM pending-proposal state machine**

In the `parsed.kind === "dm"` branch, BEFORE the help check is fine, but the cleanest order is: help → (claim happens in runAgentReply/confirm path) → for a non-help DM, first gate the user, then check for a pending proposal. Implement a helper invoked from the DM branch for an allowed user with a non-help message:

```ts
async function handleDmAgent(req: Request, parsed: /* DM parsed shape */): Promise<Response> {
  // claim + allowlist (reuse the same checks as runAgentReply)
  if (parsed.eventId) {
    const fresh = await claimSlackEvent(parsed.eventId, new Date().toISOString(), { eventType: "message" });
    if (!fresh) return ack({ skipped: "duplicate-event", event_id: parsed.eventId });
  }
  if (!isAllowedSlackUser(parsed.userId)) {
    await postMessage(parsed.channelId, AGENT_REFUSAL_UK, { key: agentReplyKey(parsed.userId, parsed.ts), feature: "agent", channel: "dm", trigger: "webhook" });
    return ack({ handled: "agent", refused: true });
  }
  const pending = await readPendingProposal(parsed.channelId);
  const q = parsed.text.trim();
  if (pending) {
    const decision = classifyDmReply(q);
    if (decision === "confirm") {
      const won = await claimApply(pending.id);
      const result = won ? await applyProposal(pending.kind, pending.params) : "Вже застосовано.";
      await postMessage(parsed.channelId, result, { key: agentReplyKey(parsed.userId, `${parsed.ts}:apply`), feature: "agent", channel: "dm", trigger: "webhook" });
      return ack({ handled: "agent", applied: won });
    }
    if (decision === "cancel") {
      await setState(pending.id, "CANCELLED");
      await postMessage(parsed.channelId, "Скасовано.", { key: agentReplyKey(parsed.userId, `${parsed.ts}:cancel`), feature: "agent", channel: "dm", trigger: "webhook" });
      return ack({ handled: "agent", cancelled: true });
    }
    // "other" → supersede, then fall through to a new deferred turn
    await setState(pending.id, "SUPERSEDED");
    await postMessage(parsed.channelId, "Скасував попередню пропозицію, обробляю новий запит.", { key: agentReplyKey(parsed.userId, `${parsed.ts}:supersede`), feature: "agent", channel: "dm", trigger: "webhook" });
  }
  return deferAgentTurn(req, parsed.channelId, parsed.userId, q, parsed.ts, undefined, "dm");
}
```

Wire the DM branch: help → `formatDmHelp` (unchanged); else → `return await handleDmAgent(req, parsed)`. The event claim now lives inside `handleDmAgent` for the agent path (mirroring how C.1 claimed inside `runAgentReply`) — make sure the help path still claims as it does today. Note: `applyProposal` and the confirm/cancel posts are **fast** (< 3s) so they run inline; only the new-turn path defers.

- [ ] **Step 4: Mention branch uses defer too**

In the `parsed.kind === "mention"` branch, replace the `runAgentReply(...)` call with `runAgentReply(req, ...)` (now deferring). The verdict/ask-thread deferral guard above it stays unchanged.

- [ ] **Step 5: Update the events route test**

In `app/api/slack/events/route.test.ts`, mock the new deps (`@/lib/agentDm`, `@/lib/agentProposals`, `@/lib/proposalExecutor`, `@/lib/selfOrigin`, and `fetch`). Add cases:
- DM new question (allowed, no pending) → posts `🤔 думаю…`, fires `fetch` to `/api/agent/run` (assert called, not awaited-blocking), returns 200.
- DM `так` with a pending proposal → `claimApply` + `applyProposal` + posts the result; no self-invoke.
- DM `ні` with a pending proposal → `setState(...,"CANCELLED")` + posts `Скасовано.`.
- DM other text with a pending proposal → `setState(...,"SUPERSEDED")` + posts supersede notice + fires the self-invoke.
- Existing help + refusal + verdict-thread-mention-deferral cases still pass.

Keep assertions behavior-level (spies), per the existing test's style.

- [ ] **Step 6: Run tests + full suite + build**

Run: `npx vitest run app/api/slack/events/route.test.ts` → pass.
Run: `npm test` → full suite green.
Run: `npm run build` → compiles; `npm run lint` → no new errors.

- [ ] **Step 7: Commit**

```bash
git add app/api/slack/events/route.ts app/api/slack/events/route.test.ts
git commit -m "feat(agent): DM confirm-first writes + fast-ack self-invoke (Phase C.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: CLI parity + docs + end-to-end verification

`npm run agent` already applies through `Proposal.apply()`, which now delegates to `applyProposal` — confirm parity and document C.2.

**Files:**
- Modify: `CLAUDE.md` (extend the `npm run agent` bullet); optionally `scripts/agent.ts` (only if it references `apply` in a way the `params` change touched — likely unchanged).
- Test: none new (verification task).

- [ ] **Step 1: Confirm the CLI still applies correctly**

Read `scripts/agent.ts`. It calls `res.proposal!.apply()`. Since `apply` now delegates to `applyProposal`, no code change is needed. If `scripts/agent.ts` constructs or inspects `Proposal` fields, confirm it still type-checks. Run `npx tsc --noEmit`.

- [ ] **Step 2: Update `CLAUDE.md`**

Extend the existing `npm run agent` bullet (added in Phase B) with a sentence:

```markdown
Phase C.2 wires this loop into Slack DMs: a DM question is answered (read-only), and a DM write request posts a Ukrainian confirm-first proposal that applies (via the shared `lib/proposalExecutor.applyProposal`) only after the user replies `так`/👍 — the same executor the CLI `--yes` uses. The webhook acks Slack fast and runs the loop in `/api/agent/run` (needs `AGENT_RUN_SECRET`); DM conversations remember the last 10 turns / 24h (`agent_threads`). @mention stays read-only.
```

- [ ] **Step 3: Full verification**

Run: `npm test` (full suite green), `npm run lint` (no new errors), `npm run build` (compiles).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Phase C.2 (Slack DM confirm-first writes + memory)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Ack-then-self-invoke (both read + write paths) → Tasks 6–8. ✓
- Confirm-first DM writes (persisted action + deterministic apply + state machine) → Tasks 2, 3, 5, 8. ✓
- Multi-turn memory (`agent_threads`, lightweight transcript, 24h/10-turn cap) → Tasks 1 (history), 4, 7. ✓
- Dedicated `agent_proposals` table (not the verdict table) → Task 3. ✓
- Fail-loud on missing key → Task 7. ✓
- Idempotency layers (event claim / atomic apply / send dedup) → existing + Tasks 3, 8. ✓
- CLI parity via shared executor → Tasks 2, 9. ✓
- Writes DM-only, @mention read-only but deferred → Tasks 7, 8. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The only "adjust to match real output" note (Task 2 Step 5 description literal, Task 8's parsed-shape) is an instruction to match existing code exactly, not a placeholder — the surrounding code is complete.

**Type consistency:** `Proposal.params` (Task 1) is consumed by `applyProposal` (Task 2), `insertPending` (Tasks 3, 7), and the events state machine (Task 8). `ProposalKind` (Task 2) is used in Tasks 3, 7. `Turn` (Task 4) is used in Tasks 6, 7. `runSlackTurn`/`AgentResult` (Task 6) in Task 7. `RunBody` fields (Task 7) match the `deferAgentTurn` self-invoke body (Task 8). `classifyDmReply`→`DmReply` (Task 5) used in Task 8. All aligned.

## Operator prerequisites (not code — for go-live)

- Set `AGENT_RUN_SECRET` on Vercel (new; the self-invoke auth).
- Apply the new Drizzle migration (`agent_threads`, `agent_proposals`) to Neon.
- `ANTHROPIC_API_KEY` on Vercel (already required by C.1).
- `JIRA_MRLAB_PROJECT` for Mr-Lab creates (Phase A/B carry-forward).
- Slack DM/mention subscriptions + scopes already added for C.1 — no new Slack config.
