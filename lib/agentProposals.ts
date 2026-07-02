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
