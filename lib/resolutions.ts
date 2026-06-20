/**
 * Durable resolutions store — the agent's memory of human-confirmed exceptions
 * (e.g. "2026-06-13 force-majeure, accepted"). Consulted by the verdict so a
 * remembered exception flips NEEDS_REVIEW → ACCEPTED_EXCEPTION (or a veto →
 * REJECTED). Decisions are auditable and reversible. Backed by the `resolutions`
 * Postgres table (keyed by flight date), shared by CLIs, events route, and web.
 *
 * NOT server-only: the CLIs import it (like lib/reports.ts). The apply/merge
 * logic is pure; only the read/write hit the DB.
 */
import { db, schema } from "./db";
import type { DayVerdict } from "./fieldDayVerdict";

export type ResolutionDecision = "accepted_exception" | "rejected";

export interface Resolution {
  date: string;                     // YYYY-MM-DD flight day
  decision: ResolutionDecision;     // accepted_exception (forgive a miss) | rejected (human veto)
  note: string;
  source: string;                   // permalink or "manual"
  recordedAt: string;               // ISO
  /** Who decided (e.g. an approver's name), when applicable. */
  by?: string;
}

function toResolution(r: typeof schema.resolutions.$inferSelect): Resolution {
  return {
    date: r.date,
    decision: r.decision as ResolutionDecision,
    note: r.note,
    source: r.source,
    recordedAt: r.recordedAt,
    ...(r.by != null ? { by: r.by } : {}),
  };
}

/** All resolutions (empty when none). */
export async function readResolutions(): Promise<Resolution[]> {
  const rows = await db.select().from(schema.resolutions);
  return rows.map(toResolution);
}

/** Insert or replace the resolution for its date. */
export async function upsertResolution(resolution: Resolution): Promise<void> {
  const values = {
    date: resolution.date,
    decision: resolution.decision,
    note: resolution.note,
    source: resolution.source,
    by: resolution.by ?? null,
    recordedAt: resolution.recordedAt,
  };
  await db
    .insert(schema.resolutions)
    .values(values)
    .onConflictDoUpdate({ target: schema.resolutions.date, set: values });
}

/** The resolution for a flight day, if any. Pure. */
export function resolutionFor(date: string, resolutions: Resolution[]): Resolution | undefined {
  return resolutions.find((r) => r.date === date);
}

/**
 * Apply a human resolution to a verdict (pure):
 *  - `rejected` is an authoritative human veto → REJECTED from ANY status.
 *  - `accepted_exception` forgives a flagged miss → ACCEPTED_EXCEPTION, but only
 *    from NEEDS_REVIEW (it never "upgrades" an already-good day).
 * The decider's name (if any) is folded into the appended reason. Other cases
 * leave the verdict untouched.
 */
export function applyResolution(verdict: DayVerdict, resolutions: Resolution[]): DayVerdict {
  const match = resolutionFor(verdict.date, resolutions);
  if (!match) return verdict;
  const who = match.by ? ` (${match.by})` : "";

  if (match.decision === "rejected") {
    return { ...verdict, status: "REJECTED", reasons: [...verdict.reasons, `rejected${who}: ${match.note}`] };
  }
  if (match.decision === "accepted_exception" && verdict.status === "NEEDS_REVIEW") {
    return { ...verdict, status: "ACCEPTED_EXCEPTION", reasons: [...verdict.reasons, `exception${who}: ${match.note}`] };
  }
  return verdict;
}
