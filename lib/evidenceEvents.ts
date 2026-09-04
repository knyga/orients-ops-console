/**
 * Audit store for the thread-reply handler (pilot evidence autonomy). One row
 * per human reply the bot acted on. NOT server-only: the CLI + web API import it.
 * Idempotent on sourceReplyTs (Slack redelivery).
 */
import { and, eq, gte, lte } from "drizzle-orm";
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

/**
 * Whether this reply has already been acted on. The audit row is written at the
 * END of the deferred work, so this is the effect-idempotency guard for a
 * DUPLICATE internal invocation of that work (the webhook self-invoke retried,
 * an operator re-POSTing /api/field/thread-reply): without it the recompute,
 * the published-message refresh and the claim escalation all run twice.
 */
export async function hasEvidenceEvent(sourceReplyTs: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.evidenceEvents.id })
    .from(schema.evidenceEvents)
    .where(eq(schema.evidenceEvents.sourceReplyTs, sourceReplyTs))
    .limit(1);
  return rows.length > 0;
}

export async function readEvidenceEventsInWindow(start: string, end: string): Promise<EvidenceEvent[]> {
  const rows = await db
    .select()
    .from(schema.evidenceEvents)
    .where(and(gte(schema.evidenceEvents.date, start), lte(schema.evidenceEvents.date, end)));
  return rows.map(toEvidenceEvent).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}
