/**
 * Pure state machine for a confirm-first data-overwrite proposal. An approver's
 * verdict-thread instruction is stored as a PROPOSED proposal; the bot echoes it
 * and only applies it once the approver CONFIRMS. A new instruction in the same
 * thread SUPERSEDES a prior proposal on the SAME axis only — different axes
 * stack up (a day accept + a crew fix) and one «так» applies them all. No
 * DB/Next imports — unit-tested; the DB read/write lives in lib/proposals.ts.
 */
export type ProposalState = "PROPOSED" | "CONFIRMED" | "CANCELLED" | "SUPERSEDED";
export type ProposalAction = "confirm" | "cancel" | "supersede";

/** The axis a proposal overwrites (mirrors the resolution/roster/airborne/loss stores). */
export type ProposalAxis = "crew" | "eligibility" | "day" | "dataset" | "video" | "airborne" | "loss";

const TRANSITIONS: Record<ProposalAction, ProposalState> = {
  confirm: "CONFIRMED",
  cancel: "CANCELLED",
  supersede: "SUPERSEDED",
};

/**
 * The next state for an action, or null when the proposal is already terminal
 * (CONFIRMED/CANCELLED/SUPERSEDED). Only a PROPOSED proposal transitions — a
 * re-delivered confirm/cancel on a settled proposal is a no-op (idempotency).
 */
export function nextState(current: ProposalState, action: ProposalAction): ProposalState | null {
  if (current !== "PROPOSED") return null;
  return TRANSITIONS[action];
}

/**
 * Does a new instruction on `incomingAxis` replace a pending proposal on
 * `pendingAxis`? Only when they overwrite the same thing — an approver who
 * says «прийняти день» and then «склад: …» means both, not the last one.
 */
export function supersedes(incomingAxis: ProposalAxis, pendingAxis: ProposalAxis): boolean {
  return incomingAxis === pendingAxis;
}
