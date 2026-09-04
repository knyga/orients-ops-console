/**
 * Durable confirm-first proposal store. An approver's verdict-thread instruction
 * becomes a PROPOSED proposal; the bot echoes it and applies it only once the
 * approver confirms (see the events route + lib/applyInstruction). Backed by the
 * `proposals` Postgres table, shared by the events route, the CLI, and web.
 *
 * NOT server-only: the CLI imports it (like lib/resolutions.ts). The state
 * machine is pure (lib/proposalDecision.ts); only read/write hit the DB.
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db, schema } from "./db";
import { nextState, type ProposalAction, type ProposalAxis, type ProposalState } from "./proposalDecision";

export type { ProposalAction, ProposalAxis, ProposalState } from "./proposalDecision";
import { supersedes } from "./proposalDecision";

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

function toProposal(r: typeof schema.proposals.$inferSelect): Proposal {
  return {
    id: r.id,
    threadTs: r.threadTs,
    channel: r.channel,
    date: r.date,
    axis: r.axis as ProposalAxis,
    payload: r.payload,
    summaryUk: r.summaryUk,
    proposedBy: r.proposedBy,
    origin: r.origin === "pilot" ? "pilot" : "approver",
    sourceReplyTs: r.sourceReplyTs,
    state: r.state as ProposalState,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
  };
}

/** Every active (PROPOSED) proposal in a thread, oldest first (may span several axes). */
export async function readActiveProposals(threadTs: string): Promise<Proposal[]> {
  const rows = await db
    .select()
    .from(schema.proposals)
    .where(and(eq(schema.proposals.threadTs, threadTs), eq(schema.proposals.state, "PROPOSED")));
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return rows.map(toProposal);
}

/**
 * Record a new PROPOSED proposal, superseding any prior active proposal on the
 * SAME axis in the thread (other axes stay pending — see `supersedes`). Idempotent on `sourceReplyTs` (a re-delivered Slack event returns
 * the existing proposal without inserting a duplicate).
 * Returns `{ created }` — false when the reply already produced a proposal.
 */
export async function createProposal(input: NewProposal): Promise<{ created: boolean; proposal: Proposal }> {
  const existing = await db
    .select()
    .from(schema.proposals)
    .where(eq(schema.proposals.sourceReplyTs, input.sourceReplyTs));
  if (existing.length > 0) return { created: false, proposal: toProposal(existing[0]) };

  await supersedeThread(input.threadTs, input.axis);

  const now = new Date().toISOString();
  const rows = await db
    .insert(schema.proposals)
    .values({ ...input, origin: input.origin ?? "approver", state: "PROPOSED", createdAt: now, resolvedAt: null })
    .onConflictDoNothing({ target: schema.proposals.sourceReplyTs })
    .returning();
  if (rows.length > 0) return { created: true, proposal: toProposal(rows[0]) };
  // Lost a race — the concurrent insert won; return its row.
  const winner = await db
    .select()
    .from(schema.proposals)
    .where(eq(schema.proposals.sourceReplyTs, input.sourceReplyTs));
  return { created: false, proposal: toProposal(winner[0]) };
}

/**
 * Mark active (PROPOSED) proposals in a thread as SUPERSEDED — only those on
 * `incomingAxis` when given, every one when omitted.
 */
export async function supersedeThread(threadTs: string, incomingAxis?: ProposalAxis): Promise<void> {
  const pending = await readActiveProposals(threadTs);
  const victims = pending.filter((p) => incomingAxis === undefined || supersedes(incomingAxis, p.axis));
  if (victims.length === 0) return;
  await db
    .update(schema.proposals)
    .set({ state: "SUPERSEDED", resolvedAt: new Date().toISOString() })
    .where(and(inArray(schema.proposals.id, victims.map((v) => v.id)), eq(schema.proposals.state, "PROPOSED")));
}

/**
 * Apply a confirm/cancel to a proposal via the pure state machine. Returns the
 * new state, or null when the proposal was already terminal (idempotent no-op).
 */
export async function settleProposal(proposal: Proposal, action: ProposalAction): Promise<ProposalState | null> {
  const next = nextState(proposal.state, action);
  if (!next) return null;
  // The conditional update is the atomic claim: two concurrent confirms race
  // here, and only the one whose UPDATE matched the still-PROPOSED row may
  // run the effect — the loser sees null (idempotent no-op).
  const rows = await db
    .update(schema.proposals)
    .set({ state: next, resolvedAt: new Date().toISOString() })
    .where(and(eq(schema.proposals.id, proposal.id), eq(schema.proposals.state, "PROPOSED")))
    .returning({ id: schema.proposals.id });
  return rows.length > 0 ? next : null;
}

/** All proposals whose flight date falls in [start, end] (for web/CLI listing). */
export async function readProposalsInWindow(start: string, end: string): Promise<Proposal[]> {
  const rows = await db
    .select()
    .from(schema.proposals)
    .where(and(gte(schema.proposals.date, start), lte(schema.proposals.date, end)));
  return rows.map(toProposal).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}
