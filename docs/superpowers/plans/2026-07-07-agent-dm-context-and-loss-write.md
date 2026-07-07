# Agent DM Context + Loss Write Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot-sent DMs become agent-thread memory (so a human reply like «Один знайшли» has context), and the agent gains a confirm-first, approver-gated `field_loss_set` write tool.

**Architecture:** (1) A pure guard + an assistant-only append run inside `postMessage`'s actual-send closure, so only genuinely-sent, top-level, non-agent DM messages land in `agent_threads` memory. (2) A `field_loss_set` write tool resolves into the existing `Proposal` shape; the shared `proposalExecutor` gains a case that writes the day-wide `instruction` ledger row and best-effort acks in the day's published verdict thread; a pure gate in the Slack events route refuses a non-approver's confirm.

**Tech Stack:** Next.js 16, TypeScript strict, Drizzle/Neon, Vitest (vi.hoisted mocks, `server-only` aliased), existing agent loop (`lib/agent/*`) + proposal machinery (`lib/agentProposals.ts`, `lib/proposalExecutor.ts`).

**Spec:** `docs/superpowers/specs/2026-07-07-agent-dm-context-and-loss-write-design.md`

## Global Constraints

- Team-facing Slack text is **Ukrainian**.
- Memory append is **best-effort**: an append failure must never fail or block the Slack send.
- Agent-feature sends (`meta.feature === "agent"`) are **excluded** from the memory hook — the run route already records agent turns via `appendTurn`; without the exclusion every agent reply/placeholder would double-record.
- Only **top-level DM** sends become memory: channel id starts with `"D"`, no `thread_ts`.
- The loss write is **day-wide** (`reportTs: ""`), `source: "instruction"` — same shape as `field-instructions --loss`; ledger precedence (instruction outranks extraction) lives in `lib/lossStore.ts` and is not re-implemented.
- Approver gate: only `lib/approvers.ts` members (Oleksandr K, Bohdan Forostianyi) can apply `field_loss_set`; a non-approver confirm gets a Ukrainian refusal and the proposal is CANCELLED, never applied.
- SHARED CHECKOUT: stage only files you touched via explicit `git add <path>`; commit on `main`.
- Run all commands from the repo root `/workspaces/orients-ops-console`.

---

### Task 1: Bot DM sends become agent memory

**Files:**
- Modify: `lib/agentThreadCap.ts` (pure guard)
- Modify: `lib/agentThread.ts` (assistant-only append)
- Modify: `lib/slack.ts:416-433` (`postMessage` wiring)
- Test: `lib/agentThreadCap.test.ts`, `lib/agentThread.test.ts` (extend both)

**Interfaces:**
- Consumes: `capTranscript` (existing), `db`/`schema.agentThreads` (existing), `rawPost`/`sendTracked` inside `lib/slack.ts` (existing).
- Produces: `shouldRecordDmBotTurn(channelId: string, threadTs: string | null, feature: string): boolean` (from `lib/agentThreadCap.ts`); `appendBotTurn(channelId: string, text: string): Promise<void>` (from `lib/agentThread.ts`).

- [ ] **Step 1: Write the failing guard tests**

Append to `lib/agentThreadCap.test.ts`:

```ts
describe("shouldRecordDmBotTurn", () => {
  it("records a top-level DM send from a non-agent feature", () => {
    expect(shouldRecordDmBotTurn("D0AB12345", null, "loss-alert")).toBe(true);
    expect(shouldRecordDmBotTurn("D0AB12345", null, "nightly-failure")).toBe(true);
  });
  it("skips channel sends", () => {
    expect(shouldRecordDmBotTurn("C0CHANNEL1", null, "loss-alert")).toBe(false);
  });
  it("skips threaded DM replies", () => {
    expect(shouldRecordDmBotTurn("D0AB12345", "111.222", "loss-alert")).toBe(false);
  });
  it("skips agent-feature sends (already recorded by appendTurn)", () => {
    expect(shouldRecordDmBotTurn("D0AB12345", null, "agent")).toBe(false);
  });
});
```

