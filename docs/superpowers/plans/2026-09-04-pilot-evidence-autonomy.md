# Pilot Evidence Autonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any human reply in a published-verdict thread (or a bot gap-question thread) is routed to one of: live re-verification of verifiable evidence (auto-applied), an escalation proposal tagging both approvers (unverifiable claims), the existing approver instruction/confirm path, or a read-only agent chat answer.

**Architecture:** One handler `applyThreadReply` replaces the approver-only branch in the Slack events webhook. Stage 1 is a code role gate (`isApprover`) plus regex hints; stage 2 is the existing thread-reply classifier extended with role-narrowed intents (`evidence` / `claim` / `chat`); stage 3 is a pure dispatch function. Slow work (verify = live recompute via `computeVerdicts` + `refreshPublishedDays`; chat = read-only `runAgent`) is deferred to an internal secret-protected route behind a placeholder, mirroring `/api/agent/run`. Claims reuse the `proposals` table with a new `origin` column; approvers stay the only confirmers.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Drizzle + Neon Postgres, Anthropic SDK (forced tool-use), Vitest, `--conditions=react-server` CLIs.

**Spec:** `docs/superpowers/specs/2026-09-04-pilot-evidence-autonomy-design.md`

## Global Constraints

- Every feature ships a **web** surface AND a **CLI** surface sharing pure `lib/` logic (CLAUDE.md, non-negotiable).
- Pure modules under `lib/` have no React/Next/`server-only` imports and are unit-tested; server-only modules import `"server-only"` first.
- All team-facing Slack text is **Ukrainian**. Internal report/JSON strings stay English.
- Every Slack send goes through `postMessage` / `updateMessage` from `lib/slack.ts` with a `SendMeta` key; **all new outbound keys are salted with the instructing reply's Slack ts** (2026-09-04 convention).
- Only the live verdict recompute may flip a status. **The model never applies data.**
- A pilot can never confirm anything: `confirm`/`cancel`/`instruction` are approver-only, enforced in code and in the classifier schema.
- Only two verifiable evidence kinds exist: `video` (Vimeo) and `dataset` (#datasets). Everything else is a `claim`.
- `conversationKey` for verdict-thread chat is `verdict:<thread_ts>` and writes **no** `agent_threads` rows.
- Migrations: `npx drizzle-kit generate` for the SQL + snapshot, then apply the SQL **directly** to Neon (memory `db-migrate-manual`: `npm run db:migrate` does not apply there).
- Tests: `npx vitest run <file>` per task; `npm test` + `npm run lint` + `npm run build` before the final commit.
- Commit after every task with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.

---

## File structure

| File | Responsibility |
|---|---|
| `lib/schema.ts` (modify) | `proposals.origin`, new `evidence_events` table |
| `drizzle/0014_*.sql` (generate) | migration |
| `lib/proposals.ts` (modify) | `origin` on `Proposal`/`NewProposal` |
| `lib/evidenceEvents.ts` (new) | audit store: record (idempotent) + read window |
| `lib/threadReplyHints.ts` (new, pure) | regex hints: Vimeo links, #datasets permalinks, time ranges, minutes |
| `lib/instructionClassifyPrompt.ts` (modify, pure) | role-narrowed schema, struct output, prompt, coercion backstop |
| `lib/instructionClassify.ts` (modify, server-only) | `classifyThreadReply` |
| `lib/threadReplyDecide.ts` (new, pure) | `decideThreadReply` priority dispatch + `publishedStatusHint` |
| `lib/claimProposal.ts` (new, pure) | claim → axis/instruction; escalation echo renderer |
| `lib/evidenceOutcome.ts` (new, pure) | outcome + Ukrainian verify/shortfall texts + cause hints |
| `lib/evidenceVerify.ts` (new, server-only) | sync #datasets → recompute → refresh → outcome |
| `lib/applyInstructionReply.ts` (modify) | split into `applyClassifiedInstruction` + wrapper; confirmer as `by` for pilot-origin |
| `lib/applyThreadReply.ts` (new, server-only) | THE handler: gate → classify → dispatch → inline effects or `DeferredWork` |
| `lib/threadReplyWork.ts` (new, server-only) | `runDeferredWork` (verify / chat), shared by route + CLI |
| `lib/agent/tools/fieldVerdict.ts` (new) | `field_verdict_status` read tool |
| `lib/agent/verdictChat.ts` (new, server-only) | read-only stateless chat turn for verdict threads |
| `lib/verdictPublish.ts` (modify) | export `ukrainianGaps` |
| `app/api/field/thread-reply/route.ts` (new) | internal deferred runner |
| `app/api/slack/events/route.ts` (modify) | route verdict/ask thread replies (any user) through `applyThreadReply`; `deferThreadWork` |
| `lib/applyAnswer.ts`, `scripts/fieldRememberReport.ts`, `scripts/field-remember.ts` (modify) | no auto-exception; explanations → pilot-origin proposals |
| `scripts/fieldEvidenceReport.ts` (new, pure), `scripts/field-evidence.ts` (new), `package.json` | CLI twin |
| `app/api/evidence/route.ts` (new), `app/(dashboard)/instructions/page.tsx` (modify) | web |
| `CLAUDE.md` (modify) | command entry |

---

### Task 1: Schema — `proposals.origin` + `evidence_events` + store

**Files:**
- Modify: `lib/schema.ts` (after the `proposals` table, ~line 158)
- Modify: `lib/proposals.ts:16-38` (types) and `toProposal`
- Create: `lib/evidenceEvents.ts`
- Create: `lib/evidenceEvents.test.ts`
- Generate: `drizzle/0014_*.sql`

**Interfaces:**
- Produces: `ProposalOrigin = "approver" | "pilot"`; `Proposal.origin`, `NewProposal.origin?` (default `"approver"`).
- Produces: `EvidenceEvent`, `recordEvidenceEvent(ev): Promise<{ created: boolean }>`, `readEvidenceEventsInWindow(start, end): Promise<EvidenceEvent[]>`, pure `toEvidenceEvent(row)`.

- [ ] **Step 1: Add the column + table to `lib/schema.ts`**

In the `proposals` table add after `proposedBy`:

```ts
    origin: text("origin").notNull().default("approver"), // approver|pilot — who raised it
```

Append after the `proposals` table:

```ts
/** Audit of every human reply the thread-reply handler acted on (pilot evidence
 *  autonomy, 2026-09-04): what it was classified as and what happened. Unique on
 *  source_reply_ts → a redelivered Slack event never records twice. */
export const evidenceEvents = pgTable(
  "evidence_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadTs: text("thread_ts").notNull(),
    channel: text("channel").notNull(), // tracked channel NAME
    date: text("date").notNull(),
    reportTs: text("report_ts"), // null = day-level (ask thread / legacy)
    byUserId: text("by_user_id").notNull(),
    byName: text("by_name").notNull(),
    role: text("role").notNull(), // approver|pilot
    kind: text("kind").notNull(), // evidence|claim|chat|unclear
    evidence: jsonb("evidence"), // ReplyHints + classified evidence items
    outcome: text("outcome").notNull(), // closed|still_open|hard_fail|escalated|answered|silent
    statusBefore: text("status_before"),
    statusAfter: text("status_after"),
    sourceReplyTs: text("source_reply_ts").notNull(),
    proposalId: text("proposal_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("evidence_events_source_reply_ts").on(t.sourceReplyTs),
    index("evidence_events_date").on(t.date),
  ],
);
```

- [ ] **Step 2: Thread `origin` through `lib/proposals.ts`**

```ts
export type ProposalOrigin = "approver" | "pilot";

export interface Proposal {
  id: string;
  threadTs: string;
  channel: string;
  date: string;
  axis: ProposalAxis;
  payload: unknown;
  summaryUk: string;
  proposedBy: string;
  /** Who raised it: an approver's instruction, or a pilot's unverifiable claim
   *  (only approvers may confirm a pilot-origin proposal). */
  origin: ProposalOrigin;
  sourceReplyTs: string;
  state: ProposalState;
  createdAt: string;
  resolvedAt: string | null;
}

export interface NewProposal {
  threadTs: string;
  channel: string;
  date: string;
  axis: ProposalAxis;
  payload: unknown;
  summaryUk: string;
  proposedBy: string;
  origin?: ProposalOrigin; // default "approver"
  sourceReplyTs: string;
}
```

In `toProposal` add `origin: (r.origin === "pilot" ? "pilot" : "approver"),`. In `createProposal` the insert becomes `.values({ ...input, origin: input.origin ?? "approver", state: "PROPOSED", createdAt: now, resolvedAt: null })`.

- [ ] **Step 3: Write the failing store test `lib/evidenceEvents.test.ts`** (pure mapper only — the DB functions are exercised by orchestration tests later)

```ts
import { describe, it, expect } from "vitest";
import { toEvidenceEvent } from "./evidenceEvents";

describe("toEvidenceEvent", () => {
  it("maps a row, defaulting nullable fields", () => {
    const ev = toEvidenceEvent({
      id: "e1", threadTs: "1.1", channel: "field-qa", date: "2026-09-01", reportTs: null,
      byUserId: "U1", byName: "Тарас", role: "pilot", kind: "evidence", evidence: { vimeoLinks: [] },
      outcome: "closed", statusBefore: "NEEDS_REVIEW", statusAfter: "ACCEPTED",
      sourceReplyTs: "1.2", proposalId: null, createdAt: "2026-09-04T10:00:00.000Z",
    });
    expect(ev.reportTs).toBeNull();
    expect(ev.role).toBe("pilot");
    expect(ev.outcome).toBe("closed");
  });
});
```

- [ ] **Step 4: Run it — expect FAIL (module missing)**

Run: `npx vitest run lib/evidenceEvents.test.ts`

- [ ] **Step 5: Create `lib/evidenceEvents.ts`**

```ts
/**
 * Audit store for the thread-reply handler (pilot evidence autonomy). One row
 * per human reply the bot acted on. NOT server-only: the CLI + web API import it.
 * Idempotent on sourceReplyTs (Slack redelivery).
 */
import { and, gte, lte } from "drizzle-orm";
import { db, schema } from "./db";

export type EvidenceRole = "approver" | "pilot";
export type EvidenceKind = "evidence" | "claim" | "chat" | "unclear";
export type EvidenceEventOutcome = "closed" | "still_open" | "hard_fail" | "escalated" | "answered" | "silent";

export interface EvidenceEvent {
  id: string;
  threadTs: string;
  channel: string;
  date: string;
  reportTs: string | null;
  byUserId: string;
  byName: string;
  role: EvidenceRole;
  kind: EvidenceKind;
  evidence: unknown;
  outcome: EvidenceEventOutcome;
  statusBefore: string | null;
  statusAfter: string | null;
  sourceReplyTs: string;
  proposalId: string | null;
  createdAt: string;
}

export type NewEvidenceEvent = Omit<EvidenceEvent, "id" | "createdAt">;

export function toEvidenceEvent(r: typeof schema.evidenceEvents.$inferSelect): EvidenceEvent {
  return {
    id: r.id,
    threadTs: r.threadTs,
    channel: r.channel,
    date: r.date,
    reportTs: r.reportTs ?? null,
    byUserId: r.byUserId,
    byName: r.byName,
    role: r.role === "approver" ? "approver" : "pilot",
    kind: r.kind as EvidenceKind,
    evidence: r.evidence,
    outcome: r.outcome as EvidenceEventOutcome,
    statusBefore: r.statusBefore ?? null,
    statusAfter: r.statusAfter ?? null,
    sourceReplyTs: r.sourceReplyTs,
    proposalId: r.proposalId ?? null,
    createdAt: r.createdAt,
  };
}

/** Insert once per reply; a redelivery returns created=false. */
export async function recordEvidenceEvent(ev: NewEvidenceEvent): Promise<{ created: boolean }> {
  const rows = await db
    .insert(schema.evidenceEvents)
    .values({ ...ev, createdAt: new Date().toISOString() })
    .onConflictDoNothing({ target: schema.evidenceEvents.sourceReplyTs })
    .returning({ id: schema.evidenceEvents.id });
  return { created: rows.length > 0 };
}

export async function readEvidenceEventsInWindow(start: string, end: string): Promise<EvidenceEvent[]> {
  const rows = await db
    .select()
    .from(schema.evidenceEvents)
    .where(and(gte(schema.evidenceEvents.date, start), lte(schema.evidenceEvents.date, end)));
  return rows.map(toEvidenceEvent).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}
```

- [ ] **Step 6: Run the test — expect PASS**

Run: `npx vitest run lib/evidenceEvents.test.ts`

- [ ] **Step 7: Generate + apply the migration**

Run: `npx drizzle-kit generate --name pilot_evidence` → produces `drizzle/0014_pilot_evidence.sql` + snapshot. Inspect it: it must contain `ALTER TABLE "proposals" ADD COLUMN "origin" text DEFAULT 'approver' NOT NULL;` and `CREATE TABLE "evidence_events" (...)` + the two indexes.

Apply directly to Neon (per memory `db-migrate-manual`):
```bash
set -a; source <(grep -E '^(POSTGRES_URL_NON_POOLING|POSTGRES_URL)=' .env | sed 's/=\(.*\)/="\1"/'); set +a
psql "$POSTGRES_URL_NON_POOLING" -f drizzle/0014_pilot_evidence.sql
psql "$POSTGRES_URL_NON_POOLING" -c '\d evidence_events' -c "select column_name from information_schema.columns where table_name='proposals' and column_name='origin';"
```
Expected: table described; one row `origin`.

- [ ] **Step 8: Typecheck + existing tests still green**

Run: `npx tsc --noEmit && npx vitest run lib/proposalDecision.test.ts lib/applyInstructionReply.test.ts`

- [ ] **Step 9: Commit**

```bash
git add lib/schema.ts lib/proposals.ts lib/evidenceEvents.ts lib/evidenceEvents.test.ts drizzle/
git commit -m "evidence: proposals.origin + evidence_events audit table + store

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Reply hints (pure)

**Files:**
- Create: `lib/threadReplyHints.ts`, `lib/threadReplyHints.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ReplyHints {
  vimeoLinks: { url: string; id: string }[];
  datasetPermalinks: { url: string; ts: string }[]; // ts "1234567890.123456"
  timeRanges: { start: string; end: string }[];     // "HH:MM"
  minuteFigures: number[];
}
export function extractHints(text: string, datasetsChannelId: string): ReplyHints
export function unwrapSlackLinks(text: string): string
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { extractHints, unwrapSlackLinks } from "./threadReplyHints";

const DS = "C08KG802THU";

describe("unwrapSlackLinks", () => {
  it("strips <url|label> wrappers to the bare url", () => {
    expect(unwrapSlackLinks("see <https://vimeo.com/123456789|video>")).toBe("see https://vimeo.com/123456789");
    expect(unwrapSlackLinks("<https://vimeo.com/123456789>")).toBe("https://vimeo.com/123456789");
  });
});

describe("extractHints", () => {
  it("finds vimeo links with their numeric id (incl. /manage/videos/ and Slack-wrapped)", () => {
    const h = extractHints("залив <https://vimeo.com/manage/videos/987654321|v> і https://vimeo.com/123456789/abcdef", DS);
    expect(h.vimeoLinks.map((v) => v.id)).toEqual(["987654321", "123456789"]);
  });
  it("finds #datasets permalinks only for the datasets channel id", () => {
    const h = extractHints(
      `https://x.slack.com/archives/${DS}/p1781000000000100 https://x.slack.com/archives/C08GY2NKF9D/p1781000000000200`,
      DS,
    );
    expect(h.datasetPermalinks).toEqual([{ url: `https://x.slack.com/archives/${DS}/p1781000000000100`, ts: "1781000000.000100" }]);
  });
  it("parses time ranges with : or . and any dash, zero-padding hours", () => {
    const h = extractHints("виїзд був 9.00-15:40, потім 16:00 – 18:05", DS);
    expect(h.timeRanges).toEqual([{ start: "09:00", end: "15:40" }, { start: "16:00", end: "18:05" }]);
  });
  it("parses minute figures (хв/мін/min)", () => {
    expect(extractHints("у повітрі 140 хв, відео 35 min", DS).minuteFigures).toEqual([140, 35]);
  });
  it("returns empty arrays for plain chat", () => {
    const h = extractHints("що ще бракує?", DS);
    expect(h).toEqual({ vimeoLinks: [], datasetPermalinks: [], timeRanges: [], minuteFigures: [] });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run lib/threadReplyHints.test.ts`

- [ ] **Step 3: Implement `lib/threadReplyHints.ts`**

```ts
/**
 * Deterministic hints extracted from a thread reply BEFORE classification (pilot
 * evidence autonomy). Fed to the classifier and applied as hard rules: a Vimeo
 * link is video evidence and a #datasets permalink is dataset evidence no
 * matter what the model says. Pure; unit-tested.
 */
export interface ReplyHints {
  vimeoLinks: { url: string; id: string }[];
  datasetPermalinks: { url: string; ts: string }[];
  timeRanges: { start: string; end: string }[];
  minuteFigures: number[];
}

/** Slack renders links as <url> or <url|label>; keep just the url. */
export function unwrapSlackLinks(text: string): string {
  return text.replace(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g, "$1");
}

const VIMEO_RE = /https?:\/\/(?:www\.)?vimeo\.com\/(?:[a-z]+\/[a-z]+\/)?(\d{6,})[^\s<>|]*/gi;
const PERMALINK_RE = /https?:\/\/[^\s<>|]+\/archives\/([A-Z0-9]+)\/p(\d{16})[^\s<>|]*/g;
const RANGE_RE = /(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/g;
const MINUTES_RE = /(\d{1,3})\s*(?:хв|мін|min)\b/gi;

const pad = (n: string): string => n.padStart(2, "0");

export function extractHints(text: string, datasetsChannelId: string): ReplyHints {
  const t = unwrapSlackLinks(text);
  const vimeoLinks = [...t.matchAll(VIMEO_RE)].map((m) => ({ url: m[0], id: m[1] }));
  const datasetPermalinks = [...t.matchAll(PERMALINK_RE)]
    .filter((m) => m[1] === datasetsChannelId)
    .map((m) => ({ url: m[0], ts: `${m[2].slice(0, 10)}.${m[2].slice(10)}` }));
  const timeRanges = [...t.matchAll(RANGE_RE)]
    .filter((m) => Number(m[1]) < 24 && Number(m[3]) < 24 && Number(m[2]) < 60 && Number(m[4]) < 60)
    .map((m) => ({ start: `${pad(m[1])}:${m[2]}`, end: `${pad(m[3])}:${m[4]}` }));
  const minuteFigures = [...t.matchAll(MINUTES_RE)].map((m) => Number(m[1]));
  return { vimeoLinks, datasetPermalinks, timeRanges, minuteFigures };
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add lib/threadReplyHints.ts lib/threadReplyHints.test.ts
git commit -m "evidence: deterministic reply hints (vimeo links, #datasets permalinks, windows, minutes)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Classifier — role-narrowed schema, struct output, coercion

**Files:**
- Modify: `lib/instructionClassifyPrompt.ts`
- Modify: `lib/instructionClassify.ts`
- Modify: `lib/instructionClassifyPrompt.test.ts` (append tests)

**Interfaces:**
- Consumes: `ReplyHints` (Task 2).
- Produces (pure, in `instructionClassifyPrompt.ts`):
```ts
export type ReplyRole = "approver" | "pilot";
export type ThreadReplyIntent = InstructionIntent | "evidence" | "claim" | "chat";
export interface EvidenceItem { kind: "video" | "dataset"; links: string[] }
export interface ClaimItem {
  kind: "explanation" | "deploy_window" | "airborne" | "loss_found";
  deployWindow?: { start: string; end: string };
  airborneMinutes?: number;
  text: string;
}
export interface ThreadReplyClassification extends Omit<InstructionClassification, "intent"> {
  intent: ThreadReplyIntent;
  evidence?: EvidenceItem[];
  claim?: ClaimItem;
}
export function allowedIntents(role: ReplyRole, pendingEcho: string | null): ThreadReplyIntent[]
export function classifyThreadReplyTool(role: ReplyRole, pendingEcho: string | null): Anthropic.Tool
export function buildThreadReplyPrompt(verdictMessage: string, reply: string, pendingEcho: string | null, role: ReplyRole, hints: ReplyHints): string
export function coerceThreadReply(raw: Record<string, unknown>, role: ReplyRole, pendingEcho: string | null, hints: ReplyHints): ThreadReplyClassification
```
- Produces (server-only, in `instructionClassify.ts`): `classifyThreadReply(verdictMessage, reply, pendingEcho, role, hints): Promise<ThreadReplyClassification>`. Existing `classifyInstruction` stays (CLI sweep uses it).

- [ ] **Step 1: Failing tests (append to `lib/instructionClassifyPrompt.test.ts`)**

```ts
import { allowedIntents, classifyThreadReplyTool, coerceThreadReply, buildThreadReplyPrompt } from "./instructionClassifyPrompt";
import type { ReplyHints } from "./threadReplyHints";

const noHints: ReplyHints = { vimeoLinks: [], datasetPermalinks: [], timeRanges: [], minuteFigures: [] };

describe("thread-reply classifier — role-narrowed schema", () => {
  it("pilot schema never offers confirm/cancel/instruction, even with a pending echo", () => {
    expect(allowedIntents("pilot", "прийняти день")).toEqual(["evidence", "claim", "chat", "unclear"]);
    const tool = classifyThreadReplyTool("pilot", "прийняти день");
    const intent = (tool.input_schema as { properties: { intent: { enum: string[] } } }).properties.intent;
    expect(intent.enum).not.toContain("confirm");
    expect(intent.enum).not.toContain("instruction");
  });
  it("approver schema offers confirm/cancel only with a pending echo", () => {
    expect(allowedIntents("approver", null)).toEqual(["instruction", "evidence", "claim", "chat", "unclear"]);
    expect(allowedIntents("approver", "x")).toEqual(["confirm", "cancel", "instruction", "evidence", "claim", "chat", "unclear"]);
  });
});

describe("coerceThreadReply — deterministic backstops", () => {
  it("a pilot's out-of-role intent becomes unclear", () => {
    expect(coerceThreadReply({ intent: "confirm", reason: "" }, "pilot", "x", noHints).intent).toBe("unclear");
  });
  it("a pilot's instruction-shaped reply becomes a claim/explanation", () => {
    const c = coerceThreadReply({ intent: "instruction", axis: "day", decision: "accepted_exception", reason: "прийняти день" }, "pilot", null, noHints);
    expect(c.intent).toBe("claim");
    expect(c.claim?.kind).toBe("explanation");
  });
  it("a vimeo link forces evidence(video) regardless of the model label", () => {
    const hints: ReplyHints = { ...noHints, vimeoLinks: [{ url: "https://vimeo.com/123456789", id: "123456789" }] };
    const c = coerceThreadReply({ intent: "chat", reason: "" }, "pilot", null, hints);
    expect(c.intent).toBe("evidence");
    expect(c.evidence).toEqual([{ kind: "video", links: ["https://vimeo.com/123456789"] }]);
  });
  it("a #datasets permalink forces evidence(dataset)", () => {
    const hints: ReplyHints = { ...noHints, datasetPermalinks: [{ url: "https://s/archives/C1/p1781000000000100", ts: "1781000000.000100" }] };
    const c = coerceThreadReply({ intent: "unclear", reason: "" }, "approver", null, hints);
    expect(c.evidence?.[0]).toEqual({ kind: "dataset", links: ["https://s/archives/C1/p1781000000000100"] });
  });
  it("keeps a model-provided claim alongside evidence", () => {
    const hints: ReplyHints = { ...noHints, vimeoLinks: [{ url: "https://vimeo.com/1", id: "1" }] };
    const c = coerceThreadReply(
      { intent: "evidence", evidence: [{ kind: "video", links: [] }], claim: { kind: "explanation", text: "дощ" }, reason: "" },
      "pilot", null, hints,
    );
    expect(c.intent).toBe("evidence");
    expect(c.claim?.text).toBe("дощ");
  });
  it("drops a malformed claim kind", () => {
    const c = coerceThreadReply({ intent: "claim", claim: { kind: "weather", text: "x" }, reason: "" }, "pilot", null, noHints);
    expect(c.intent).toBe("unclear");
    expect(c.claim).toBeUndefined();
  });
});

describe("buildThreadReplyPrompt", () => {
  it("names the role and lists hints", () => {
    const p = buildThreadReplyPrompt("⚠️ verdict", "залив відео", null, "pilot", { ...noHints, minuteFigures: [140] });
    expect(p).toContain("PILOT");
    expect(p).toContain("140");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run lib/instructionClassifyPrompt.test.ts`

- [ ] **Step 3: Extend `lib/instructionClassifyPrompt.ts`** (append; existing exports untouched)

```ts
import type { ReplyHints } from "./threadReplyHints";

export type ReplyRole = "approver" | "pilot";
export type ThreadReplyIntent = InstructionIntent | "evidence" | "claim" | "chat";
export interface EvidenceItem { kind: "video" | "dataset"; links: string[] }
export interface ClaimItem {
  kind: "explanation" | "deploy_window" | "airborne" | "loss_found";
  deployWindow?: { start: string; end: string };
  airborneMinutes?: number;
  /** The pilot's words (short, verbatim-ish) — becomes the proposal note. */
  text: string;
}
export interface ThreadReplyClassification extends Omit<InstructionClassification, "intent"> {
  intent: ThreadReplyIntent;
  evidence?: EvidenceItem[];
  claim?: ClaimItem;
}

/** The intents a role may return. Pilots never get confirm/cancel/instruction;
 *  confirm/cancel exist only against a pending proposal (existing rule). */
export function allowedIntents(role: ReplyRole, pendingEcho: string | null): ThreadReplyIntent[] {
  const common: ThreadReplyIntent[] = ["evidence", "claim", "chat", "unclear"];
  if (role === "pilot") return common;
  return [...(pendingEcho ? (["confirm", "cancel"] as ThreadReplyIntent[]) : []), "instruction", ...common];
}

const CLAIM_KINDS = ["explanation", "deploy_window", "airborne", "loss_found"] as const;

export function classifyThreadReplyTool(role: ReplyRole, pendingEcho: string | null): Anthropic.Tool {
  const base = CLASSIFY_INSTRUCTION_TOOL.input_schema as { properties: Record<string, unknown>; required: string[] };
  const intents = allowedIntents(role, pendingEcho);
  return {
    name: "classify_thread_reply",
    description:
      "Classify a human reply in a flight-day verdict thread: verifiable evidence (Vimeo video / #datasets notice), " +
      "an unverifiable claim (deploy window, airborne minutes, drone found, an explanation), " +
      (role === "approver" ? "an approver instruction / confirm / cancel, " : "") +
      "a chat question/comment, or unclear noise.",
    input_schema: {
      type: "object",
      properties: {
        ...base.properties,
        intent: {
          type: "string",
          enum: intents,
          description:
            "evidence = asserts data now exists in Vimeo or #datasets; claim = asserts something we cannot re-check; " +
            "chat = a question/comment asserting no data; unclear = noise" +
            (role === "approver" ? "; instruction = a data change (set axis + payload)" : "") +
            (pendingEcho && role === "approver" ? "; confirm/cancel = answers the PENDING proposal" : ""),
        },
        evidence: {
          type: "array",
          description: "evidence: what can be re-checked. kind=video (Vimeo) or dataset (#datasets). links = URLs quoted in the reply.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["video", "dataset"] },
              links: { type: "array", items: { type: "string" } },
            },
            required: ["kind", "links"],
          },
        },
        claim: {
          type: "object",
          description: "claim (may accompany evidence): the unverifiable part of the reply.",
          properties: {
            kind: { type: "string", enum: [...CLAIM_KINDS] },
            deployWindow: {
              type: "object",
              properties: { start: { type: "string" }, end: { type: "string" } },
              required: ["start", "end"],
            },
            airborneMinutes: { type: "number" },
            text: { type: "string", description: "the pilot's words, short" },
          },
          required: ["kind", "text"],
        },
      },
      required: base.required,
    },
  };
}

export function buildThreadReplyPrompt(
  verdictMessage: string,
  reply: string,
  pendingEcho: string | null,
  role: ReplyRole,
  hints: ReplyHints,
): string {
  const lines = [
    `You are reconciling a drone field-ops bonus. The bot posted a per-day verdict and a human replied in the thread.`,
    `The replier is ${role === "approver" ? "an AUTHORIZED APPROVER" : "a PILOT / team member (NOT an approver — they can provide evidence or claims, never decide)"}.`,
    `Decide what the reply means, then call classify_thread_reply.`,
    ``,
    `BOT VERDICT MESSAGE:`,
    verdictMessage,
    ``,
  ];
  if (pendingEcho && role === "approver") {
    lines.push(
      `THERE IS A PROPOSAL awaiting confirmation — the bot already echoed this change:`,
      `  «${pendingEcho}»`,
      `If the reply agrees ("так", "ок", "підтверджую", "+", "давай", 👍) → intent="confirm". If it disagrees ("ні", "скасуй", "не треба") → intent="cancel".`,
      ``,
    );
  }
  const hintLines: string[] = [];
  if (hints.vimeoLinks.length) hintLines.push(`- Vimeo links: ${hints.vimeoLinks.map((v) => v.url).join(", ")} → this IS video evidence.`);
  if (hints.datasetPermalinks.length) hintLines.push(`- #datasets permalinks: ${hints.datasetPermalinks.map((d) => d.url).join(", ")} → this IS dataset evidence.`);
  if (hints.timeRanges.length) hintLines.push(`- time ranges: ${hints.timeRanges.map((r) => `${r.start}–${r.end}`).join(", ")} → likely a deploy_window claim.`);
  if (hints.minuteFigures.length) hintLines.push(`- minute figures: ${hints.minuteFigures.join(", ")} → possibly an airborne claim.`);
  if (hintLines.length) lines.push(`DETECTED HINTS:`, ...hintLines, ``);
  lines.push(
    `HUMAN REPLY:`,
    reply,
    ``,
    `Guidance:`,
    `- evidence: "залив відео", "відео на Vimeo", a Vimeo link → kind=video; "датасет запостив", a #datasets link → kind=dataset. Only these two kinds exist.`,
    `- claim: "виїзд був 09:00–15:40" → kind=deploy_window (+deployWindow); "у повітрі 140 хв" → kind=airborne (+airborneMinutes);`,
    `  "борт знайшли" → kind=loss_found; weather / recorder failure / "ми літали" / any reason to accept → kind=explanation. text = their words.`,
    `- A reply can carry BOTH evidence and a claim ("залив відео, а датасету не було, бо дощ") → intent=evidence, fill evidence AND claim.`,
    `- chat: a question or comment that states no data ("що ще бракує?", "чому 40%?", "де подивитись?").`,
    `- unclear: noise ("ok", an emoji alone).`,
  );
  if (role === "approver") {
    lines.push(
      `- instruction (approver only): a directive to change data — crew ("склад: Тарас, Влад"), eligibility, day accept/reject ("зараховуємо", "відхилити"),`,
      `  dataset waive/decline, video waive, airborne minutes ("в повітрі було 133 хв" FROM AN APPROVER is an instruction, not a claim), loss found/lost.`,
    );
  } else {
    lines.push(`- A pilot writing "прийняти день" / "зарахуйте" is NOT an instruction — it is a claim (kind=explanation).`);
  }
  lines.push(`Return only the tool call.`);
  return lines.join("\n");
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Deterministic backstop over the model output: role gate, hint hard-rules, shape validation. */
export function coerceThreadReply(
  raw: Record<string, unknown>,
  role: ReplyRole,
  pendingEcho: string | null,
  hints: ReplyHints,
): ThreadReplyClassification {
  const allowed = allowedIntents(role, pendingEcho);
  let intent: ThreadReplyIntent = allowed.includes(raw.intent as ThreadReplyIntent) ? (raw.intent as ThreadReplyIntent) : "unclear";

  // Evidence: model items ∪ hint hard-rules (hint links win; dedupe by kind).
  const modelEvidence = Array.isArray(raw.evidence)
    ? (raw.evidence as unknown[]).flatMap((e) => {
        const o = e as { kind?: unknown; links?: unknown };
        if (o.kind !== "video" && o.kind !== "dataset") return [];
        return [{ kind: o.kind, links: Array.isArray(o.links) ? o.links.map(String) : [] } as EvidenceItem];
      })
    : [];
  const byKind = new Map<EvidenceItem["kind"], Set<string>>();
  for (const e of modelEvidence) byKind.set(e.kind, new Set([...(byKind.get(e.kind) ?? []), ...e.links]));
  if (hints.vimeoLinks.length) byKind.set("video", new Set([...(byKind.get("video") ?? []), ...hints.vimeoLinks.map((v) => v.url)]));
  if (hints.datasetPermalinks.length) byKind.set("dataset", new Set([...(byKind.get("dataset") ?? []), ...hints.datasetPermalinks.map((d) => d.url)]));
  const evidence = [...byKind].map(([kind, links]) => ({ kind, links: [...links] }));

  // Claim shape.
  let claim: ClaimItem | undefined;
  const rc = raw.claim as Record<string, unknown> | undefined;
  if (rc && (CLAIM_KINDS as readonly string[]).includes(String(rc.kind))) {
    const dw = rc.deployWindow as { start?: unknown; end?: unknown } | undefined;
    claim = {
      kind: rc.kind as ClaimItem["kind"],
      text: str(rc.text) ?? str(raw.reason) ?? "",
      ...(dw && str(dw.start) && str(dw.end) ? { deployWindow: { start: str(dw.start)!, end: str(dw.end)! } } : {}),
      ...(typeof rc.airborneMinutes === "number" && Number.isFinite(rc.airborneMinutes) ? { airborneMinutes: rc.airborneMinutes } : {}),
    };
  }

  // A pilot's instruction-shaped text is a claim, never an instruction.
  if (role === "pilot" && raw.intent === "instruction") {
    intent = "claim";
    claim = claim ?? { kind: "explanation", text: str(raw.reason) ?? "" };
  }
  if (evidence.length) intent = "evidence";
  else if (intent === "evidence") intent = claim ? "claim" : "unclear";
  if (intent === "claim" && !claim) intent = "unclear";

  return {
    ...(role === "approver" && intent === "instruction" ? pickInstructionFields(raw) : {}),
    intent,
    ...(evidence.length ? { evidence } : {}),
    ...(claim ? { claim } : {}),
    reason: String(raw.reason ?? ""),
  };
}

const VALID_AXES: InstructionAxis[] = ["crew", "eligibility", "day", "dataset", "video", "airborne", "loss"];
const arr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined;

/** The existing per-axis payload fields (same rules as classifyInstruction's narrowing). */
function pickInstructionFields(raw: Record<string, unknown>): Omit<InstructionClassification, "intent" | "reason"> {
  return {
    axis: VALID_AXES.includes(raw.axis as InstructionAxis) ? (raw.axis as InstructionAxis) : undefined,
    roster: arr(raw.roster), add: arr(raw.add), remove: arr(raw.remove), counted: arr(raw.counted), notCounted: arr(raw.notCounted),
    decision: raw.decision === "accepted_exception" || raw.decision === "rejected" ? raw.decision : undefined,
    datasetStatus: raw.datasetStatus === "WAIVED" || raw.datasetStatus === "DECLINED" ? raw.datasetStatus : undefined,
    videoWaive: raw.videoWaive === true ? true : undefined,
    airborneMinutes: typeof raw.airborneMinutes === "number" && Number.isFinite(raw.airborneMinutes) ? raw.airborneMinutes : undefined,
    lossState: raw.lossState === "found" || raw.lossState === "lost" ? raw.lossState : undefined,
  };
}
```

- [ ] **Step 4: Add `classifyThreadReply` to `lib/instructionClassify.ts`**

```ts
import { classifyThreadReplyTool, buildThreadReplyPrompt, coerceThreadReply, type ReplyRole, type ThreadReplyClassification } from "./instructionClassifyPrompt";
import type { ReplyHints } from "./threadReplyHints";

/** One forced tool call over a thread reply from ANY human (role-narrowed schema + deterministic backstop). */
export async function classifyThreadReply(
  verdictMessage: string,
  reply: string,
  pendingEcho: string | null,
  role: ReplyRole,
  hints: ReplyHints,
): Promise<ThreadReplyClassification> {
  if (!process.env.ANTHROPIC_API_KEY) throw new InstructionClassifyError("ANTHROPIC_API_KEY is not set on the server.");
  const client = new Anthropic();
  const tool = classifyThreadReplyTool(role, pendingEcho);
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: buildThreadReplyPrompt(verdictMessage, reply, pendingEcho, role, hints) }],
    });
  } catch (error) {
    throw new InstructionClassifyError(`Claude request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (message.stop_reason === "refusal") throw new InstructionClassifyError("Claude declined the classification.");
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new InstructionClassifyError("Claude returned no tool_use block.");
  return coerceThreadReply(toolUse.input as Record<string, unknown>, role, pendingEcho, hints);
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx vitest run lib/instructionClassifyPrompt.test.ts && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add lib/instructionClassifyPrompt.ts lib/instructionClassifyPrompt.test.ts lib/instructionClassify.ts
git commit -m "evidence: role-narrowed thread-reply classifier (evidence/claim/chat) + deterministic coercion

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Dispatch (pure)

**Files:**
- Create: `lib/threadReplyDecide.ts`, `lib/threadReplyDecide.test.ts`

**Interfaces:**
- Consumes: `ThreadReplyClassification`, `ReplyRole`, `EvidenceItem`, `ClaimItem` (Task 3).
- Produces:
```ts
export type PublishedStatusHint = "accepted" | "needs_review" | "rejected" | "unknown";
export function publishedStatusHint(text: string): PublishedStatusHint
export type ThreadReplyAction =
  | { type: "confirm" } | { type: "cancel" } | { type: "instruction" }
  | { type: "verify"; evidence: EvidenceItem[]; claim?: ClaimItem }
  | { type: "escalate"; claim: ClaimItem }
  | { type: "chat" }
  | { type: "silent"; reason: string };
export function decideThreadReply(c: ThreadReplyClassification, role: ReplyRole, hasPending: boolean, status: PublishedStatusHint): ThreadReplyAction
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { decideThreadReply, publishedStatusHint } from "./threadReplyDecide";
import type { ThreadReplyClassification } from "./instructionClassifyPrompt";

const c = (p: Partial<ThreadReplyClassification>): ThreadReplyClassification => ({ intent: "unclear", reason: "", ...p });
const claim = { kind: "explanation" as const, text: "дощ" };
const video = [{ kind: "video" as const, links: ["https://vimeo.com/1"] }];

describe("publishedStatusHint", () => {
  it("reads the leading icon", () => {
    expect(publishedStatusHint("✅ 2026-09-01 — прийнято")).toBe("accepted");
    expect(publishedStatusHint("⚠️ 2026-09-01 — потрібна перевірка")).toBe("needs_review");
    expect(publishedStatusHint("⛔ 2026-09-01 — відхилено")).toBe("rejected");
    expect(publishedStatusHint("За 2026-09-01 на Vimeo…")).toBe("unknown");
  });
});

describe("decideThreadReply — priority", () => {
  it("approver confirm/cancel with pending wins", () => {
    expect(decideThreadReply(c({ intent: "confirm" }), "approver", true, "needs_review")).toEqual({ type: "confirm" });
    expect(decideThreadReply(c({ intent: "cancel" }), "approver", true, "needs_review")).toEqual({ type: "cancel" });
  });
  it("approver confirm with nothing pending is silent", () => {
    expect(decideThreadReply(c({ intent: "confirm" }), "approver", false, "needs_review").type).toBe("silent");
  });
  it("pilot confirm is always silent (never confirms)", () => {
    expect(decideThreadReply(c({ intent: "confirm" }), "pilot", true, "needs_review").type).toBe("silent");
  });
  it("approver instruction → instruction", () => {
    expect(decideThreadReply(c({ intent: "instruction", axis: "day", decision: "rejected" }), "approver", false, "needs_review")).toEqual({ type: "instruction" });
  });
  it("evidence → verify, carrying the claim", () => {
    expect(decideThreadReply(c({ intent: "evidence", evidence: video, claim }), "pilot", false, "needs_review")).toEqual({ type: "verify", evidence: video, claim });
  });
  it("evidence on a rejected day still verifies (the verifier reports hard_fail)", () => {
    expect(decideThreadReply(c({ intent: "evidence", evidence: video }), "pilot", false, "rejected").type).toBe("verify");
  });
  it("claim → escalate unless the day is already accepted", () => {
    expect(decideThreadReply(c({ intent: "claim", claim }), "pilot", false, "needs_review")).toEqual({ type: "escalate", claim });
    expect(decideThreadReply(c({ intent: "claim", claim }), "pilot", false, "accepted").type).toBe("silent");
  });
  it("chat → chat for both roles", () => {
    expect(decideThreadReply(c({ intent: "chat" }), "pilot", false, "needs_review")).toEqual({ type: "chat" });
    expect(decideThreadReply(c({ intent: "chat" }), "approver", true, "needs_review")).toEqual({ type: "chat" });
  });
  it("unclear → silent", () => {
    expect(decideThreadReply(c({ intent: "unclear" }), "pilot", false, "needs_review").type).toBe("silent");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `lib/threadReplyDecide.ts`**

```ts
/**
 * Pure dispatch for a classified thread reply (pilot evidence autonomy). The
 * model said WHAT the text is; this decides WHAT HAPPENS, with the role gate
 * repeated in code so a mislabel can never let a pilot confirm or instruct.
 * Priority within one reply: confirm/cancel → instruction → verify → escalate → chat → silent.
 */
import type { ClaimItem, EvidenceItem, ReplyRole, ThreadReplyClassification } from "./instructionClassifyPrompt";

export type PublishedStatusHint = "accepted" | "needs_review" | "rejected" | "unknown";

/** Status of a published verdict from its leading icon (the only status signal the
 *  handler has without a recompute). Ask-question texts have no icon → unknown. */
export function publishedStatusHint(text: string): PublishedStatusHint {
  const head = text.trimStart().slice(0, 2);
  if (head.startsWith("✅")) return "accepted";
  if (head.startsWith("⚠️") || head.startsWith("⚠")) return "needs_review";
  if (head.startsWith("⛔")) return "rejected";
  return "unknown";
}

export type ThreadReplyAction =
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "instruction" }
  | { type: "verify"; evidence: EvidenceItem[]; claim?: ClaimItem }
  | { type: "escalate"; claim: ClaimItem }
  | { type: "chat" }
  | { type: "silent"; reason: string };

export function decideThreadReply(
  c: ThreadReplyClassification,
  role: ReplyRole,
  hasPending: boolean,
  status: PublishedStatusHint,
): ThreadReplyAction {
  if (c.intent === "confirm" || c.intent === "cancel") {
    if (role !== "approver") return { type: "silent", reason: "pilot-cannot-confirm" };
    if (!hasPending) return { type: "silent", reason: "nothing-pending" };
    return { type: c.intent };
  }
  if (c.intent === "instruction") {
    if (role !== "approver" || !c.axis) return { type: "silent", reason: "instruction-not-allowed" };
    return { type: "instruction" };
  }
  if (c.intent === "evidence" && c.evidence?.length) {
    return { type: "verify", evidence: c.evidence, ...(c.claim ? { claim: c.claim } : {}) };
  }
  if (c.intent === "claim" && c.claim) {
    if (status === "accepted") return { type: "silent", reason: "already-accepted" };
    return { type: "escalate", claim: c.claim };
  }
  if (c.intent === "chat") return { type: "chat" };
  return { type: "silent", reason: "unclear" };
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add lib/threadReplyDecide.ts lib/threadReplyDecide.test.ts
git commit -m "evidence: pure dispatch for classified thread replies

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Claim → proposal mapping + escalation echo (pure)

**Files:**
- Create: `lib/claimProposal.ts`, `lib/claimProposal.test.ts`

**Interfaces:**
- Consumes: `ClaimItem`, `InstructionAxis`, `InstructionClassification` (Task 3); `GapType` from `lib/askGaps.ts`; `APPROVERS` from `lib/approvers.ts`.
- Produces:
```ts
export function claimToInstruction(claim: ClaimItem, byName: string): { axis: InstructionAxis; instruction: InstructionClassification }
export function askClaimToInstruction(gapType: GapType, claim: ClaimItem, byName: string): { axis: InstructionAxis; instruction: InstructionClassification }
export function renderEscalationEcho(args: { byName: string; claimText: string; summaryUk: string; verifyLine?: string }): string
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { askClaimToInstruction, claimToInstruction, renderEscalationEcho } from "./claimProposal";

describe("claimToInstruction", () => {
  it("explanation → day/accepted_exception with the pilot's words", () => {
    const r = claimToInstruction({ kind: "explanation", text: "дощ, запис не працював" }, "Тарас");
    expect(r.axis).toBe("day");
    expect(r.instruction.decision).toBe("accepted_exception");
    expect(r.instruction.reason).toBe("за словами Тарас: дощ, запис не працював");
  });
  it("deploy_window → day/accepted_exception noting the window (no deploy override axis in v1)", () => {
    const r = claimToInstruction({ kind: "deploy_window", text: "виїзд 9-15:40", deployWindow: { start: "09:00", end: "15:40" } }, "Влад");
    expect(r.axis).toBe("day");
    expect(r.instruction.reason).toContain("виїзд 09:00–15:40");
  });
  it("airborne → airborne axis", () => {
    const r = claimToInstruction({ kind: "airborne", text: "140 хв", airborneMinutes: 140 }, "Влад");
    expect(r).toMatchObject({ axis: "airborne", instruction: { airborneMinutes: 140 } });
  });
  it("loss_found → loss/found", () => {
    expect(claimToInstruction({ kind: "loss_found", text: "борт знайшли" }, "Влад")).toMatchObject({ axis: "loss", instruction: { lossState: "found" } });
  });
  it("airborne claim without a number degrades to an explanation", () => {
    expect(claimToInstruction({ kind: "airborne", text: "довго літали" }, "Влад").axis).toBe("day");
  });
});

describe("askClaimToInstruction", () => {
  it("maps by gap type: no_dataset → dataset WAIVED, low_video → video waive", () => {
    expect(askClaimToInstruction("no_dataset", { kind: "explanation", text: "не було" }, "Тарас")).toMatchObject({ axis: "dataset", instruction: { datasetStatus: "WAIVED" } });
    expect(askClaimToInstruction("low_video", { kind: "explanation", text: "камера" }, "Тарас")).toMatchObject({ axis: "video", instruction: { videoWaive: true } });
  });
});

describe("renderEscalationEcho", () => {
  it("tags both approvers, quotes the pilot, states the proposal", () => {
    const t = renderEscalationEcho({ byName: "Тарас", claimText: "дощ", summaryUk: "прийняти день 2026-09-01 (виняток)", verifyLine: "відео 48 хв = 40% від 120 хв" });
    expect(t).toContain("<@U08G4EC244X>");
    expect(t).toContain("<@U08G4HZQTTR>");
    expect(t).toContain("Тарас повідомляє: «дощ»");
    expect(t).toContain("Перевірив: відео 48 хв");
    expect(t).toContain("Пропоную: прийняти день 2026-09-01 (виняток)");
    expect(t).toMatch(/«так» \/ «ні»/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `lib/claimProposal.ts`**

```ts
/**
 * Map a pilot's unverifiable claim onto an EXISTING instruction axis (no new
 * override tables in v1 — see spec §5), and render the escalation echo that tags
 * both approvers. Pure; unit-tested.
 */
import { APPROVERS } from "./approvers";
import type { GapType } from "./askGaps";
import type { ClaimItem, InstructionAxis, InstructionClassification } from "./instructionClassifyPrompt";

const said = (byName: string, text: string): string => `за словами ${byName}: ${text}`.trim();

export function claimToInstruction(claim: ClaimItem, byName: string): { axis: InstructionAxis; instruction: InstructionClassification } {
  if (claim.kind === "airborne" && typeof claim.airborneMinutes === "number") {
    return { axis: "airborne", instruction: { intent: "instruction", axis: "airborne", airborneMinutes: claim.airborneMinutes, reason: said(byName, claim.text) } };
  }
  if (claim.kind === "loss_found") {
    return { axis: "loss", instruction: { intent: "instruction", axis: "loss", lossState: "found", reason: said(byName, claim.text) } };
  }
  const window = claim.kind === "deploy_window" && claim.deployWindow ? ` (виїзд ${claim.deployWindow.start}–${claim.deployWindow.end})` : "";
  return {
    axis: "day",
    instruction: { intent: "instruction", axis: "day", decision: "accepted_exception", reason: `${said(byName, claim.text)}${window}` },
  };
}

/** In a bot gap-question thread the axis is fixed by the gap the bot asked about. */
export function askClaimToInstruction(gapType: GapType, claim: ClaimItem, byName: string): { axis: InstructionAxis; instruction: InstructionClassification } {
  if (gapType === "no_dataset") {
    return { axis: "dataset", instruction: { intent: "instruction", axis: "dataset", datasetStatus: "WAIVED", reason: said(byName, claim.text) } };
  }
  return { axis: "video", instruction: { intent: "instruction", axis: "video", videoWaive: true, reason: said(byName, claim.text) } };
}

export function renderEscalationEcho(args: { byName: string; claimText: string; summaryUk: string; verifyLine?: string }): string {
  const tags = APPROVERS.map((a) => `<@${a.userId}>`).join(" ");
  const verify = args.verifyLine ? ` Перевірив: ${args.verifyLine}.` : "";
  return `🔎 ${args.byName} повідомляє: «${args.claimText}».${verify} Пропоную: ${args.summaryUk}. ${tags} — «так» / «ні».`;
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add lib/claimProposal.ts lib/claimProposal.test.ts
git commit -m "evidence: claim → existing-axis proposal mapping + approver-tagging escalation echo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Evidence outcome + Ukrainian verify texts (pure)

**Files:**
- Create: `lib/evidenceOutcome.ts`, `lib/evidenceOutcome.test.ts`
- Modify: `lib/verdictPublish.ts` — add `export` to `function ukrainianGaps`

**Interfaces:**
- Consumes: `DayVerdict`, `VerdictStatus` (`lib/fieldDayVerdict.ts`); `ReplyHints` (Task 2); `videoFlightDate` (`lib/reconcile.ts`); `MIN_RATIO`; `ukrainianGaps` (now exported).
- Produces:
```ts
export type EvidenceOutcomeKind = "closed" | "still_open" | "hard_fail";
export interface LinkedVideo { id: string; name: string; created_time: string; link: string }
export interface OutcomeArgs {
  day: DayVerdict | null;              // the report's fresh verdict (null = not found after recompute)
  byName: string;
  hints: ReplyHints;
  linkedVideos: LinkedVideo[];         // videos resolved from hints.vimeoLinks (may be partial)
  datasetLinkDates: Map<string, string>; // permalink ts → the message's Kyiv date
}
export function evidenceOutcome(a: OutcomeArgs): { outcome: EvidenceOutcomeKind; text: string; verifyLine: string }
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { evidenceOutcome } from "./evidenceOutcome";
import type { DayVerdict } from "./fieldDayVerdict";
import type { ReplyHints } from "./threadReplyHints";

const noHints: ReplyHints = { vimeoLinks: [], datasetPermalinks: [], timeRanges: [], minuteFigures: [] };
const day = (p: Partial<DayVerdict>): DayVerdict => ({
  date: "2026-09-01", reportTs: "1.1", reportSeq: 1, reportCount: 1, status: "NEEDS_REVIEW",
  airborneMinutes: 120, videoMinutes: 48, ratio: 0.4, datasetStatus: "POSTED", withinGrace: false,
  reasons: [], roster: ["Тарас"], unknownInitials: [], airborneReported: true, deployMin: 300, ...p,
});

describe("evidenceOutcome", () => {
  it("ACCEPTED → closed with the fresh numbers and thanks", () => {
    const r = evidenceOutcome({ day: day({ status: "ACCEPTED", videoMinutes: 96, ratio: 0.8 }), byName: "Тарас", hints: noHints, linkedVideos: [], datasetLinkDates: new Map() });
    expect(r.outcome).toBe("closed");
    expect(r.text).toContain("✅ Перевірив");
    expect(r.text).toContain("96 хв");
    expect(r.text).toContain("80%");
    expect(r.text).toContain("Тарас");
  });
  it("NEEDS_REVIEW → still_open with the shortfall in minutes", () => {
    const r = evidenceOutcome({ day: day({}), byName: "Тарас", hints: noHints, linkedVideos: [], datasetLinkDates: new Map() });
    expect(r.outcome).toBe("still_open");
    expect(r.text).toContain("48 хв");
    expect(r.text).toContain("40%");
    expect(r.text).toContain("бракує 12 хв");
  });
  it("names a linked video whose name carries no date for this day", () => {
    const hints: ReplyHints = { ...noHints, vimeoLinks: [{ url: "https://vimeo.com/1", id: "1" }] };
    const r = evidenceOutcome({
      day: day({}), byName: "Тарас", hints,
      linkedVideos: [{ id: "1", name: "DJI_0001", created_time: "2026-09-03T10:00:00Z", link: "https://vimeo.com/1" }],
      datasetLinkDates: new Map(),
    });
    expect(r.text).toContain("DJI_0001");
    expect(r.text).toContain("без дати в назві");
    expect(r.text).toContain("01.09");
  });
  it("names a linked video dated another day", () => {
    const hints: ReplyHints = { ...noHints, vimeoLinks: [{ url: "https://vimeo.com/2", id: "2" }] };
    const r = evidenceOutcome({
      day: day({}), byName: "Тарас", hints,
      linkedVideos: [{ id: "2", name: "2026-08-30 політ", created_time: "2026-09-03T10:00:00Z", link: "https://vimeo.com/2" }],
      datasetLinkDates: new Map(),
    });
    expect(r.text).toContain("датоване 30.08");
  });
  it("names a #datasets link dated another day", () => {
    const hints: ReplyHints = { ...noHints, datasetPermalinks: [{ url: "u", ts: "1.5" }] };
    const r = evidenceOutcome({ day: day({ datasetStatus: "MISSING" }), byName: "Тарас", hints, linkedVideos: [], datasetLinkDates: new Map([["1.5", "2026-08-30"]]) });
    expect(r.text).toContain("#datasets");
    expect(r.text).toContain("іншим днем");
  });
  it("REJECTED → hard_fail pointing at the claim path", () => {
    const r = evidenceOutcome({ day: day({ status: "REJECTED", deployMin: 150 }), byName: "Тарас", hints: noHints, linkedVideos: [], datasetLinkDates: new Map() });
    expect(r.outcome).toBe("hard_fail");
    expect(r.text).toContain("⛔");
    expect(r.text).toContain("пояснення");
  });
  it("missing day after recompute → still_open with a plain notice", () => {
    const r = evidenceOutcome({ day: null, byName: "Тарас", hints: noHints, linkedVideos: [], datasetLinkDates: new Map() });
    expect(r.outcome).toBe("still_open");
    expect(r.text).toContain("не знайшов");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Export `ukrainianGaps` in `lib/verdictPublish.ts`** — change `function ukrainianGaps(day: DayVerdict): string[] {` to `export function ukrainianGaps(day: DayVerdict): string[] {`.

- [ ] **Step 4: Implement `lib/evidenceOutcome.ts`**

```ts
/**
 * Pure outcome of an evidence re-check (pilot evidence autonomy, spec §4): the
 * fresh verdict → closed / still_open / hard_fail + the Ukrainian text the bot
 * posts, with DETERMINISTIC cause hints (a Vimeo video named without the date,
 * a #datasets message dated another day). Never model text.
 */
import { MIN_RATIO } from "./reconcile";
import { videoFlightDate } from "./reconcile";
import { ukrainianGaps } from "./verdictPublish";
import type { DayVerdict } from "./fieldDayVerdict";
import type { ReplyHints } from "./threadReplyHints";

export type EvidenceOutcomeKind = "closed" | "still_open" | "hard_fail";
export interface LinkedVideo { id: string; name: string; created_time: string; link: string }
export interface OutcomeArgs {
  day: DayVerdict | null;
  byName: string;
  hints: ReplyHints;
  linkedVideos: LinkedVideo[];
  datasetLinkDates: Map<string, string>;
}

const ddmm = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

function numbersLine(d: DayVerdict): string {
  const pct = d.ratio === null ? "—" : `${Math.round(d.ratio * 100)}%`;
  const ds = d.datasetStatus === "POSTED" || d.datasetStatus === "WAIVED" ? "датасет є" : "датасету немає";
  return `відео ${d.videoMinutes.toFixed(0)} хв = ${pct} від ${d.airborneMinutes.toFixed(0)} хв у повітрі, ${ds}`;
}

function causeHints(a: OutcomeArgs, date: string): string[] {
  const out: string[] = [];
  for (const l of a.hints.vimeoLinks) {
    const v = a.linkedVideos.find((x) => x.id === l.id);
    if (!v) { out.push(`відео ${l.url} не знайдено в акаунті Vimeo`); continue; }
    const attributed = videoFlightDate(v.name, v.created_time);
    if (attributed === date) continue;
    const nameHasDate = /\d{1,2}[.\-_]\d{1,2}([.\-_]\d{2,4})?|\d{4}-\d{2}-\d{2}/.test(v.name);
    out.push(
      nameHasDate
        ? `відео «${v.name}» датоване ${ddmm(attributed)}, не цим днем`
        : `відео «${v.name}» без дати в назві — зараховано на ${ddmm(attributed)} (дата завантаження); перейменуйте, додавши ${ddmm(date)}`,
    );
  }
  for (const p of a.hints.datasetPermalinks) {
    const d = a.datasetLinkDates.get(p.ts);
    if (d && d !== date) out.push(`повідомлення в #datasets датоване іншим днем (${ddmm(d)})`);
  }
  return out;
}

export function evidenceOutcome(a: OutcomeArgs): { outcome: EvidenceOutcomeKind; text: string; verifyLine: string } {
  if (!a.day) {
    return { outcome: "still_open", text: `🔎 Перевірив, але не знайшов цей звіт у свіжому розрахунку — спробуйте пізніше або напишіть затверджувачам.`, verifyLine: "звіт не знайдено" };
  }
  const d = a.day;
  const line = numbersLine(d);
  if (d.status === "ACCEPTED" || d.status === "ACCEPTED_EXCEPTION") {
    return { outcome: "closed", text: `✅ Перевірив: ${line} — день прийнято. Дякую, ${a.byName}.`, verifyLine: line };
  }
  if (d.status === "REJECTED") {
    const gaps = ukrainianGaps(d).join("; ");
    return {
      outcome: "hard_fail",
      text: `⛔ День відхилено (${gaps}) — відео чи датасет тут не допоможуть. Якщо є пояснення, напишіть його — передам затверджувачам.`,
      verifyLine: line,
    };
  }
  const parts: string[] = [`🔎 Перевірив: ${line}.`];
  const videoOk = d.ratio !== null && d.ratio >= MIN_RATIO;
  if (!videoOk) {
    const need = Math.max(0, Math.ceil(d.airborneMinutes * MIN_RATIO - d.videoMinutes));
    parts.push(`Бракує ${need} хв відео.`);
  }
  const otherGaps = ukrainianGaps(d).filter((g) => !g.startsWith("відео"));
  if (otherGaps.length) parts.push(`Також: ${otherGaps.join("; ")}.`);
  const causes = causeHints(a, d.date);
  if (causes.length) parts.push(`Можлива причина: ${causes.join("; ")}.`);
  return { outcome: "still_open", text: parts.join(" "), verifyLine: line };
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx vitest run lib/evidenceOutcome.test.ts lib/verdictPublish.test.ts`

- [ ] **Step 6: Commit**

```bash
git add lib/evidenceOutcome.ts lib/evidenceOutcome.test.ts lib/verdictPublish.ts
git commit -m "evidence: pure re-check outcome + Ukrainian shortfall/closed/hard-fail texts with cause hints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `verifyEvidence` (server-only orchestration)

**Files:**
- Create: `lib/evidenceVerify.ts`, `lib/evidenceVerify.test.ts`

**Interfaces:**
- Consumes: `syncAllChannels` (`lib/syncChannels.ts`), `computeVerdicts` (`lib/computeVerdicts.ts`), `refreshPublishedDays` (`lib/refreshPublished.ts`), `readReportJson`, `periodKey` (`lib/reports.ts`), `fetchVideosInPeriod` (`lib/vimeo.ts`), `readChannelMessages` (`lib/slackMirror.ts`), `reportKey` (`lib/fieldDayVerdict.ts`), `evidenceOutcome` (Task 6), `TRACKED_CHANNELS`.
- Produces:
```ts
export interface VerifyArgs { date: string; reportTs: string | null; period: Period; hints: ReplyHints; byName: string; trigger: SendTrigger; onLog?: (m: string) => void }
export interface VerifyResult { outcome: EvidenceOutcomeKind; text: string; verifyLine: string; statusBefore: string | null; statusAfter: string | null }
export async function verifyEvidence(a: VerifyArgs): Promise<VerifyResult>
```

- [ ] **Step 1: Failing orchestration test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { syncAllChannels, computeVerdicts, refreshPublishedDays, readReportJson, fetchVideosInPeriod, readChannelMessages } = vi.hoisted(() => ({
  syncAllChannels: vi.fn(), computeVerdicts: vi.fn(), refreshPublishedDays: vi.fn(), readReportJson: vi.fn(), fetchVideosInPeriod: vi.fn(), readChannelMessages: vi.fn(),
}));
vi.mock("./syncChannels", () => ({ syncAllChannels }));
vi.mock("./computeVerdicts", () => ({ computeVerdicts }));
vi.mock("./refreshPublished", () => ({ refreshPublishedDays }));
vi.mock("./reports", async (orig) => ({ ...(await (orig as () => Promise<Record<string, unknown>>)()), readReportJson }));
vi.mock("./vimeo", () => ({ fetchVideosInPeriod }));
vi.mock("./slackMirror", () => ({ readChannelMessages }));

import { verifyEvidence } from "./evidenceVerify";

const period = { start: "2026-09-01", end: "2026-09-30" };
const noHints = { vimeoLinks: [], datasetPermalinks: [], timeRanges: [], minuteFigures: [] };
const row = (status: string, videoMinutes: number) => ({
  date: "2026-09-01", reportTs: "1.1", reportSeq: 1, reportCount: 1, status, airborneMinutes: 120, videoMinutes, ratio: videoMinutes / 120,
  datasetStatus: "POSTED", withinGrace: false, reasons: [], roster: ["Тарас"], unknownInitials: [], airborneReported: true, deployMin: 300,
});

beforeEach(() => {
  syncAllChannels.mockReset().mockResolvedValue({});
  refreshPublishedDays.mockReset().mockResolvedValue({ refreshed: [], skipped: [] });
  readReportJson.mockReset().mockResolvedValue({ days: [row("NEEDS_REVIEW", 48)] });
  computeVerdicts.mockReset().mockResolvedValue({ days: [row("ACCEPTED", 96)] });
  fetchVideosInPeriod.mockReset().mockResolvedValue([]);
  readChannelMessages.mockReset().mockResolvedValue([]);
});

describe("verifyEvidence", () => {
  it("syncs #datasets, recomputes with write, refreshes ONLY that day's rows, and reports before→after", async () => {
    const r = await verifyEvidence({ date: "2026-09-01", reportTs: "1.1", period, hints: noHints, byName: "Тарас", trigger: "webhook" });
    expect(syncAllChannels).toHaveBeenCalledWith(expect.objectContaining({ mode: "incremental", channels: [expect.objectContaining({ name: "datasets" })] }));
    expect(computeVerdicts).toHaveBeenCalledWith(period, expect.objectContaining({ write: true }));
    const [days] = refreshPublishedDays.mock.calls[0];
    expect(days.map((d: { date: string }) => d.date)).toEqual(["2026-09-01"]);
    expect(r).toMatchObject({ outcome: "closed", statusBefore: "NEEDS_REVIEW", statusAfter: "ACCEPTED" });
    expect(fetchVideosInPeriod).not.toHaveBeenCalled(); // no vimeo hints → no second fetch
  });
  it("fetches Vimeo only when a vimeo link was quoted, and resolves it by id", async () => {
    computeVerdicts.mockResolvedValue({ days: [row("NEEDS_REVIEW", 48)] });
    fetchVideosInPeriod.mockResolvedValue([{ name: "DJI_0001", created_time: "2026-09-03T10:00:00Z", link: "https://vimeo.com/123456789", duration: 60, description: null, pictures: { sizes: [] } }]);
    const r = await verifyEvidence({ date: "2026-09-01", reportTs: "1.1", period, hints: { ...noHints, vimeoLinks: [{ url: "https://vimeo.com/123456789", id: "123456789" }] }, byName: "Тарас", trigger: "webhook" });
    expect(r.outcome).toBe("still_open");
    expect(r.text).toContain("DJI_0001");
  });
  it("statusBefore is null when there was no committed report", async () => {
    readReportJson.mockResolvedValue(null);
    const r = await verifyEvidence({ date: "2026-09-01", reportTs: "1.1", period, hints: noHints, byName: "Тарас", trigger: "cli" });
    expect(r.statusBefore).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `lib/evidenceVerify.ts`**

```ts
/**
 * Verification stage (pilot evidence autonomy, spec §4): the ONLY path that can
 * accept a day without a human, and it does so purely by re-running the live
 * verdict (sync #datasets → computeVerdicts → refreshPublishedDays). No new
 * decision logic. SERVER-ONLY (Vimeo + Slack + DB).
 */
import "server-only";
import { syncAllChannels } from "./syncChannels";
import { computeVerdicts } from "./computeVerdicts";
import { refreshPublishedDays } from "./refreshPublished";
import { readReportJson, periodKey } from "./reports";
import { fetchVideosInPeriod } from "./vimeo";
import { readChannelMessages } from "./slackMirror";
import { TRACKED_CHANNELS } from "./slackChannels";
import { reportKey, type DayVerdict } from "./fieldDayVerdict";
import { evidenceOutcome, type EvidenceOutcomeKind, type LinkedVideo } from "./evidenceOutcome";
import type { ReplyHints } from "./threadReplyHints";
import type { SendTrigger } from "./outboundKeys";
import type { Period } from "./period";

export interface VerifyArgs {
  date: string;
  reportTs: string | null;
  period: Period;
  hints: ReplyHints;
  byName: string;
  trigger: SendTrigger;
  onLog?: (m: string) => void;
}
export interface VerifyResult {
  outcome: EvidenceOutcomeKind;
  text: string;
  verifyLine: string;
  statusBefore: string | null;
  statusAfter: string | null;
}

const findRow = (days: DayVerdict[] | undefined, date: string, reportTs: string | null): DayVerdict | null =>
  days?.find((d) => reportKey(d.date, d.reportTs) === reportKey(date, reportTs)) ??
  days?.find((d) => d.date === date) ?? null;

export async function verifyEvidence(a: VerifyArgs): Promise<VerifyResult> {
  const log = a.onLog ?? (() => {});
  const before = findRow((await readReportJson<{ days: DayVerdict[] }>("field-verdict", periodKey(a.period)))?.days, a.date, a.reportTs);

  const datasets = TRACKED_CHANNELS.find((c) => c.name === "datasets");
  if (datasets) await syncAllChannels({ mode: "incremental", window: 7, channels: [datasets], onLog: log });

  const report = await computeVerdicts(a.period, { write: true, onLog: log });
  const dayRows = report.days.filter((d) => d.date === a.date);
  await refreshPublishedDays(dayRows, a.period, { trigger: a.trigger, onLog: log });
  const after = findRow(dayRows, a.date, a.reportTs);

  const linkedVideos: LinkedVideo[] = [];
  if (a.hints.vimeoLinks.length) {
    const videos = await fetchVideosInPeriod(a.period.start, a.period.end);
    for (const l of a.hints.vimeoLinks) {
      const v = videos.find((x) => x.link.includes(`/${l.id}`));
      if (v) linkedVideos.push({ id: l.id, name: v.name, created_time: v.created_time, link: v.link });
    }
  }
  const datasetLinkDates = new Map<string, string>();
  if (a.hints.datasetPermalinks.length) {
    const msgs = await readChannelMessages("datasets", a.period);
    for (const p of a.hints.datasetPermalinks) {
      const m = msgs.find((x) => x.ts === p.ts);
      if (m) datasetLinkDates.set(p.ts, m.isoTime.slice(0, 10));
    }
  }

  const res = evidenceOutcome({ day: after, byName: a.byName, hints: a.hints, linkedVideos, datasetLinkDates });
  return { ...res, statusBefore: before?.status ?? null, statusAfter: after?.status ?? null };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run lib/evidenceVerify.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/evidenceVerify.ts lib/evidenceVerify.test.ts
git commit -m "evidence: verifyEvidence — sync #datasets, live recompute, refresh the day, deterministic outcome

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Refactor `applyInstructionReply` — classified entry point + confirmer-as-`by`

**Files:**
- Modify: `lib/applyInstructionReply.ts`
- Modify: `lib/applyInstructionReply.test.ts` (add 2 tests)

**Interfaces:**
- Produces:
```ts
export interface ClassifiedInstructionArgs extends Omit<InstructionReplyArgs, "replyText"> {
  classification: InstructionClassification; // intent confirm|cancel|instruction
  pending: Proposal[];
  /** Who raised a NEW proposal from this reply; default "approver". */
  origin?: ProposalOrigin;
}
export async function applyClassifiedInstruction(args: ClassifiedInstructionArgs): Promise<InstructionReplyResult>
```
`applyInstructionReply(args)` stays: reads pending, classifies via `classifyInstruction`, then calls `applyClassifiedInstruction`.

- [ ] **Step 1: Failing tests (append)**

```ts
import { applyClassifiedInstruction } from "./applyInstructionReply";

describe("applyClassifiedInstruction — pilot-origin proposals", () => {
  it("records the CONFIRMER as `by` when the pending proposal is pilot-origin", async () => {
    const pilotProposal = { ...activeProposal, origin: "pilot" as const, proposedBy: "Тарас", axis: "day" as const, payload: { intent: "instruction", axis: "day", decision: "accepted_exception", reason: "дощ" } };
    settleProposal.mockResolvedValue("CONFIRMED");
    const res = await applyClassifiedInstruction({
      entry: entry("2.0"), period, approverName: "Bohdan Forostianyi", replyPermalink: "p", replyTs: "1781000300.000100",
      classification: { intent: "confirm", reason: "" }, pending: [pilotProposal],
    });
    expect(res.handled).toBe("confirmed");
    expect(applyInstruction).toHaveBeenCalledWith(expect.objectContaining({ by: "Bohdan Forostianyi" }));
  });
  it("keeps the proposer as `by` for an approver-origin proposal", async () => {
    settleProposal.mockResolvedValue("CONFIRMED");
    await applyClassifiedInstruction({
      entry: entry("2.0"), period, approverName: "Bohdan Forostianyi", replyPermalink: "p", replyTs: "1781000300.000100",
      classification: { intent: "confirm", reason: "" }, pending: [{ ...activeProposal, origin: "approver" as const }],
    });
    expect(applyInstruction).toHaveBeenCalledWith(expect.objectContaining({ by: "Oleksandr K" }));
  });
});
```
Also add `origin: "approver" as const` to the existing `activeProposal` fixture (type now requires it).

- [ ] **Step 2: Run — expect FAIL** (`applyClassifiedInstruction` not exported)

- [ ] **Step 3: Refactor `lib/applyInstructionReply.ts`**

Replace the body so that:

```ts
import type { Proposal, ProposalOrigin } from "./proposals";

export interface ClassifiedInstructionArgs extends Omit<InstructionReplyArgs, "replyText"> {
  classification: InstructionClassification;
  pending: Proposal[];
  origin?: ProposalOrigin;
}

export async function applyInstructionReply(args: InstructionReplyArgs): Promise<InstructionReplyResult> {
  const pending = await readActiveProposals(args.entry.ts);
  const pendingEcho = pending.length ? pending.map((p) => p.summaryUk).join("; ") : null;
  const c = await classifyInstruction(args.entry.text, args.replyText, pendingEcho);
  return applyClassifiedInstruction({ ...args, classification: c, pending });
}

export async function applyClassifiedInstruction(args: ClassifiedInstructionArgs): Promise<InstructionReplyResult> {
  const { entry, period, approverName, replyPermalink, replyTs, trigger = "webhook", classification: c, pending, origin = "approver" } = args;
  const channel = TRACKED_CHANNELS.find((ch) => ch.name === entry.channel);
  // ...existing confirm / cancel / instruction branches, unchanged EXCEPT:
  //   confirm branch:  by: p.origin === "pilot" ? approverName : p.proposedBy,
  //   instruction branch createProposal({ ..., proposedBy: approverName, origin, sourceReplyTs: replyTs })
}
```
Keep every existing key, text and salt exactly as they are today (the branches move verbatim into `applyClassifiedInstruction`).

- [ ] **Step 4: Run — expect PASS (whole file)**

Run: `npx vitest run lib/applyInstructionReply.test.ts && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add lib/applyInstructionReply.ts lib/applyInstructionReply.test.ts
git commit -m "instructions: split applyClassifiedInstruction; confirmer is `by` for pilot-origin proposals

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `applyThreadReply` — the handler

**Files:**
- Create: `lib/applyThreadReply.ts`, `lib/applyThreadReply.test.ts`

**Interfaces:**
- Consumes: `classifyThreadReply` (T3), `decideThreadReply`, `publishedStatusHint` (T4), `extractHints` (T2), `claimToInstruction`, `askClaimToInstruction`, `renderEscalationEcho` (T5), `applyClassifiedInstruction` (T8), `createProposal`, `readActiveProposals` (`lib/proposals.ts`), `renderProposalSummary`, `recordEvidenceEvent` (T1), `postMessage`, `instructionAckKey`, `reportKey`, `TRACKED_CHANNELS`, `AskRecord`, `PublishedEntry`.
- Produces:
```ts
export type ReplyTarget =
  | { kind: "verdict"; entry: PublishedEntry; period: Period }
  | { kind: "ask"; record: AskRecord; period: Period };
export interface ThreadReplyArgs {
  target: ReplyTarget; replyText: string; userId: string; userName: string; role: ReplyRole;
  replyTs: string; replyPermalink: string; trigger?: SendTrigger;
}
export interface DeferredWork {
  kind: "verify" | "chat"; target: ReplyTarget; replyText: string; userId: string; userName: string; role: ReplyRole;
  replyTs: string; replyPermalink: string; hints: ReplyHints; claim?: ClaimItem; trigger: SendTrigger;
}
export type ThreadReplyResult =
  | { handled: "confirmed" | "cancelled" | "proposed" | "escalated" | "silent"; intent: string; applied?: boolean; failed?: string[] }
  | { handled: "deferred"; work: DeferredWork };
export function targetEntry(t: ReplyTarget): PublishedEntry   // ask → synthetic entry (ts = askedTs, channel = ask channel)
export async function applyThreadReply(a: ThreadReplyArgs): Promise<ThreadReplyResult>
export async function escalateClaim(a: { target: ReplyTarget; claim: ClaimItem; userName: string; userId: string; role: ReplyRole; replyTs: string; trigger: SendTrigger; verifyLine?: string; statusBefore?: string | null; statusAfter?: string | null }): Promise<{ created: boolean; proposalId: string | null }>
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  postMessage: vi.fn(), classifyThreadReply: vi.fn(), createProposal: vi.fn(), readActiveProposals: vi.fn(),
  applyClassifiedInstruction: vi.fn(), recordEvidenceEvent: vi.fn(),
}));
vi.mock("./slack", () => ({ postMessage: m.postMessage }));
vi.mock("./instructionClassify", () => ({ classifyThreadReply: m.classifyThreadReply }));
vi.mock("./proposals", () => ({ createProposal: m.createProposal, readActiveProposals: m.readActiveProposals }));
vi.mock("./applyInstructionReply", () => ({ applyClassifiedInstruction: m.applyClassifiedInstruction }));
vi.mock("./evidenceEvents", () => ({ recordEvidenceEvent: m.recordEvidenceEvent }));

import { applyThreadReply, targetEntry, type ReplyTarget } from "./applyThreadReply";

const period = { start: "2026-09-01", end: "2026-09-30" };
const verdict: ReplyTarget = {
  kind: "verdict", period,
  entry: { date: "2026-09-01", reportTs: "1.1", channel: "field-qa", text: "⚠️ 2026-09-01 (понеділок) — потрібна перевірка: відео 48 хв.\n👥 У полі: Тарас.", postedAt: "x", ts: "1781000000.000100" },
};
const ask: ReplyTarget = {
  kind: "ask", period,
  record: { gapType: "no_dataset", date: "2026-09-01", channel: "datasets", question: "За 2026-09-01 немає датасету…", state: "ASKED", askedTs: "1781000000.000900", askedAt: "x" },
};
const base = { replyText: "", userId: "U_PILOT", userName: "Тарас", role: "pilot" as const, replyTs: "1781000500.000100", replyPermalink: "https://s/p" };
const pendingPilot = { id: "p9", threadTs: verdict.entry.ts, channel: "field-qa", date: "2026-09-01", axis: "day", payload: {}, summaryUk: "прийняти день 2026-09-01 (виняток)", proposedBy: "Тарас", origin: "pilot", sourceReplyTs: "1781000400.000100", state: "PROPOSED", createdAt: "x", resolvedAt: null };

beforeEach(() => {
  m.postMessage.mockReset().mockResolvedValue("1781000600.000100");
  m.readActiveProposals.mockReset().mockResolvedValue([]);
  m.createProposal.mockReset().mockResolvedValue({ created: true, proposal: { ...pendingPilot } });
  m.applyClassifiedInstruction.mockReset().mockResolvedValue({ handled: "confirmed", applied: true, intent: "confirm" });
  m.recordEvidenceEvent.mockReset().mockResolvedValue({ created: true });
  m.classifyThreadReply.mockReset();
});

describe("targetEntry", () => {
  it("builds a synthetic entry for an ask thread (ts = askedTs, channel = ask channel)", () => {
    expect(targetEntry(ask)).toMatchObject({ date: "2026-09-01", reportTs: null, channel: "datasets", ts: "1781000000.000900" });
  });
});

describe("applyThreadReply", () => {
  it("classifies with the role and the extracted hints", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "unclear", reason: "" });
    await applyThreadReply({ ...base, target: verdict, replyText: "https://vimeo.com/123456789" });
    const [, , , role, hints] = m.classifyThreadReply.mock.calls[0];
    expect(role).toBe("pilot");
    expect(hints.vimeoLinks[0].id).toBe("123456789");
  });
  it("pilot «так» with a pending proposal never settles anything and is silent", async () => {
    m.readActiveProposals.mockResolvedValue([pendingPilot]);
    m.classifyThreadReply.mockResolvedValue({ intent: "unclear", reason: "" }); // pilot schema has no confirm
    const r = await applyThreadReply({ ...base, target: verdict, replyText: "так" });
    expect(r.handled).toBe("silent");
    expect(m.applyClassifiedInstruction).not.toHaveBeenCalled();
  });
  it("approver confirm delegates to applyClassifiedInstruction with the pending list", async () => {
    m.readActiveProposals.mockResolvedValue([pendingPilot]);
    m.classifyThreadReply.mockResolvedValue({ intent: "confirm", reason: "" });
    const r = await applyThreadReply({ ...base, target: verdict, userId: "U08G4HZQTTR", userName: "Bohdan Forostianyi", role: "approver", replyText: "так" });
    expect(r.handled).toBe("confirmed");
    expect(m.applyClassifiedInstruction).toHaveBeenCalledWith(expect.objectContaining({ approverName: "Bohdan Forostianyi", pending: [pendingPilot] }));
  });
  it("evidence → deferred verify work carrying hints + claim, no posts yet", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "evidence", evidence: [{ kind: "video", links: ["https://vimeo.com/1"] }], claim: { kind: "explanation", text: "дощ" }, reason: "" });
    const r = await applyThreadReply({ ...base, target: verdict, replyText: "залив https://vimeo.com/123456789, дощ" });
    expect(r.handled).toBe("deferred");
    if (r.handled === "deferred") {
      expect(r.work.kind).toBe("verify");
      expect(r.work.claim?.text).toBe("дощ");
    }
    expect(m.postMessage).not.toHaveBeenCalled();
  });
  it("claim → pilot-origin proposal + echo tagging both approvers, keyed by the reply ts", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "claim", claim: { kind: "explanation", text: "дощ, запис не працював" }, reason: "" });
    const r = await applyThreadReply({ ...base, target: verdict, replyText: "дощ, запис не працював" });
    expect(r.handled).toBe("escalated");
    expect(m.createProposal).toHaveBeenCalledWith(expect.objectContaining({ origin: "pilot", proposedBy: "Тарас", axis: "day", sourceReplyTs: base.replyTs, threadTs: verdict.entry.ts }));
    const [channelId, text, meta, threadTs] = m.postMessage.mock.calls[0];
    expect(channelId).toBe("C08GY2NKF9D");
    expect(text).toContain("<@U08G4EC244X>");
    expect(text).toContain("Пропоную: прийняти день 2026-09-01 (виняток)");
    expect(meta.key).toBe(`instruction-ack:2026-09-01#1.1:escalate:${base.replyTs}`);
    expect(threadTs).toBe(verdict.entry.ts);
    expect(m.recordEvidenceEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "claim", outcome: "escalated", proposalId: "p9" }));
  });
  it("claim in an ask thread maps by gap type and echoes into the ask thread", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "claim", claim: { kind: "explanation", text: "не було датасету" }, reason: "" });
    await applyThreadReply({ ...base, target: ask, replyText: "не було датасету" });
    expect(m.createProposal).toHaveBeenCalledWith(expect.objectContaining({ axis: "dataset", threadTs: "1781000000.000900", channel: "datasets" }));
    expect(m.postMessage.mock.calls[0][3]).toBe("1781000000.000900");
  });
  it("redelivered claim (createProposal created=false) posts nothing", async () => {
    m.createProposal.mockResolvedValue({ created: false, proposal: pendingPilot });
    m.classifyThreadReply.mockResolvedValue({ intent: "claim", claim: { kind: "explanation", text: "дощ" }, reason: "" });
    const r = await applyThreadReply({ ...base, target: verdict, replyText: "дощ" });
    expect(r.handled).toBe("silent");
    expect(m.postMessage).not.toHaveBeenCalled();
  });
  it("claim on an already-accepted verdict is silent", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "claim", claim: { kind: "explanation", text: "дощ" }, reason: "" });
    const r = await applyThreadReply({ ...base, target: { ...verdict, entry: { ...verdict.entry, text: "✅ 2026-09-01 — прийнято" } }, replyText: "дощ" });
    expect(r.handled).toBe("silent");
  });
  it("chat → deferred chat work", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "chat", reason: "" });
    const r = await applyThreadReply({ ...base, target: verdict, replyText: "що ще бракує?" });
    expect(r).toMatchObject({ handled: "deferred", work: { kind: "chat" } });
  });
  it("unclear → silent, no event row (keeps the audit table for actions)", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "unclear", reason: "" });
    const r = await applyThreadReply({ ...base, target: verdict, replyText: "ok" });
    expect(r.handled).toBe("silent");
    expect(m.recordEvidenceEvent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `lib/applyThreadReply.ts`**

```ts
/**
 * THE thread-reply handler (pilot evidence autonomy, spec §3). Any human reply in
 * a published-verdict thread or a bot gap-question thread:
 *   stage 1 (code)   role gate + regex hints
 *   stage 2 (model)  role-narrowed classification (classifyThreadReply)
 *   stage 3 (code)   decideThreadReply → inline effect, or DeferredWork for the
 *                    slow paths (verify / chat) the caller runs off the request.
 * Approver confirm/cancel/instruction reuse applyClassifiedInstruction verbatim.
 * SERVER-ONLY (Claude + Slack + DB).
 */
import "server-only";
import { classifyThreadReply } from "./instructionClassify";
import { decideThreadReply, publishedStatusHint } from "./threadReplyDecide";
import { extractHints, type ReplyHints } from "./threadReplyHints";
import { askClaimToInstruction, claimToInstruction, renderEscalationEcho } from "./claimProposal";
import { applyClassifiedInstruction } from "./applyInstructionReply";
import { createProposal, readActiveProposals } from "./proposals";
import { renderProposalSummary } from "./proposalSummary";
import { recordEvidenceEvent } from "./evidenceEvents";
import { postMessage } from "./slack";
import { instructionAckKey, type SendTrigger } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { reportKey } from "./fieldDayVerdict";
import type { PublishedEntry } from "./published";
import type { AskRecord } from "./asks";
import type { ClaimItem, ReplyRole } from "./instructionClassifyPrompt";
import type { Period } from "./period";

export type ReplyTarget =
  | { kind: "verdict"; entry: PublishedEntry; period: Period }
  | { kind: "ask"; record: AskRecord; period: Period };

export interface ThreadReplyArgs {
  target: ReplyTarget;
  replyText: string;
  userId: string;
  userName: string;
  role: ReplyRole;
  replyTs: string;
  replyPermalink: string;
  trigger?: SendTrigger;
}

export interface DeferredWork {
  kind: "verify" | "chat";
  target: ReplyTarget;
  replyText: string;
  userId: string;
  userName: string;
  role: ReplyRole;
  replyTs: string;
  replyPermalink: string;
  hints: ReplyHints;
  claim?: ClaimItem;
  trigger: SendTrigger;
}

export type ThreadReplyResult =
  | { handled: "confirmed" | "cancelled" | "proposed" | "escalated" | "silent"; intent: string; applied?: boolean; failed?: string[] }
  | { handled: "deferred"; work: DeferredWork };

const DATASETS_ID = TRACKED_CHANNELS.find((c) => c.name === "datasets")?.id ?? "";

/** The thread root as a PublishedEntry — real for a verdict, synthetic for an ask
 *  (the ask's own message is the thread root; dataset/video axes are day-wide). */
export function targetEntry(t: ReplyTarget): PublishedEntry {
  if (t.kind === "verdict") return t.entry;
  return { date: t.record.date, reportTs: null, channel: t.record.channel, text: t.record.question, postedAt: t.record.askedAt, ts: t.record.askedTs };
}

export async function escalateClaim(a: {
  target: ReplyTarget; claim: ClaimItem; userName: string; userId: string; role: ReplyRole; replyTs: string; trigger: SendTrigger;
  verifyLine?: string; statusBefore?: string | null; statusAfter?: string | null;
}): Promise<{ created: boolean; proposalId: string | null }> {
  const entry = targetEntry(a.target);
  const mapped = a.target.kind === "ask" ? askClaimToInstruction(a.target.record.gapType, a.claim, a.userName) : claimToInstruction(a.claim, a.userName);
  const summaryUk = renderProposalSummary(entry.date, mapped.instruction);
  const { created, proposal } = await createProposal({
    threadTs: entry.ts, channel: entry.channel, date: entry.date, axis: mapped.axis, payload: mapped.instruction,
    summaryUk, proposedBy: a.userName, origin: "pilot", sourceReplyTs: a.replyTs,
  });
  if (!created) return { created: false, proposalId: proposal.id };
  const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
  if (channel) {
    await postMessage(
      channel.id,
      renderEscalationEcho({ byName: a.userName, claimText: a.claim.text, summaryUk, verifyLine: a.verifyLine }),
      { key: instructionAckKey(reportKey(entry.date, entry.reportTs), "escalate", a.replyTs), feature: "evidence", channel: channel.name, trigger: a.trigger },
      entry.ts,
    );
  }
  await recordEvidenceEvent({
    threadTs: entry.ts, channel: entry.channel, date: entry.date, reportTs: entry.reportTs, byUserId: a.userId, byName: a.userName, role: a.role,
    kind: "claim", evidence: { claim: a.claim }, outcome: "escalated", statusBefore: a.statusBefore ?? null, statusAfter: a.statusAfter ?? null,
    sourceReplyTs: a.replyTs, proposalId: proposal.id,
  });
  return { created: true, proposalId: proposal.id };
}

export async function applyThreadReply(a: ThreadReplyArgs): Promise<ThreadReplyResult> {
  const trigger = a.trigger ?? "webhook";
  const entry = targetEntry(a.target);
  const pending = await readActiveProposals(entry.ts);
  const pendingEcho = pending.length ? pending.map((p) => p.summaryUk).join("; ") : null;
  const hints = extractHints(a.replyText, DATASETS_ID);
  const c = await classifyThreadReply(entry.text, a.replyText, pendingEcho, a.role, hints);
  const action = decideThreadReply(c, a.role, pending.length > 0, publishedStatusHint(entry.text));

  if (action.type === "confirm" || action.type === "cancel" || action.type === "instruction") {
    // Approver-only by construction (decideThreadReply); the existing path owns echo/apply/acks.
    return applyClassifiedInstruction({
      entry, period: a.target.period, approverName: a.userName, replyPermalink: a.replyPermalink, replyTs: a.replyTs, trigger,
      classification: { ...c, intent: action.type },
      pending,
    });
  }
  if (action.type === "verify" || action.type === "chat") {
    return {
      handled: "deferred",
      work: {
        kind: action.type, target: a.target, replyText: a.replyText, userId: a.userId, userName: a.userName, role: a.role,
        replyTs: a.replyTs, replyPermalink: a.replyPermalink, hints, trigger,
        ...(action.type === "verify" && action.claim ? { claim: action.claim } : {}),
      },
    };
  }
  if (action.type === "escalate") {
    const r = await escalateClaim({ target: a.target, claim: action.claim, userName: a.userName, userId: a.userId, role: a.role, replyTs: a.replyTs, trigger });
    return r.created ? { handled: "escalated", intent: c.intent } : { handled: "silent", intent: c.intent };
  }
  return { handled: "silent", intent: c.intent };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run lib/applyThreadReply.test.ts && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add lib/applyThreadReply.ts lib/applyThreadReply.test.ts
git commit -m "evidence: applyThreadReply — role gate, classify, dispatch; escalate claims as pilot-origin proposals

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: `field_verdict_status` read tool + stateless verdict chat

**Files:**
- Create: `lib/agent/tools/fieldVerdict.ts`, `lib/agent/tools/fieldVerdict.test.ts`
- Create: `lib/agent/verdictChat.ts`, `lib/agent/verdictChat.test.ts`
- Modify: `lib/agent/loop.ts:15-19,108` — import and add `...fieldVerdictTools` to the default tool set

**Interfaces:**
- Consumes: `readReportJson`, `periodKey`, `parsePeriodKey` (`lib/reports.ts`/`lib/period.ts`); `ukrainianGaps` (T6); `permalinkFor`; `runAgent`, `fetchThreadContext`, `markdownToMrkdwn` (`lib/mrkdwn.ts`); `fieldLossTools`.
- Produces:
```ts
export const fieldVerdictTools: Tool[]   // one read tool "field_verdict_status" { date: "YYYY-MM-DD" }
export function renderVerdictStatus(days: DayVerdict[], date: string, fieldQaChannelId: string): string  // pure
export async function runVerdictChat(a: { question: string; verdictText: string; channelId: string; threadTs: string; excludeTs: string[] }): Promise<string>
```

- [ ] **Step 1: Failing tests**

`lib/agent/tools/fieldVerdict.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { renderVerdictStatus } from "./fieldVerdict";
import type { DayVerdict } from "@/lib/fieldDayVerdict";

const d: DayVerdict = {
  date: "2026-09-01", reportTs: "1781000000.000100", reportSeq: 1, reportCount: 1, status: "NEEDS_REVIEW", airborneMinutes: 120, videoMinutes: 48, ratio: 0.4,
  datasetStatus: "MISSING", withinGrace: false, reasons: [], roster: ["Тарас", "Влад"], unknownInitials: [], airborneReported: true, deployMin: 300, deployWindow: { start: "09:00", end: "14:00" },
};

describe("renderVerdictStatus", () => {
  it("renders status, gaps, numbers, crew and a Звіт link per report", () => {
    const t = renderVerdictStatus([d], "2026-09-01", "C08GY2NKF9D");
    expect(t).toContain("NEEDS_REVIEW");
    expect(t).toContain("відео 48 хв");
    expect(t).toContain("немає повідомлення про датасет");
    expect(t).toContain("Тарас, Влад");
    expect(t).toContain("archives/C08GY2NKF9D/p1781000000000100");
  });
  it("says so when the date has no verdict", () => {
    expect(renderVerdictStatus([], "2026-09-02", "C")).toContain("немає вердикту");
  });
});
```

`lib/agent/verdictChat.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const m = vi.hoisted(() => ({ runAgent: vi.fn(), fetchThreadContext: vi.fn() }));
vi.mock("./loop", () => ({ runAgent: m.runAgent }));
vi.mock("./threadContext", () => ({ fetchThreadContext: m.fetchThreadContext }));
import { runVerdictChat } from "./verdictChat";

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "k";
  m.runAgent.mockReset().mockResolvedValue({ kind: "text", text: "**Бракує** 12 хв" });
  m.fetchThreadContext.mockReset().mockResolvedValue("Контекст треду (Slack):\n[Тарас]: залив");
});

describe("runVerdictChat", () => {
  it("runs the loop with READ tools only, no history, verdict + thread as context, and converts markdown", async () => {
    const out = await runVerdictChat({ question: "що бракує?", verdictText: "⚠️ …", channelId: "C1", threadTs: "1.1", excludeTs: ["1.2"] });
    const [text, opts] = m.runAgent.mock.calls[0];
    expect(text).toContain("⚠️ …");
    expect(text).toContain("[Тарас]: залив");
    expect(text).toContain("що бракує?");
    expect(opts.history).toBeUndefined();
    expect((opts.tools as { kind: string; name: string }[]).every((t) => t.kind === "read")).toBe(true);
    expect((opts.tools as { name: string }[]).map((t) => t.name)).toContain("field_verdict_status");
    expect(out).toBe("*Бракує* 12 хв");
  });
  it("degrades to the bare question when the thread fetch fails", async () => {
    m.fetchThreadContext.mockRejectedValue(new Error("boom"));
    await runVerdictChat({ question: "q", verdictText: "v", channelId: "C1", threadTs: "1.1", excludeTs: [] });
    expect(m.runAgent.mock.calls[0][0]).toContain("q");
  });
  it("coalesces an empty answer", async () => {
    m.runAgent.mockResolvedValue({ kind: "text", text: "" });
    expect(await runVerdictChat({ question: "q", verdictText: "v", channelId: "C1", threadTs: "1.1", excludeTs: [] })).toBe("Не маю відповіді на це.");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `lib/agent/tools/fieldVerdict.ts`**

```ts
/**
 * Read tool: the verdict of a flight day (every Звіт of the date) — status,
 * Ukrainian gaps, numbers, crew, links. Backs the verdict-thread chat and the
 * agent CLI («що бракує за 04.09?»). Read-only; never writes.
 */
import { readReportJson } from "@/lib/reports";
import { ukrainianGaps } from "@/lib/verdictPublish";
import { TRACKED_CHANNELS } from "@/lib/slackChannels";
import type { DayVerdict } from "@/lib/fieldDayVerdict";
import type { Tool } from "./types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_QA_ID = TRACKED_CHANNELS.find((c) => c.name === "field-qa")?.id ?? "";

function permalink(channelId: string, ts: string): string {
  return `https://slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
}

export function renderVerdictStatus(days: DayVerdict[], date: string, fieldQaChannelId: string): string {
  const rows = days.filter((d) => d.date === date);
  if (rows.length === 0) return `За ${date} немає вердикту (день не літали або звіт ще не оброблено).`;
  return rows
    .map((d) => {
      const head = rows.length > 1 ? `Виїзд ${d.reportSeq}/${d.reportCount}${d.deployWindow ? ` (${d.deployWindow.start}–${d.deployWindow.end})` : ""}` : `День ${date}`;
      const pct = d.ratio === null ? "—" : `${Math.round(d.ratio * 100)}%`;
      const gaps = ukrainianGaps(d);
      return [
        `${head}: статус ${d.status}.`,
        `Цифри: відео ${d.videoMinutes.toFixed(0)} хв = ${pct} від ${d.airborneMinutes.toFixed(0)} хв у повітрі; датасет: ${d.datasetStatus}; виїзд: ${d.deployMin ?? "невідомо"} хв.`,
        gaps.length ? `Бракує: ${gaps.join("; ")}.` : `Прогалин немає.`,
        `Екіпаж: ${d.roster.join(", ") || "невідомий"}.`,
        d.reportTs ? `Звіт: ${permalink(fieldQaChannelId, d.reportTs)}` : "",
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

export const fieldVerdictTools: Tool[] = [
  {
    name: "field_verdict_status",
    description:
      "The field-day verdict for one date: status (ACCEPTED/PENDING/NEEDS_REVIEW/ACCEPTED_EXCEPTION/REJECTED), what is missing (video %, dataset, deploy window), " +
      "the numbers, the crew and a link to the Звіт. Use for «що бракує за DD.MM», «чому день не прийнято», «який статус». Date is YYYY-MM-DD.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "Flight day YYYY-MM-DD" } }, required: ["date"] },
    kind: "read",
    run: async (args) => {
      const date = typeof args.date === "string" ? args.date.trim() : "";
      if (!DATE_RE.test(date)) return { ok: false, content: `Некоректна дата «${args.date}» — потрібно YYYY-MM-DD.` };
      const report = await readReportJson<{ days: DayVerdict[] }>("field-verdict", date.slice(0, 7));
      return { ok: true, content: renderVerdictStatus(report?.days ?? [], date, FIELD_QA_ID) };
    },
  },
];
```

- [ ] **Step 4: Implement `lib/agent/verdictChat.ts`**

```ts
/**
 * Read-only, STATELESS agent turn for a verdict thread (pilot evidence autonomy,
 * spec §6). No memory rows, no write tools — a chat here can never propose or
 * apply. Context = the verdict text + the live thread transcript. Tests mock ./loop.
 */
import { runAgent } from "./loop";
import { fetchThreadContext } from "./threadContext";
import { fieldVerdictTools } from "./tools/fieldVerdict";
import { fieldLossTools } from "./tools/fieldLoss";
import { markdownToMrkdwn } from "@/lib/mrkdwn";

const MAX_ITERS = 4;

export async function runVerdictChat(a: { question: string; verdictText: string; channelId: string; threadTs: string; excludeTs: string[] }): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on the server.");
  let ctx: string | null = null;
  try {
    ctx = await fetchThreadContext(a.channelId, a.threadTs, a.excludeTs);
  } catch (err) {
    console.error("verdictChat: thread-context fetch failed:", err);
  }
  const text = [
    "Ти відповідаєш у треді вердикту польового дня в Slack. Відповідай коротко, українською, лише фактами з вердикту та інструментів.",
    "Ти НЕ можеш приймати чи змінювати день — якщо просять, поясни: докази (відео/датасет) перевіряю сам, пояснення передаю затверджувачам.",
    "",
    "ВЕРДИКТ:",
    a.verdictText,
    ...(ctx ? ["", ctx] : []),
    "",
    "ПИТАННЯ:",
    a.question,
  ].join("\n");
  const tools = [...fieldVerdictTools, ...fieldLossTools].filter((t) => t.kind === "read");
  const result = await runAgent(text, { tools, maxIters: MAX_ITERS });
  return markdownToMrkdwn(result.text.trim()) || "Не маю відповіді на це.";
}
```

- [ ] **Step 5: Register the tool in `lib/agent/loop.ts`**

Add `import { fieldVerdictTools } from "./tools/fieldVerdict";` and extend the default: `[...jiraTools, ...fieldLossTools, ...calendarTools, ...sprintTools, ...fieldSummaryTools, ...fieldVerdictTools]`.

- [ ] **Step 6: Run — expect PASS**

Run: `npx vitest run lib/agent && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add lib/agent/tools/fieldVerdict.ts lib/agent/tools/fieldVerdict.test.ts lib/agent/verdictChat.ts lib/agent/verdictChat.test.ts lib/agent/loop.ts
git commit -m "agent: field_verdict_status read tool + stateless read-only verdict-thread chat

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: `runDeferredWork` + internal route + webhook wiring

**Files:**
- Create: `lib/threadReplyWork.ts`, `lib/threadReplyWork.test.ts`
- Create: `app/api/field/thread-reply/route.ts`
- Modify: `app/api/slack/events/route.ts` (imports; the `try { const pub = … }` block at ~lines 543-585; add `deferThreadWork`)

**Interfaces:**
- Consumes: `DeferredWork`, `targetEntry`, `escalateClaim` (T9); `verifyEvidence` (T7); `runVerdictChat` (T10); `recordEvidenceEvent` (T1); `postMessage`, `updateMessage`; `chunkForSlack`; `instructionAckKey`; `reportKey`; `TRACKED_CHANNELS`; `personForSlackId`; `approverFor`, `isApprover`; `selfOrigin`; `waitUntil`.
- Produces:
```ts
export const PLACEHOLDER_UK: Record<DeferredWork["kind"], string> = { verify: "🔎 Перевіряю…", chat: "💬 Думаю…" };
export function workPlaceholderKey(work: DeferredWork): string   // instructionAckKey(reportKey, `${kind}-ph`, replyTs)
export async function runDeferredWork(work: DeferredWork, opts: { placeholderTs?: string; onLog?: (m: string) => void }): Promise<{ outcome: string; text: string }>
```

- [ ] **Step 1: Failing tests `lib/threadReplyWork.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const m = vi.hoisted(() => ({ postMessage: vi.fn(), updateMessage: vi.fn(), verifyEvidence: vi.fn(), runVerdictChat: vi.fn(), recordEvidenceEvent: vi.fn(), escalateClaim: vi.fn() }));
vi.mock("./slack", () => ({ postMessage: m.postMessage, updateMessage: m.updateMessage }));
vi.mock("./evidenceVerify", () => ({ verifyEvidence: m.verifyEvidence }));
vi.mock("./agent/verdictChat", () => ({ runVerdictChat: m.runVerdictChat }));
vi.mock("./evidenceEvents", () => ({ recordEvidenceEvent: m.recordEvidenceEvent }));
vi.mock("./applyThreadReply", async (orig) => ({ ...(await (orig as () => Promise<Record<string, unknown>>)()), escalateClaim: m.escalateClaim }));

import { runDeferredWork, workPlaceholderKey } from "./threadReplyWork";
import type { DeferredWork } from "./applyThreadReply";

const period = { start: "2026-09-01", end: "2026-09-30" };
const work = (p: Partial<DeferredWork>): DeferredWork => ({
  kind: "verify", replyText: "залив", userId: "U1", userName: "Тарас", role: "pilot", replyTs: "1781000500.000100", replyPermalink: "p", trigger: "webhook",
  hints: { vimeoLinks: [], datasetPermalinks: [], timeRanges: [], minuteFigures: [] },
  target: { kind: "verdict", period, entry: { date: "2026-09-01", reportTs: "1.1", channel: "field-qa", text: "⚠️ …", postedAt: "x", ts: "1781000000.000100" } },
  ...p,
});

beforeEach(() => {
  m.postMessage.mockReset().mockResolvedValue("1781000700.000100");
  m.updateMessage.mockReset().mockResolvedValue("ph");
  m.verifyEvidence.mockReset().mockResolvedValue({ outcome: "closed", text: "✅ Перевірив…", verifyLine: "l", statusBefore: "NEEDS_REVIEW", statusAfter: "ACCEPTED" });
  m.runVerdictChat.mockReset().mockResolvedValue("Бракує 12 хв");
  m.recordEvidenceEvent.mockReset().mockResolvedValue({ created: true });
  m.escalateClaim.mockReset().mockResolvedValue({ created: true, proposalId: "p1" });
});

describe("workPlaceholderKey", () => {
  it("is report-scoped and salted by the reply ts", () => {
    expect(workPlaceholderKey(work({}))).toBe("instruction-ack:2026-09-01#1.1:verify-ph:1781000500.000100");
  });
});

describe("runDeferredWork — verify", () => {
  it("edits the placeholder with the outcome text and records the event", async () => {
    await runDeferredWork(work({}), { placeholderTs: "ph" });
    expect(m.updateMessage).toHaveBeenCalledWith("C08GY2NKF9D", "ph", "✅ Перевірив…", expect.objectContaining({ key: "instruction-ack:2026-09-01#1.1:verify:1781000500.000100" }));
    expect(m.recordEvidenceEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "evidence", outcome: "closed", statusBefore: "NEEDS_REVIEW", statusAfter: "ACCEPTED" }));
    expect(m.escalateClaim).not.toHaveBeenCalled();
  });
  it("posts into the thread when there is no placeholder (CLI path)", async () => {
    await runDeferredWork(work({}), {});
    expect(m.postMessage).toHaveBeenCalledWith("C08GY2NKF9D", "✅ Перевірив…", expect.anything(), "1781000000.000100");
  });
  it("still_open + claim → escalates with the verify line; closed + claim → no escalation", async () => {
    m.verifyEvidence.mockResolvedValue({ outcome: "still_open", text: "🔎 …", verifyLine: "відео 48 хв = 40%", statusBefore: "NEEDS_REVIEW", statusAfter: "NEEDS_REVIEW" });
    await runDeferredWork(work({ claim: { kind: "explanation", text: "дощ" } }), { placeholderTs: "ph" });
    expect(m.escalateClaim).toHaveBeenCalledWith(expect.objectContaining({ verifyLine: "відео 48 хв = 40%", claim: { kind: "explanation", text: "дощ" } }));
    expect(m.recordEvidenceEvent).not.toHaveBeenCalled(); // the escalation records the row
  });
  it("hard_fail + claim → escalates too (the approver may still accept as an exception)", async () => {
    m.verifyEvidence.mockResolvedValue({ outcome: "hard_fail", text: "⛔ …", verifyLine: "l", statusBefore: "REJECTED", statusAfter: "REJECTED" });
    await runDeferredWork(work({ claim: { kind: "explanation", text: "дощ" } }), { placeholderTs: "ph" });
    expect(m.escalateClaim).toHaveBeenCalled();
  });
});

describe("runDeferredWork — chat", () => {
  it("answers via runVerdictChat with the verdict text, excluding the reply + placeholder, chunked into the placeholder", async () => {
    await runDeferredWork(work({ kind: "chat", replyText: "що бракує?" }), { placeholderTs: "ph" });
    expect(m.runVerdictChat).toHaveBeenCalledWith(expect.objectContaining({ question: "що бракує?", verdictText: "⚠️ …", threadTs: "1781000000.000100", excludeTs: ["1781000500.000100", "ph"] }));
    expect(m.updateMessage).toHaveBeenCalledWith("C08GY2NKF9D", "ph", "Бракує 12 хв", expect.objectContaining({ key: "instruction-ack:2026-09-01#1.1:chat:1781000500.000100" }));
    expect(m.recordEvidenceEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "chat", outcome: "answered" }));
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `lib/threadReplyWork.ts`**

```ts
/**
 * The slow half of the thread-reply handler (pilot evidence autonomy): verify
 * (live recompute) and chat (read-only agent). Runs OFF the webhook request —
 * from /api/field/thread-reply behind a placeholder — or inline from the CLI
 * twin with no placeholder (then it posts into the thread). SERVER-ONLY.
 */
import "server-only";
import { escalateClaim, targetEntry, type DeferredWork } from "./applyThreadReply";
import { verifyEvidence } from "./evidenceVerify";
import { runVerdictChat } from "./agent/verdictChat";
import { recordEvidenceEvent } from "./evidenceEvents";
import { postMessage, updateMessage } from "./slack";
import { chunkForSlack } from "./slackChunk";
import { instructionAckKey } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { reportKey } from "./fieldDayVerdict";

export const PLACEHOLDER_UK: Record<DeferredWork["kind"], string> = { verify: "🔎 Перевіряю…", chat: "💬 Думаю…" };

export function workPlaceholderKey(work: DeferredWork): string {
  const e = targetEntry(work.target);
  return instructionAckKey(reportKey(e.date, e.reportTs), `${work.kind}-ph`, work.replyTs);
}

export async function runDeferredWork(
  work: DeferredWork,
  opts: { placeholderTs?: string; onLog?: (m: string) => void },
): Promise<{ outcome: string; text: string }> {
  const entry = targetEntry(work.target);
  const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
  if (!channel) throw new Error(`thread-reply work: untracked channel "${entry.channel}"`);
  const meta = { key: instructionAckKey(reportKey(entry.date, entry.reportTs), work.kind, work.replyTs), feature: "evidence", channel: channel.name, trigger: work.trigger };

  /** Edit the placeholder (or post) with the first chunk; overflow threads under the root. */
  const deliver = async (text: string): Promise<void> => {
    const chunks = chunkForSlack(text);
    if (opts.placeholderTs) {
      const ts = await updateMessage(channel.id, opts.placeholderTs, chunks[0], meta);
      if (!ts) throw new Error("thread-reply work: placeholder edit was skipped (stuck pending row)");
    } else {
      await postMessage(channel.id, chunks[0], meta, entry.ts);
    }
    for (let i = 1; i < chunks.length; i++) await postMessage(channel.id, chunks[i], { ...meta, key: `${meta.key}:${i + 1}` }, entry.ts);
  };

  if (work.kind === "verify") {
    const r = await verifyEvidence({ date: entry.date, reportTs: entry.reportTs, period: work.target.period, hints: work.hints, byName: work.userName, trigger: work.trigger, onLog: opts.onLog });
    await deliver(r.text);
    if (r.outcome !== "closed" && work.claim) {
      await escalateClaim({
        target: work.target, claim: work.claim, userName: work.userName, userId: work.userId, role: work.role, replyTs: work.replyTs, trigger: work.trigger,
        verifyLine: r.verifyLine, statusBefore: r.statusBefore, statusAfter: r.statusAfter,
      });
    } else {
      await recordEvidenceEvent({
        threadTs: entry.ts, channel: entry.channel, date: entry.date, reportTs: entry.reportTs, byUserId: work.userId, byName: work.userName, role: work.role,
        kind: "evidence", evidence: { hints: work.hints, claim: work.claim ?? null }, outcome: r.outcome, statusBefore: r.statusBefore, statusAfter: r.statusAfter,
        sourceReplyTs: work.replyTs, proposalId: null,
      });
    }
    return { outcome: r.outcome, text: r.text };
  }

  const answer = await runVerdictChat({
    question: work.replyText, verdictText: entry.text, channelId: channel.id, threadTs: entry.ts,
    excludeTs: [work.replyTs, ...(opts.placeholderTs ? [opts.placeholderTs] : [])],
  });
  await deliver(answer);
  await recordEvidenceEvent({
    threadTs: entry.ts, channel: entry.channel, date: entry.date, reportTs: entry.reportTs, byUserId: work.userId, byName: work.userName, role: work.role,
    kind: "chat", evidence: null, outcome: "answered", statusBefore: null, statusAfter: null, sourceReplyTs: work.replyTs, proposalId: null,
  });
  return { outcome: "answered", text: answer };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run lib/threadReplyWork.test.ts`

- [ ] **Step 5: Create `app/api/field/thread-reply/route.ts`**

```ts
/**
 * Internal deferred runner for verdict/ask thread replies (pilot evidence
 * autonomy). NOT called by Slack — fire-and-forget from the events webhook,
 * authed by AGENT_RUN_SECRET (same contract as /api/agent/run). Runs the slow
 * work (live recompute / read-only chat) and edits the placeholder. SERVER-ONLY.
 */
import { runDeferredWork } from "@/lib/threadReplyWork";
import { targetEntry, type DeferredWork } from "@/lib/applyThreadReply";
import { updateMessage } from "@/lib/slack";
import { instructionAckKey } from "@/lib/outboundKeys";
import { TRACKED_CHANNELS } from "@/lib/slackChannels";
import { reportKey } from "@/lib/fieldDayVerdict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Body { work: DeferredWork; placeholderTs: string }

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.AGENT_RUN_SECRET;
  if (!secret || req.headers.get("x-agent-secret") !== secret) return new Response("unauthorized", { status: 401 });
  const { work, placeholderTs } = (await req.json()) as Body;
  try {
    const r = await runDeferredWork(work, { placeholderTs });
    return Response.json({ ok: true, outcome: r.outcome });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("thread-reply work failed:", err);
    const entry = targetEntry(work);
    const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
    const uk = work.kind === "verify"
      ? `❌ Не вдалося перевірити: ${message}. Спробуйте пізніше або напишіть затверджувачам.`
      : "Сталася помилка під час обробки запиту.";
    if (channel) {
      try {
        await updateMessage(channel.id, placeholderTs, uk, {
          key: instructionAckKey(reportKey(entry.date, entry.reportTs), `${work.kind}-failed`, work.replyTs), feature: "evidence", channel: channel.name, trigger: work.trigger,
        });
      } catch (editErr) {
        console.error("thread-reply work: placeholder edit failed:", editErr);
      }
    }
    return Response.json({ ok: true, error: message });
  }
}
```
Note: `targetEntry(work)` above must be `targetEntry(work.target)`.

- [ ] **Step 6: Wire the webhook (`app/api/slack/events/route.ts`)**

Imports: remove `applyInstructionReply` and `applyAnswerReply`; add
```ts
import { applyThreadReply, type DeferredWork, type ReplyTarget } from "@/lib/applyThreadReply";
import { PLACEHOLDER_UK, workPlaceholderKey } from "@/lib/threadReplyWork";
import { personForSlackId } from "@/lib/people";
```

Add next to `deferAgentTurn`:
```ts
/** Post the placeholder for slow thread work and fire /api/field/thread-reply (same waitUntil pattern as deferAgentTurn). */
async function deferThreadWork(req: Request, channelId: string, channelName: string, threadTs: string, work: DeferredWork): Promise<Response> {
  let placeholderTs: string;
  try {
    placeholderTs = await postMessage(channelId, PLACEHOLDER_UK[work.kind], { key: workPlaceholderKey(work), feature: "evidence", channel: channelName, trigger: "webhook" }, threadTs);
  } catch (err) {
    console.error("slack events: thread-work placeholder post failed:", err);
    return ack({ handled: work.kind, error: "placeholder-failed" });
  }
  if (!placeholderTs) return ack({ handled: work.kind, skipped: "placeholder-deduped" }); // redelivery: the first delivery already fired the work
  const secret = process.env.AGENT_RUN_SECRET;
  if (secret) {
    waitUntil(
      fetch(`${selfOrigin(req)}/api/field/thread-reply`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-secret": secret },
        body: JSON.stringify({ work, placeholderTs }),
      })
        .then((res) => console[res.ok && !res.redirected ? "log" : "error"](`slack events: thread-work self-invoke → ${res.status}`))
        .catch((err) => console.error("slack events: thread-work self-invoke failed:", err)),
    );
  } else {
    console.error("slack events: AGENT_RUN_SECRET not set — cannot dispatch thread work");
  }
  return ack({ handled: work.kind, deferred: true });
}
```

Replace the block from `// S7 (confirm-first): …` through the `ask` branch (the `const pub = …` … `if (ask) { … }` section) with:

```ts
    // Any human reply under a published verdict or a bot gap question → the
    // unified thread-reply handler (pilot evidence autonomy, 2026-09-04):
    // approvers keep confirm/cancel/instruction; everyone can submit evidence
    // (re-checked live), a claim (escalated to approvers) or ask a question.
    const pub = await findPublishedByTs(threadTs);
    const ask = pub ? null : await findAskByTs(threadTs);
    if (pub || ask) {
      const target: ReplyTarget = pub
        ? { kind: "verdict", entry: pub.entry, period: pub.period }
        : { kind: "ask", record: ask!.record, period: ask!.period };
      const role = isApprover(userId) ? "approver" : "pilot";
      const userName = approverFor(userId)?.name ?? personForSlackId(userId)?.name ?? `<@${userId}>`;
      const date = pub ? pub.entry.date : ask!.record.date;
      console.log(`slack events: thread reply on ${date} by ${userId} (${role})`);
      try {
        const result = await applyThreadReply({ target, replyText, userId, userName, role, replyTs, replyPermalink, trigger: "webhook" });
        if (result.handled === "deferred") return await deferThreadWork(req, channel.id, channel.name, threadTs, result.work);
        console.log(`slack events: applyThreadReply → handled=${result.handled} intent=${result.intent}`);
        return ack({ date, ...result });
      } catch (err) {
        return await failVisibly(channel, threadTs, "thread-reply", date, err);
      }
    }
```
Update the file header comment's routing lines to describe the new rule. Also update the `mention` branch comment: unchanged behaviour (a mention inside a verdict/ask thread is still deferred to this handler via the sibling `message` event).

- [ ] **Step 7: Typecheck, lint, existing route tests**

Run: `npx tsc --noEmit && npm run lint && npx vitest run app lib/slackEventParse.test.ts`

- [ ] **Step 8: Commit**

```bash
git add lib/threadReplyWork.ts lib/threadReplyWork.test.ts app/api/field/thread-reply/route.ts app/api/slack/events/route.ts
git commit -m "evidence: deferred verify/chat runner + internal route; webhook routes every verdict/ask thread reply through applyThreadReply

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Gap-question flow alignment (`applyAnswer`, `field-remember`)

**Files:**
- Modify: `scripts/fieldRememberReport.ts` (`Outcome`, `decideOutcome`), `scripts/fieldRememberReport.test.ts`
- Modify: `lib/applyAnswer.ts` (remove `applyAnswerReply` + `upsertResolution`; escalate instead)
- Modify: `scripts/field-remember.ts` (print/apply the new outcome)

**Interfaces:**
- Produces:
```ts
export interface Outcome { state: AskState; escalate: boolean; note: string; evidencePermalink: string; claimText?: string }
export function decideOutcome(replies: ClassifiedReply[]): Outcome | null
```
`applyAnswerDecision(args)`: when `outcome.escalate`, calls `escalateClaim` (T9) with `target: { kind: "ask", record, period }`, `claim: { kind: "explanation", text: outcome.claimText }`, `userName` = reply author's roster name (or "команда"), `replyTs` = the deciding reply's ts. Signature gains `{ replyTs: string; userId: string; userName: string }`.

- [ ] **Step 1: Failing tests (edit `scripts/fieldRememberReport.test.ts`)**

Replace assertions on `writeException` with:
```ts
it("an accepted_exception explanation ESCALATES instead of writing an exception", () => {
  const o = decideOutcome([{ classification: { resolved: true, type: "accepted_exception", note: "дощ" }, permalink: "p" }]);
  expect(o).toMatchObject({ state: "ESCALATED", escalate: true, claimText: "дощ" });
});
it("data_provided → ANSWERED (the nightly recompute verifies), no escalation", () => {
  const o = decideOutcome([{ classification: { resolved: true, type: "data_provided", note: "залив" }, permalink: "p" }]);
  expect(o).toMatchObject({ state: "ANSWERED", escalate: false });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Change `decideOutcome`**

```ts
export interface Outcome {
  state: AskState;
  /** Create a pilot-origin proposal for approvers (never write a resolution directly). */
  escalate: boolean;
  note: string;
  evidencePermalink: string;
  claimText?: string;
}

export function decideOutcome(replies: ClassifiedReply[]): Outcome | null {
  if (replies.length === 0) return null;
  const exception = replies.find((r) => r.classification.type === "accepted_exception");
  if (exception) {
    return { state: "ESCALATED", escalate: true, note: exception.classification.note, evidencePermalink: exception.permalink, claimText: exception.classification.note };
  }
  const provided = replies.find((r) => r.classification.type === "data_provided");
  if (provided) return { state: "ANSWERED", escalate: false, note: `дані надано — перевірка при наступному розрахунку: ${provided.classification.note}`, evidencePermalink: provided.permalink };
  const last = replies[replies.length - 1];
  return { state: "ANSWERED", escalate: false, note: last.classification.note, evidencePermalink: last.permalink };
}
```
(`AskState` already includes `"ESCALATED"`.)

- [ ] **Step 4: Rewrite `lib/applyAnswer.ts`**

```ts
/**
 * S6 effect, aligned with pilot evidence autonomy (2026-09-04): a reply to one
 * of the bot's gap questions never writes an exception on its own. An
 * explanation becomes a pilot-origin proposal for the approvers (escalateClaim);
 * provided data is left to the live recompute. Called by the `field-remember`
 * CLI (batch). The webhook path goes through lib/applyThreadReply directly.
 */
import "server-only";
import { setAskState, writeAsks, type AskRecord } from "./asks";
import { escalateClaim } from "./applyThreadReply";
import type { Period } from "./period";
import type { Outcome } from "../scripts/fieldRememberReport";

export interface AnswerDecisionArgs {
  record: AskRecord;
  period: Period;
  outcome: Outcome;
  /** The deciding reply (for the proposal's sourceReplyTs + attribution). */
  replyTs: string;
  userId: string;
  userName: string;
  trigger?: "cli" | "webhook";
}

export async function applyAnswerDecision(a: AnswerDecisionArgs): Promise<void> {
  if (a.outcome.escalate && a.outcome.claimText) {
    await escalateClaim({
      target: { kind: "ask", record: a.record, period: a.period }, claim: { kind: "explanation", text: a.outcome.claimText },
      userName: a.userName, userId: a.userId, role: "pilot", replyTs: a.replyTs, trigger: a.trigger ?? "cli",
    });
  }
  const key = `${a.record.gapType}:${a.record.date}`;
  await writeAsks(a.period, setAskState({ [key]: a.record }, key, a.outcome.state, a.outcome.note));
}
```

- [ ] **Step 5: Update `scripts/field-remember.ts`**

Where it builds `ClassifiedReply[]` it already has each mirrored reply (`ts`, `authorId`, `author`). Pass the deciding reply's identity: find the reply whose `permalink === outcome.evidencePermalink`, then call
```ts
await applyAnswerDecision({ record, period, outcome, replyTs: deciding.ts, userId: deciding.authorId, userName: personForSlackId(deciding.authorId)?.name ?? deciding.author, trigger: "cli" });
```
Dry-run line: `• ${record.date} ${record.gapType} ⇒ ${outcome.escalate ? "would ESCALATE to approvers (pilot-origin proposal)" : `state → ${outcome.state}`}: ${outcome.note}`. Update the header doc comment (no more "written to the resolutions store").

- [ ] **Step 6: Run**

Run: `npx vitest run scripts/fieldRememberReport.test.ts && npx tsc --noEmit && grep -rn "applyAnswerReply" app lib scripts` → the grep must print nothing.

- [ ] **Step 7: Commit**

```bash
git add scripts/fieldRememberReport.ts scripts/fieldRememberReport.test.ts lib/applyAnswer.ts scripts/field-remember.ts
git commit -m "field-remember: explanations escalate as pilot-origin proposals; no direct exceptions from team replies

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: CLI twin `npm run field-evidence`

**Files:**
- Create: `scripts/fieldEvidenceReport.ts` (pure), `scripts/fieldEvidenceReport.test.ts`, `scripts/field-evidence.ts`
- Modify: `package.json` scripts

**Interfaces:**
- Produces (pure):
```ts
export interface EvidenceArgs { thread?: string; reply?: string; as?: string; write: boolean; list: boolean; start?: string; end?: string }
export function parseArgs(argv: string[]): EvidenceArgs
export function resolveActor(as: string | undefined): { userId: string; userName: string; role: "approver" | "pilot" }  // default: pilot "Тарас"-style stub "U_CLI" / "оператор"
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { parseArgs, resolveActor } from "./fieldEvidenceReport";

describe("field-evidence args", () => {
  it("parses thread/reply/as/write", () => {
    expect(parseArgs(["--thread", "C1:1.1", "--reply", "залив", "--as", "U08G4EC244X", "--write"])).toMatchObject({ thread: "C1:1.1", reply: "залив", as: "U08G4EC244X", write: true, list: false });
  });
  it("parses --list with a window", () => {
    expect(parseArgs(["--list", "--start", "2026-09-01", "--end", "2026-09-30"])).toMatchObject({ list: true, start: "2026-09-01", end: "2026-09-30" });
  });
});

describe("resolveActor", () => {
  it("an approver user id → approver role + name", () => {
    expect(resolveActor("U08G4EC244X")).toEqual({ userId: "U08G4EC244X", userName: "Oleksandr K", role: "approver" });
  });
  it("a roster name → pilot with that name", () => {
    expect(resolveActor("Тарас Панасюк").role).toBe("pilot");
  });
  it("absent → a pilot stub", () => {
    expect(resolveActor(undefined)).toMatchObject({ role: "pilot" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `scripts/fieldEvidenceReport.ts`**

```ts
/** Pure CLI shaping for `field-evidence`. No server/Next imports; unit-tested. */
import { approverFor } from "../lib/approvers";
import { personByQuery, personForSlackId } from "../lib/people";

export interface EvidenceArgs { thread?: string; reply?: string; as?: string; write: boolean; list: boolean; start?: string; end?: string }

export function parseArgs(argv: string[]): EvidenceArgs {
  const a: EvidenceArgs = { write: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i], v = argv[i + 1];
    if (f === "--thread") { a.thread = v; i += 1; }
    else if (f === "--reply") { a.reply = v; i += 1; }
    else if (f === "--as") { a.as = v; i += 1; }
    else if (f === "--start") { a.start = v; i += 1; }
    else if (f === "--end") { a.end = v; i += 1; }
    else if (f === "--write") a.write = true;
    else if (f === "--list") a.list = true;
  }
  return a;
}

export function resolveActor(as: string | undefined): { userId: string; userName: string; role: "approver" | "pilot" } {
  if (!as) return { userId: "U_CLI", userName: "оператор (CLI)", role: "pilot" };
  const approver = approverFor(as);
  if (approver) return { userId: as, userName: approver.name, role: "approver" };
  const bySlack = /^U[A-Z0-9]{6,}$/.test(as) ? personForSlackId(as) : undefined;
  if (bySlack) return { userId: as, userName: bySlack.name, role: "pilot" };
  const found = personByQuery(as);
  if ("person" in found && found.person) return { userId: found.person.slackId ?? "U_CLI", userName: found.person.name, role: "pilot" };
  return { userId: "U_CLI", userName: as, role: "pilot" };
}
```
(Check `personByQuery`'s actual return shape in `lib/people.ts:89` and adapt the `"person" in found` branch to it.)

- [ ] **Step 4: Implement `scripts/field-evidence.ts`**

```ts
/**
 * CLI twin of the verdict-thread reply handler (pilot evidence autonomy) —
 * DRY-RUN BY DEFAULT.
 *   npm run field-evidence -- --thread <channelId:ts | permalink> --reply "<text>" [--as <userId|name>]        # classify + decide, print
 *   npm run field-evidence -- --thread … --reply "…" --write                                                  # perform (verify/escalate/chat/apply)
 *   npm run field-evidence -- --list --start YYYY-MM-DD --end YYYY-MM-DD                                      # audit (mirrors GET /api/evidence)
 * Needs ANTHROPIC_API_KEY (+ SLACK_TOKEN, VIMEO_TOKEN, POSTGRES_URL for --write). Runs under --conditions=react-server.
 */
import { parseThreadRef } from "../lib/agent/threadContext";
import { findPublishedByTs } from "../lib/published";
import { findAskByTs } from "../lib/asks";
import { readActiveProposals, readProposalsInWindow } from "../lib/proposals";
import { readEvidenceEventsInWindow } from "../lib/evidenceEvents";
import { classifyThreadReply } from "../lib/instructionClassify";
import { extractHints } from "../lib/threadReplyHints";
import { decideThreadReply, publishedStatusHint } from "../lib/threadReplyDecide";
import { applyThreadReply, targetEntry, type ReplyTarget } from "../lib/applyThreadReply";
import { runDeferredWork } from "../lib/threadReplyWork";
import { computeVerdicts } from "../lib/computeVerdicts";
import { permalinkFor } from "../lib/slack";
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { reportKey } from "../lib/fieldDayVerdict";
import { parseArgs, resolveActor } from "./fieldEvidenceReport";

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    if (!args.start || !args.end) throw new Error("--list needs --start and --end");
    const [events, proposals] = await Promise.all([readEvidenceEventsInWindow(args.start, args.end), readProposalsInWindow(args.start, args.end)]);
    process.stdout.write(JSON.stringify({ period: { start: args.start, end: args.end }, events, pilotProposals: proposals.filter((p) => p.origin === "pilot") }, null, 2) + "\n");
    return;
  }
  if (!args.thread || !args.reply) throw new Error('Usage: --thread <channelId:ts | permalink> --reply "<text>" [--as <userId|name>] [--write]');
  const ref = parseThreadRef(args.thread);
  if (!ref) throw new Error(`--thread: cannot parse "${args.thread}"`);
  const pub = await findPublishedByTs(ref.threadTs);
  const ask = pub ? null : await findAskByTs(ref.threadTs);
  if (!pub && !ask) throw new Error(`thread ${ref.threadTs} is neither a published verdict nor a bot question`);
  const target: ReplyTarget = pub ? { kind: "verdict", entry: pub.entry, period: pub.period } : { kind: "ask", record: ask!.record, period: ask!.period };
  const actor = resolveActor(args.as);
  const entry = targetEntry(target);
  const replyTs = `cli-${Date.now()}`;
  const replyPermalink = permalinkFor(ref.channelId, ref.threadTs);

  if (!args.write) {
    const pending = await readActiveProposals(entry.ts);
    const datasetsId = TRACKED_CHANNELS.find((c) => c.name === "datasets")?.id ?? "";
    const hints = extractHints(args.reply, datasetsId);
    const c = await classifyThreadReply(entry.text, args.reply, pending.length ? pending.map((p) => p.summaryUk).join("; ") : null, actor.role, hints);
    const action = decideThreadReply(c, actor.role, pending.length > 0, publishedStatusHint(entry.text));
    process.stdout.write(JSON.stringify({ target: { kind: target.kind, date: entry.date, reportTs: entry.reportTs, channel: entry.channel }, actor, hints, classification: c, action }, null, 2) + "\n");
    if (action.type === "verify") {
      // Read-only preview of the recompute (no write, no Slack): what the fresh status would be.
      const report = await computeVerdicts(target.period, { onLog: (m) => process.stderr.write(m + "\n") });
      const fresh = report.days.find((d) => reportKey(d.date, d.reportTs) === reportKey(entry.date, entry.reportTs)) ?? report.days.find((d) => d.date === entry.date);
      process.stdout.write(`fresh status (dry-run, not persisted): ${fresh?.status ?? "not found"} — video ${fresh?.videoMinutes ?? "?"} min, dataset ${fresh?.datasetStatus ?? "?"}\n`);
    }
    process.stdout.write("(dry-run — pass --write to perform)\n");
    return;
  }

  const result = await applyThreadReply({ target, replyText: args.reply, userId: actor.userId, userName: actor.userName, role: actor.role, replyTs, replyPermalink, trigger: "cli" });
  if (result.handled === "deferred") {
    const r = await runDeferredWork(result.work, { onLog: (m) => process.stderr.write(m + "\n") });
    process.stdout.write(JSON.stringify({ handled: result.work.kind, ...r }, null, 2) + "\n");
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
}

main().catch((err) => { process.stderr.write(`field-evidence: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });
```

- [ ] **Step 5: Add the npm script** in `package.json` next to `field-instructions`:

```json
    "field-evidence": "node --conditions=react-server --import tsx scripts/field-evidence.ts",
```

- [ ] **Step 6: Run tests + a dry run against a real recent NEEDS_REVIEW thread**

Run: `npx vitest run scripts/fieldEvidenceReport.test.ts && npx tsc --noEmit`
Then: `npm run field-evidence -- --list --start 2026-09-01 --end 2026-09-30` (expect JSON, possibly empty arrays), and with a real verdict permalink from #field-qa: `npm run field-evidence -- --thread <permalink> --reply "що ще бракує?"` → expect `action.type === "chat"`.

- [ ] **Step 7: Commit**

```bash
git add scripts/fieldEvidenceReport.ts scripts/fieldEvidenceReport.test.ts scripts/field-evidence.ts package.json
git commit -m "field-evidence: CLI twin of the thread-reply handler (dry-run, --write, --list)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Web — `GET /api/evidence` + Instructions tab panel

**Files:**
- Create: `app/api/evidence/route.ts`
- Modify: `app/(dashboard)/instructions/page.tsx`

**Interfaces:**
- Consumes: `readEvidenceEventsInWindow` (T1), `readProposalsInWindow` (`origin` from T1), `parsePeriodKey`.
- Produces: `GET /api/evidence?period=<key>` → `{ period, events: EvidenceEvent[], pilotProposals: Proposal[] }`.

- [ ] **Step 1: Create `app/api/evidence/route.ts`**

```ts
import { NextResponse } from "next/server";
import { parsePeriodKey } from "@/lib/period";
import { readEvidenceEventsInWindow } from "@/lib/evidenceEvents";
import { readProposalsInWindow } from "@/lib/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/evidence?period=<key> — pilot evidence events + pilot-origin proposals (DB-backed, like /api/instructions). */
export async function GET(request: Request) {
  const period = new URL(request.url).searchParams.get("period");
  const parsed = period ? parsePeriodKey(period) : null;
  if (!parsed) return NextResponse.json({ error: "Provide `period` (YYYY-MM or YYYY-MM-DD_YYYY-MM-DD)." }, { status: 400 });
  const [events, proposals] = await Promise.all([readEvidenceEventsInWindow(parsed.start, parsed.end), readProposalsInWindow(parsed.start, parsed.end)]);
  return NextResponse.json({ period: parsed, events, pilotProposals: proposals.filter((p) => p.origin === "pilot") });
}
```

- [ ] **Step 2: Extend the Instructions page**

In `app/(dashboard)/instructions/page.tsx`: add `origin?: string` to `Proposal`; add an `EvidenceEvent` interface (fields of T1) and `evidence` state fetched from `/api/evidence?period=…` in the same effect. Render:
- In the existing proposals table, a badge `<span className="ml-1 rounded bg-sky-100 px-1 text-xs text-sky-800">від пілота</span>` when `p.origin === "pilot"`.
- A new section `<h2>Докази від пілотів</h2>` with a table: Дата · Хто (role) · Тип (kind) · Результат (outcome) · Статус до → після · Тред (link `https://slack.com/archives/<channelId>/p<threadTs without dot>`; channel id via a small `CHANNEL_IDS` map copied from `lib/slackChannels.ts` names→ids, or import `TRACKED_CHANNELS` — it is a plain constant module with no server imports).
- Outcome badge classes: `closed` emerald, `still_open` amber, `hard_fail`/`escalated` rose, `answered` slate.

- [ ] **Step 3: Verify in the browser**

Run: `npm run dev` → open http://localhost:3003/instructions → the panel renders (empty state text «Поки немає подій» when no rows). `npm run lint` clean.

- [ ] **Step 4: Commit**

```bash
git add app/api/evidence/route.ts "app/(dashboard)/instructions/page.tsx"
git commit -m "web: GET /api/evidence + «Докази від пілотів» panel and pilot-origin badge on the Instructions tab

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Docs + full verification

**Files:**
- Modify: `CLAUDE.md` (Commands list, after the `field-instructions` entry; amend the `field-remember` and Realtime bullets)

- [ ] **Step 1: Add the CLAUDE.md entry**

```markdown
- `npm run field-evidence -- --thread <channelId:ts | permalink> --reply "<text>" [--as <userId|name>] [--write]` — CLI twin of the **thread-reply handler** (pilot evidence autonomy, 2026-09-04, `lib/applyThreadReply.ts`). Since then ANY human reply under a published verdict (or a bot gap question) is routed: stage 1 code role gate (`lib/approvers.ts` → approver / pilot) + regex hints (`lib/threadReplyHints.ts`: Vimeo links, #datasets permalinks, time ranges, minutes); stage 2 one role-narrowed classifier call (`classifyThreadReply` — pilots can never return confirm/cancel/instruction); stage 3 pure dispatch (`lib/threadReplyDecide.ts`): approver confirm/cancel/instruction → existing path; **evidence** (video on Vimeo / notice in #datasets — the only verifiable kinds) → `lib/evidenceVerify.ts` re-runs #datasets sync + `computeVerdicts` + `refreshPublishedDays` and posts ✅ closed / 🔎 shortfall (with deterministic cause hints, e.g. «відео без дати в назві») / ⛔ hard-fail; **claim** (deploy window, airborne, «борт знайшли», explanations) → a **pilot-origin proposal** (`proposals.origin`) mapped onto an existing axis (`lib/claimProposal.ts`; deploy-window → day/accepted_exception in v1) with an echo tagging both approvers — only approvers confirm, the confirmer is recorded as `by`; **chat** → read-only stateless agent turn (`lib/agent/verdictChat.ts`, key `verdict:<ts>`, no memory, `field_verdict_status` read tool). Slow work (verify/chat) runs behind a placeholder via `POST /api/field/thread-reply` (`AGENT_RUN_SECRET`). Every action is audited in `evidence_events` → `GET /api/evidence` + the «Докази від пілотів» panel on the Instructions tab. **DRY-RUN by default** (classify + decide + a read-only recompute preview); `--write` performs; `--list --start --end` prints the audit. The old S6 auto-exception from a team explanation is gone: `field-remember` now escalates. (See `docs/superpowers/specs/2026-09-04-pilot-evidence-autonomy-design.md`.)
```
Amend the `field-remember` bullet: replace «`--write` records an accepted exception in `reports/resolutions/store.json`» with «`--write` creates a **pilot-origin proposal** for the approvers (never a resolution) — since 2026-09-04». Amend the Realtime bullet: «the Slack events webhook … treats an approver reply in a verdict thread as an instruction» → «treats **any** reply in a verdict/ask thread via `lib/applyThreadReply.ts` (approver instruction / pilot evidence / claim / chat — see `field-evidence`)».

- [ ] **Step 2: Full verification**

Run: `npm test && npm run lint && npm run build`
Expected: all suites pass, lint clean, build succeeds.

- [ ] **Step 3: End-to-end smoke on the test channel**

1. Ensure `AGENT_RUN_SECRET`, `ANTHROPIC_API_KEY`, `SLACK_TOKEN`, `VIMEO_TOKEN`, `POSTGRES_URL` are set on Vercel; deploy.
2. In `#orients-ops-console-test`, pick (or publish via `npm run field-publish -- --channel orients-ops-console-test --publish` on a small window) a NEEDS_REVIEW verdict.
3. As a non-approver: reply «що ще бракує?» → expect «💬 Думаю…» edited into an answer, `evidence_events` row kind=chat.
4. Reply «дощ, запис не працював» → expect the 🔎 echo tagging both approvers; `npm run field-evidence -- --list …` shows a pilot proposal. As an approver reply «так» → applied, ack names the approver.
5. Reply with a Vimeo link → «🔎 Перевіряю…» edited into the shortfall/closed text.
6. Check `npm run sent -- --start … --end … --format table` shows every post keyed by the reply ts (feature `evidence`).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: field-evidence CLI + thread-reply routing in CLAUDE.md

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** §3 routing → T2/T3/T4/T9/T11; §4 verification → T6/T7; §5 escalation + confirmer-as-`by` → T5/T8/T9; §6 chat → T10/T11; §7 ask alignment → T9 (`kind: "ask"` target), T11 wiring, T12 CLI; §8 storage → T1; §9 CLI+web → T13/T14; §10 idempotency (event claim unchanged, `evidence_events.source_reply_ts` unique, keys salted by reply ts, placeholder dedup on redelivery, skipped edit throws) → T1/T9/T11; §11 tests → each task; §12 rollout → T15 smoke.
- **Deferred by spec:** deploy-window override table (§5.2) — not in this plan.
- **Type consistency:** `DeferredWork`, `ReplyTarget`, `targetEntry`, `escalateClaim` are defined in T9 and consumed verbatim in T11/T12/T13; `ReplyHints` from T2 flows through T3/T7/T9; `EvidenceOutcomeKind` from T6 through T7/T11; `ProposalOrigin`/`origin` from T1 through T8/T9/T13/T14.
