/**
 * Durable resolutions store — the agent's memory of human-confirmed exceptions
 * (e.g. "2026-06-13 force-majeure, accepted"). Consulted by the verdict so a
 * remembered exception flips NEEDS_REVIEW → ACCEPTED_EXCEPTION (or a veto →
 * REJECTED). Decisions are auditable and reversible. Backed by the `resolutions`
 * Postgres table (keyed by flight date + axis), shared by CLIs, events route, and web.
 *
 * NOT server-only: the CLIs import it (like lib/reports.ts). The apply/merge
 * logic is pure; only the read/write hit the DB.
 */
import { db, schema } from "./db";
import type { DatasetStatus, DayVerdict } from "./fieldDayVerdict";

export type ResolutionDecision = "accepted_exception" | "rejected";
export type ResolutionAxis = "dataset" | "video" | "day";

export interface Resolution {
  date: string;                     // YYYY-MM-DD flight day
  axis: ResolutionAxis;             // what the decision is about (dataset | video | whole day)
  decision: ResolutionDecision;     // accepted_exception (forgive) | rejected (veto)
  note: string;
  source: string;                   // permalink or "manual"
  recordedAt: string;               // ISO
  /** Who decided (e.g. an approver's name), when applicable. */
  by?: string;
}

function toResolution(r: typeof schema.resolutions.$inferSelect): Resolution {
  return {
    date: r.date,
    axis: (r.axis as ResolutionAxis | null) ?? "day",
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

/** Insert or replace the resolution for its date + axis. */
export async function upsertResolution(resolution: Resolution): Promise<void> {
  const values = {
    date: resolution.date,
    axis: resolution.axis,
    decision: resolution.decision,
    note: resolution.note,
    source: resolution.source,
    by: resolution.by ?? null,
    recordedAt: resolution.recordedAt,
  };
  await db
    .insert(schema.resolutions)
    .values(values)
    .onConflictDoUpdate({ target: [schema.resolutions.date, schema.resolutions.axis], set: values });
}

/**
 * Derive the dataset axis status from the live #datasets signal + the dataset-
 * scoped (or whole-day) resolutions. A stated reason WAIVES; an admin veto on a
 * day with no posting DECLINES. A genuine posting wins (a posted-but-rejected day
 * stays POSTED here — the day-level veto is applied separately). Pure.
 */
export function deriveDatasetStatus(
  datasetPosted: boolean,
  date: string,
  resolutions: Resolution[],
): { status: DatasetStatus; note?: string } {
  const forDate = resolutions.filter(
    (r) => r.date === date && (r.axis === "dataset" || r.axis === "day"),
  );
  const rejected = forDate.find((r) => r.decision === "rejected");
  const exception = forDate.find((r) => r.decision === "accepted_exception");

  if (!datasetPosted && rejected) {
    // A day-axis rejection's note is already surfaced by applyResolution; only
    // attach the verbatim note here for a dataset-axis decline (which
    // applyResolution ignores) — avoids the same reason appearing twice.
    if (rejected.axis === "dataset") {
      const who = rejected.by ? ` (${rejected.by})` : "";
      return { status: "DECLINED", note: `dataset reason declined${who}: ${rejected.note}` };
    }
    return { status: "DECLINED" };
  }
  if (datasetPosted) return { status: "POSTED" };
  if (exception) {
    const who = exception.by ? ` (${exception.by})` : "";
    return { status: "WAIVED", note: `dataset waived${who}: ${exception.note}` };
  }
  return { status: "MISSING" };
}

/**
 * Apply the VIDEO/DAY-axis overlay to a verdict (pure). The dataset axis is
 * handled by deriveDatasetStatus + verdictForDay; here we only honour exceptions
 * and vetoes that target the video gate or the whole day:
 *  - a `rejected` (video|day) is an authoritative veto → REJECTED from ANY status.
 *  - an `accepted_exception` (video|day) forgives a flagged miss → ACCEPTED_EXCEPTION,
 *    but only from NEEDS_REVIEW (never upgrades an already-good day).
 */
export function applyResolution(verdict: DayVerdict, resolutions: Resolution[]): DayVerdict {
  const forDate = resolutions.filter(
    (r) => r.date === verdict.date && (r.axis === "video" || r.axis === "day"),
  );
  const rejected = forDate.find((r) => r.decision === "rejected");
  if (rejected) {
    const who = rejected.by ? ` (${rejected.by})` : "";
    return { ...verdict, status: "REJECTED", reasons: [...verdict.reasons, `rejected${who}: ${rejected.note}`] };
  }
  const exception = forDate.find((r) => r.decision === "accepted_exception");
  if (exception && verdict.status === "NEEDS_REVIEW") {
    const who = exception.by ? ` (${exception.by})` : "";
    return { ...verdict, status: "ACCEPTED_EXCEPTION", reasons: [...verdict.reasons, `exception${who}: ${exception.note}`] };
  }
  return verdict;
}
