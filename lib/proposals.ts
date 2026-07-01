/**
 * Durable confirm-first proposal store. An approver's verdict-thread instruction
 * becomes a PROPOSED proposal; the bot echoes it and applies it only once the
 * approver confirms (see the events route + lib/applyInstruction). Backed by the
 * `proposals` Postgres table, shared by the events route, the CLI, and web.
 *
 * NOT server-only: the CLI imports it (like lib/resolutions.ts). The state
 * machine is pure (lib/proposalDecision.ts); only read/write hit the DB.
 */
import { and, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "./db";
import { nextState, type ProposalAction, type ProposalAxis, type ProposalState } from "./proposalDecision";

export type { ProposalAction, ProposalAxis, ProposalState } from "./proposalDecision";

export interface Proposal {
  id: string;
  threadTs: string;
  channel: string;
  date: string;
  axis: ProposalAxis;
  payload: unknown;
  summaryUk: string;
  proposedBy: string;
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
    sourceReplyTs: r.sourceReplyTs,
    state: r.state as ProposalState,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
  };
}

/** The single active (PROPOSED) proposal for a thread, or null. */
export async function readActiveProposal(threadTs: string): Promise<Proposal | null> {
  const rows = await db
    .select()
    .from(schema.proposals)
    .where(and(eq(schema.proposals.threadTs, threadTs), eq(schema.proposals.state, "PROPOSED")));
  if (rows.length === 0) return null;
  // Newest wins if more than one somehow exists.
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return toProposal(rows[0]);
}

/**
 * Record a new PROPOSED proposal, superseding any prior active proposal in the
 * same thread. Idempotent on `sourceReplyTs` (a re-delivered Slack event returns
 * the existing proposal without inserting a duplicate).
 * Returns `{ created }` — false when the reply already produced a proposal.
 */
export async function createProposal(input: NewProposal): Promise<{ created: boolean; proposal: Proposal }> {
  const existing = await db
    .select()
    .from(schema.proposals)
    .where(eq(schema.proposals.sourceReplyTs, input.sourceReplyTs));
  if (existing.length > 0) return { created: false, proposal: toProposal(existing[0]) };

  await supersedeThread(input.threadTs);

  const now = new Date().toISOString();
  const rows = await db
    .insert(schema.proposals)
    .values({ ...input, state: "PROPOSED", createdAt: now, resolvedAt: null })
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

/** Mark every active (PROPOSED) proposal in a thread as SUPERSEDED. */
export async function supersedeThread(threadTs: string): Promise<void> {
  await db
    .update(schema.proposals)
    .set({ state: "SUPERSEDED", resolvedAt: new Date().toISOString() })
    .where(and(eq(schema.proposals.threadTs, threadTs), eq(schema.proposals.state, "PROPOSED")));
}

/**
 * Apply a confirm/cancel to a proposal via the pure state machine. Returns the
 * new state, or null when the proposal was already terminal (idempotent no-op).
 */
export async function settleProposal(proposal: Proposal, action: ProposalAction): Promise<ProposalState | null> {
  const next = nextState(proposal.state, action);
  if (!next) return null;
  await db
    .update(schema.proposals)
    .set({ state: next, resolvedAt: new Date().toISOString() })
    .where(and(eq(schema.proposals.id, proposal.id), eq(schema.proposals.state, "PROPOSED")));
  return next;
}

/** All proposals whose flight date falls in [start, end] (for web/CLI listing). */
export async function readProposalsInWindow(start: string, end: string): Promise<Proposal[]> {
  const rows = await db
    .select()
    .from(schema.proposals)
    .where(and(gte(schema.proposals.date, start), lte(schema.proposals.date, end)));
  return rows.map(toProposal).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}