(Import `shouldRecordDmBotTurn` alongside the file's existing `capTranscript` import.)

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run lib/agentThreadCap.test.ts`
Expected: FAIL — `shouldRecordDmBotTurn` is not exported.

- [ ] **Step 3: Implement the guard**

Append to `lib/agentThreadCap.ts`:

```ts
/** Should a bot-sent Slack message be recorded into the DM agent memory?
 *  Only genuinely top-level DM sends, and never the agent's own sends —
 *  the run route records those as full user/assistant turns already. */
export function shouldRecordDmBotTurn(channelId: string, threadTs: string | null, feature: string): boolean {
  return channelId.startsWith("D") && threadTs === null && feature !== "agent";
}
```

- [ ] **Step 4: Write the failing appendBotTurn test**

Read `lib/agentThread.test.ts` first and follow its existing db-mock convention (vi.hoisted). Add a case with these assertions (adapt mock names to the file's, keep assertion content):

```ts
it("appendBotTurn appends a single assistant turn and upserts under the cap", async () => {
  // existing transcript: one user/assistant pair
  // (seed via the file's mocked select for channel "D0AB12345")
  await appendBotTurn("D0AB12345", "🛸 Втрати бортів за 2026-07: 2 (було 0).");
  // assert the upserted transcript = prior turns + { role: "assistant", text: "🛸 Втрати бортів за 2026-07: 2 (було 0)." }
  // assert the upsert targets channelId "D0AB12345" and refreshes updatedAt
});
```

- [ ] **Step 5: Run to verify RED**

Run: `npx vitest run lib/agentThread.test.ts`
Expected: FAIL — `appendBotTurn` is not exported.

- [ ] **Step 6: Implement appendBotTurn**

Add to `lib/agentThread.ts` (after `appendTurn`):

```ts
/** Append a single bot (assistant) turn — used for bot-initiated DMs (alerts,
 *  notices) so a later human reply arrives with that context. Same cap+upsert
 *  discipline as appendTurn. */
export async function appendBotTurn(channelId: string, text: string): Promise<void> {
  const prior = await loadTranscript(channelId);
  const next = capTranscript([...prior, { role: "assistant", text }], Date.now(), Date.now());
  const nowIso = new Date().toISOString();
  await db
    .insert(schema.agentThreads)
    .values({ channelId, updatedAt: nowIso, transcript: next })
    .onConflictDoUpdate({ target: schema.agentThreads.channelId, set: { updatedAt: nowIso, transcript: next } });
}
```

- [ ] **Step 7: Wire the chokepoint**

In `lib/slack.ts`, add imports:

```ts
import { appendBotTurn } from "./agentThread";
import { shouldRecordDmBotTurn } from "./agentThreadCap";
```

Change `postMessage`'s send closure (line ~431) from:

```ts
    () => rawPost(channelId, text, threadTs),
```

to:

```ts
    () =>
      rawPost(channelId, text, threadTs).then(async (ts) => {
        // Bot-initiated DMs become agent memory, so a human reply in the DM has
        // context. Runs only on an ACTUAL send (inside the sendTracked closure —
        // a dedup-skipped redelivery never re-appends). Best-effort: an append
        // failure must never fail the send.
        if (shouldRecordDmBotTurn(channelId, threadTs ?? null, meta.feature)) {
          try {
            await appendBotTurn(channelId, text);
          } catch (err) {
            console.error("postMessage: DM agent-memory append failed:", err);
          }
        }
        return ts;
      }),
```

(`meta.feature` exists on `SendMeta` — every call site sets it.)

- [ ] **Step 8: Verify GREEN + no regressions**

Run: `npx vitest run lib/agentThreadCap.test.ts lib/agentThread.test.ts && npx tsc --noEmit && npm test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add lib/agentThreadCap.ts lib/agentThreadCap.test.ts lib/agentThread.ts lib/agentThread.test.ts lib/slack.ts
git commit -m "feat(agent): bot-initiated DMs become agent-thread memory"
```

---

### Task 2: Approver gate + `field_loss_set` executor case

**Files:**
- Create: `lib/proposalGate.ts`
- Test: `lib/proposalGate.test.ts`
- Modify: `lib/proposalExecutor.ts` (ProposalKind union + case + ack helper)
- Test: `lib/proposalExecutor.test.ts` (extend)

**Interfaces:**
- Consumes: `approverFor`/`APPROVERS` (`lib/approvers.ts`), `upsertLossRecord` (`lib/lossStore.ts`), `readPublished` (`lib/published.ts`, `PublishedEntry` has `date`, `reportTs`, `channel` NAME, `ts`), `parsePeriodKey` (`lib/period.ts`), `TRACKED_CHANNELS` (`lib/slackChannels.ts`), `postMessage` (`lib/slack.ts`), `instructionAckKey`/`contentRev` (`lib/outboundKeys.ts`), `reportKey` (`lib/fieldDayVerdict.ts`).
- Produces:
  - `gateProposalApply(kind: string, proposedBy: string): { ok: true; extraParams: Record<string, unknown> } | { ok: false; refusalUk: string }` (from `lib/proposalGate.ts`)
  - `ProposalKind` includes `"field_loss_set"`; `applyProposal("field_loss_set", { date, state, note?, by? })` writes the ledger row and returns the Ukrainian result string.

- [ ] **Step 1: Write the failing gate tests**

Create `lib/proposalGate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { gateProposalApply } from "./proposalGate";

describe("gateProposalApply", () => {
  it("passes non-gated kinds for anyone", () => {
    expect(gateProposalApply("jira_create", "U_RANDOM")).toEqual({ ok: true, extraParams: {} });
  });
  it("passes field_loss_set for an approver and injects their name", () => {
    const r = gateProposalApply("field_loss_set", "U08G4EC244X");
    expect(r).toEqual({ ok: true, extraParams: { by: "Oleksandr K" } });
  });
  it("refuses field_loss_set for a non-approver, in Ukrainian", () => {
    const r = gateProposalApply("field_loss_set", "U_RANDOM");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusalUk).toContain("затверджувач");
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run lib/proposalGate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the gate**

Create `lib/proposalGate.ts`:

```ts
/**
 * Pure apply-time gate for confirm-first agent proposals. Money-affecting
 * kinds (the loss ledger) may only be applied by an authorized approver
 * (lib/approvers.ts) — mirroring the verdict-thread instruction gate. The
 * gate also injects the approver's display name as the write's `by`.
 */
import { approverFor } from "./approvers";

const APPROVER_GATED_KINDS = new Set(["field_loss_set"]);

export function gateProposalApply(
  kind: string,
  proposedBy: string,
): { ok: true; extraParams: Record<string, unknown> } | { ok: false; refusalUk: string } {
  if (!APPROVER_GATED_KINDS.has(kind)) return { ok: true, extraParams: {} };
  const approver = approverFor(proposedBy);
  if (!approver) {
    return { ok: false, refusalUk: "⛔ Зміни щодо втрат бортів може підтвердити лише затверджувач (Oleksandr K або Bohdan Forostianyi)." };
  }
  return { ok: true, extraParams: { by: approver.name } };
}
```

- [ ] **Step 4: Write the failing executor tests**

Read `lib/proposalExecutor.test.ts` first and follow its existing vi.hoisted mock structure — add mocks for `./lossStore` (`upsertLossRecord`), `./published` (`readPublished`), `./slack` (`postMessage`), keeping the existing jira/calendar mocks intact. Add these cases (adapt mock names, keep assertion content):

```ts
it("field_loss_set found: writes the day-wide instruction row and acks in the published thread", async () => {
  mocks.readPublished.mockResolvedValue({
    "2026-07-06#111.222": { date: "2026-07-06", reportTs: "111.222", channel: "field-qa", text: "…", postedAt: "t", ts: "111.222" },
  });
  const result = await applyProposal("field_loss_set", { date: "2026-07-06", state: "found", note: "знайшли на полі", by: "Oleksandr K" });
  expect(mocks.upsertLossRecord).toHaveBeenCalledWith(
    expect.objectContaining({ date: "2026-07-06", reportTs: "", lost: true, found: true, source: "instruction", updatedBy: "Oleksandr K" }),
  );
  expect(mocks.postMessage).toHaveBeenCalled(); // ack in the verdict thread
  expect(result).toContain("знято");
});

it("field_loss_set lost with no published entry: writes the row, skips the ack cleanly", async () => {
  mocks.readPublished.mockResolvedValue({});
  const result = await applyProposal("field_loss_set", { date: "2026-07-06", state: "lost", by: "Oleksandr K" });
  expect(mocks.upsertLossRecord).toHaveBeenCalledWith(expect.objectContaining({ found: false }));
  expect(mocks.postMessage).not.toHaveBeenCalled();
  expect(result).toContain("втрачено");
});

it("field_loss_set rejects an invalid state", async () => {
  await expect(applyProposal("field_loss_set", { date: "2026-07-06", state: "maybe" })).rejects.toThrow(/state/);
});
```

- [ ] **Step 5: Run to verify RED**

Run: `npx vitest run lib/proposalExecutor.test.ts`
Expected: FAIL — unknown proposal kind (and TS error on the kind string).

- [ ] **Step 6: Implement the executor case**

In `lib/proposalExecutor.ts`: add `"field_loss_set"` to the `ProposalKind` union; add imports:

```ts
import { upsertLossRecord } from "@/lib/lossStore";
import { readPublished } from "@/lib/published";
import { parsePeriodKey } from "@/lib/period";
import { TRACKED_CHANNELS } from "@/lib/slackChannels";
import { postMessage } from "@/lib/slack";
import { contentRev, instructionAckKey } from "@/lib/outboundKeys";
import { reportKey } from "@/lib/fieldDayVerdict";
import { APPROVERS } from "@/lib/approvers";
```

Add a module-local helper (above `applyProposal`):

```ts
/** Best-effort Ukrainian ack in the day's earliest published verdict thread —
 *  the visible activity log for an agent-applied loss change. Never throws:
 *  the ledger row is the substance; a missing/unpublished day just skips. */
async function ackLossInVerdictThread(date: string, text: string): Promise<void> {
  try {
    const period = parsePeriodKey(date.slice(0, 7));
    if (!period) return;
    const log = await readPublished(period);
    const entries = Object.values(log)
      .filter((e) => e.date === date)
      .sort((a, b) => (a.reportTs ?? "").localeCompare(b.reportTs ?? ""));
    const entry = entries[0];
    if (!entry) return;
    const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
    if (!channel) return;
    await postMessage(
      channel.id,
      text,
      { key: instructionAckKey(reportKey(date, entry.reportTs), "loss", contentRev(text)), feature: "instruction", channel: channel.name, trigger: "unknown" },
      entry.ts,
    );
  } catch (err) {
    console.error("field_loss_set: verdict-thread ack failed:", err);
  }
}
```

Add the case before `default:`:

```ts
    case "field_loss_set": {
      const date = str(params, "date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`field_loss_set: date must be YYYY-MM-DD, got "${date}"`);
      const state = params.state === "found" || params.state === "lost" ? params.state : null;
      if (!state) throw new Error(`field_loss_set: state must be "found" or "lost"`);
      const by = typeof params.by === "string" && params.by ? params.by : APPROVERS[0].name;
      const note =
        typeof params.note === "string" && params.note.trim()
          ? params.note.trim()
          : state === "found"
            ? "борт знайшли (через агента)"
            : "борт втрачено (через агента)";
      await upsertLossRecord({
        date,
        reportTs: "", // day-wide — same shape as `field-instructions --loss`
        lost: true,
        found: state === "found",
        note,
        source: "instruction",
        crashTextHash: null,
        updatedAt: new Date().toISOString(),
        updatedBy: by,
      });
      const ack =
        state === "found"
          ? `🛸 Зафіксовано: борт знайдено — втрату за ${date} знято — ${by}. Причина: ${note}`
          : `🛸 Зафіксовано: борт за ${date} втрачено (не знайдено) — ${by}. Причина: ${note}`;
      await ackLossInVerdictThread(date, ack);
      return state === "found"
        ? `🛸 Зафіксовано: борт знайдено — втрату за ${date} знято.`
        : `🛸 Зафіксовано: борт за ${date} втрачено (не знайдено).`;
    }
```

(`str(params, "date")` — the file's existing param helper.)

- [ ] **Step 7: Verify GREEN + no regressions**

Run: `npx vitest run lib/proposalGate.test.ts lib/proposalExecutor.test.ts && npx tsc --noEmit && npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add lib/proposalGate.ts lib/proposalGate.test.ts lib/proposalExecutor.ts lib/proposalExecutor.test.ts
git commit -m "feat(loss): field_loss_set executor case + pure approver apply-gate"
```

---

### Task 3: The `field_loss_set` write tool

**Files:**
- Modify: `lib/agent/tools/fieldLoss.ts` (add the write tool)
- Modify: `lib/agent/loop.ts` (system-prompt capability sentence)
- Test: `lib/agent/tools/fieldLoss.test.ts` (extend)

**Interfaces:**
- Consumes: `Proposal`/`Tool` (`./types`), `applyProposal` (`@/lib/proposalExecutor`, Task 2).
- Produces: `fieldLossTools` now contains two tools — the existing read tool and `field_loss_set` (`kind: "write"`, `propose` defined).

- [ ] **Step 1: Write the failing tests**

Append to `lib/agent/tools/fieldLoss.test.ts` (the write tool is pure at propose time — no new mocks needed):

```ts
describe("field_loss_set", () => {
  const writeTool = fieldLossTools.find((t) => t.name === "field_loss_set")!;
  it("is a confirm-first write tool", () => {
    expect(writeTool.kind).toBe("write");
    expect(writeTool.propose).toBeDefined();
    expect(writeTool.run).toBeUndefined();
  });
  it("proposes a found recovery with a Ukrainian echo", async () => {
    const p = await writeTool.propose!({ date: "2026-07-06", state: "found", note: "знайшли" });
    expect(p.kind).toBe("field_loss_set");
    expect(p.params).toEqual({ date: "2026-07-06", state: "found", note: "знайшли" });
    expect(p.echoUk).toContain("2026-07-06");
    expect(p.echoUk).toContain("знайдено");
  });
  it("proposes a lost state", async () => {
    const p = await writeTool.propose!({ date: "2026-07-06", state: "lost" });
    expect(p.echoUk).toContain("втрачено");
  });
  it("rejects an invalid date and an invalid state", async () => {
    await expect(writeTool.propose!({ date: "next friday", state: "found" })).rejects.toThrow(/date/i);
    await expect(writeTool.propose!({ date: "2026-07-06", state: "maybe" })).rejects.toThrow(/state/i);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run lib/agent/tools/fieldLoss.test.ts`
Expected: FAIL — no `field_loss_set` in `fieldLossTools`.

- [ ] **Step 3: Implement the tool**

In `lib/agent/tools/fieldLoss.ts`: add imports

```ts
import { applyProposal } from "@/lib/proposalExecutor";
import type { Proposal } from "./types";
```

Add the propose function and the tool entry (append the tool object to the existing `fieldLossTools` array):

```ts
/** Resolve {date, state, note?} into a confirm-first day-wide loss correction. */
export async function fieldLossSetProposal(args: Record<string, unknown>): Promise<Proposal> {
  const date = typeof args.date === "string" ? args.date.trim() : "";
  if (!DATE_RE.test(date)) throw new Error(`Invalid date "${args.date}" — use YYYY-MM-DD.`);
  const state = args.state === "found" || args.state === "lost" ? args.state : null;
  if (!state) throw new Error(`Invalid state "${args.state}" — use "found" or "lost".`);
  const note = typeof args.note === "string" && args.note.trim() ? args.note.trim() : undefined;
  const params: Record<string, unknown> = { date, state, ...(note ? { note } : {}) };
  const echoUk =
    state === "found"
      ? `🛸 Борт ${date}: знайдено — втрату знято${note ? ` (${note})` : ""}. Застосувати? (так/ні)`
      : `🛸 Борт ${date}: втрачено (не знайдено)${note ? ` (${note})` : ""}. Застосувати? (так/ні)`;
  return { kind: "field_loss_set", params, echoUk, apply: () => applyProposal("field_loss_set", params) };
}
```

Tool entry (after the read tool in the array):

```ts
  {
    name: "field_loss_set",
    description:
      "Record a drone-loss correction for a flight day: state=found marks a lost drone as recovered (the loss no longer counts — «борт знайшли»); " +
      "state=lost confirms it is permanently lost. Confirm-first: the user must approve the proposal; only approvers can apply it. " +
      "Use when the user reports a drone was found or definitively lost. Date is the FLIGHT day (YYYY-MM-DD) — check field_loss_status first if unsure which date carries the loss.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Flight date YYYY-MM-DD the loss belongs to." },
        state: { type: "string", enum: ["found", "lost"], description: "found = recovered (clears the loss); lost = permanently lost." },
        note: { type: "string", description: "Short reason/context (optional)." },
      },
      required: ["date", "state"],
    },
    kind: "write",
    propose: fieldLossSetProposal,
  },
```

In `lib/agent/loop.ts`, extend the system-prompt loss sentence (added in commit 8c95cb6) from mentioning only `field_loss_status` to also cover the write, e.g.:

```
Ти також можеш відповідати про втрати дронів за період через інструмент field_loss_status і фіксувати знайдені/втрачені борти через field_loss_set (потрібне підтвердження, лише для затверджувачів).
```

(Replace the existing sentence; keep surrounding lines untouched.)

- [ ] **Step 4: Verify GREEN + no regressions**

Run: `npx vitest run lib/agent/tools/fieldLoss.test.ts lib/agent/loop.test.ts && npx tsc --noEmit && npm test`
Expected: all pass (loop tests pass their own tools).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/tools/fieldLoss.ts lib/agent/tools/fieldLoss.test.ts lib/agent/loop.ts
git commit -m "feat(agent): field_loss_set confirm-first loss-write tool"
```

---

### Task 4: Events-route gate wiring, docs, end-to-end check

**Files:**
- Modify: `app/api/slack/events/route.ts` (confirm branch, ~line 252)
- Modify: `CLAUDE.md` (agent bullet)
- Modify: `.claude/skills/field-loss/SKILL.md` (correction paths)

**Interfaces:**
- Consumes: `gateProposalApply` (Task 2), existing `claimApply`/`applyProposal`/`setState`/`postMessage`/`agentReplyKey` in the route.

- [ ] **Step 1: Wire the gate**

In `app/api/slack/events/route.ts`, add the import:

```ts
import { gateProposalApply } from "@/lib/proposalGate";
```

In `handleAgentConversation`'s confirm branch, insert the gate BEFORE `claimApply` and spread the gate's params into the apply. Change:

```ts
    if (decision === "confirm") {
      const won = await claimApply(pending.id);
```

to:

```ts
    if (decision === "confirm") {
      // Money-affecting kinds apply only for authorized approvers; the gate also
      // resolves the approver's display name as the write's `by`.
      const gate = gateProposalApply(pending.kind, pending.proposedBy);
      if (!gate.ok) {
        await setState(pending.id, "CANCELLED");
        await postMessage(
          inp.channelId,
          gate.refusalUk,
          { key: agentReplyKey(inp.userId, `${inp.incomingTs}:gate`), feature: "agent", channel: inp.surface, trigger: "webhook" },
          inp.threadTs,
        );
        return ack({ handled: "agent", refused: "approver-gate" });
      }
      const won = await claimApply(pending.id);
```

and change the apply line from:

```ts
          result = await applyProposal(pending.kind, pending.params);
```

to:

```ts
          result = await applyProposal(pending.kind, { ...pending.params, ...gate.extraParams });
```

- [ ] **Step 2: Update the docs**

In `CLAUDE.md`, in the `npm run agent` bullet's tool list, extend the write-tools parenthetical to include `field_loss_set` (confirm-first, approver-only apply). In the `field-loss` bullet's correction sentence, add the agent path: «…or ask the agent in a DM («борт за 06.07 знайшли») — confirm-first `field_loss_set`, approver-only».

In `.claude/skills/field-loss/SKILL.md`, "Correcting the ledger" section: add the agent DM path alongside the thread reply and manual CLI.

- [ ] **Step 3: Verify — types, suite, and a live propose (no apply)**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: clean (lint: 3 pre-existing warnings).

Live end-to-end (propose only — do NOT pass `--yes`):

Run: `npm run agent -- "зафіксуй, що борт за 2026-07-06 знайшли"`
Expected: the CLI prints a confirm-first proposal whose echo contains `🛸 Борт 2026-07-06: знайдено — втрату знято` and does not apply anything (no `--yes`). If the model instead asks a clarifying question, re-run once with more explicit phrasing; report the transcript either way.

- [ ] **Step 4: Commit**

```bash
git add app/api/slack/events/route.ts CLAUDE.md .claude/skills/field-loss/SKILL.md
git commit -m "feat(agent): approver-gated apply for loss writes + docs"
```

---

## Self-Review Notes

- **Spec coverage:** §1 DM memory → Task 1 (guard + append + chokepoint, actual-send-only via the sendTracked closure); §2 tool/executor/gate → Tasks 2-3, route gate → Task 4; error handling (best-effort append, propose-time validation, apply-failure surfacing already exists in the route) → Tasks 1-2 + pre-existing; testing matrix → per-task steps. Out-of-scope items (SDK, RAG, per-report agent writes, channel-post memory) stay out.
- **Type consistency:** `gateProposalApply` return shape used identically in Task 2 (definition + tests) and Task 4 (route); `field_loss_set` params `{date, state, note?, by?}` consistent across tool (Task 3), executor (Task 2), and gate injection (`by`).
- **CLI `--yes` path:** `Proposal.apply()` calls `applyProposal` without `by` → executor defaults to `APPROVERS[0].name` (the operator) — matches `field-instructions` manual-mode convention.
- **Known accepted gap (spec-recorded):** apply-result posts in the confirm branch use `feature: "agent"` and are not appendTurn'd — pre-existing behavior, unchanged.
