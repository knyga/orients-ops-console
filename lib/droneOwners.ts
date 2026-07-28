/**
 * Pilots who own drones — the only people the per-person drone-count gate binds.
 * A drone owner on a flight day's crew must have submitted their OWN drone-count
 * message for that date to be paid for that Звіт (author-based attribution; an
 * approver `eligibility: "counted"` correction outranks the gate). Hardcoded for
 * the Orients workspace (like lib/approvers.ts): membership is a deliberate,
 * auditable decision, not config. Pure — no DB/Next imports.
 *
 * `rosterName` is the roster-namespace first name (lib/fieldRoster SEED map) —
 * the namespace verdict `roster` / bonus `paidRoster` operate in.
 */
export interface DroneOwner {
  /** Slack user id (U…) — matched against a message's author. */
  userId: string;
  /** Roster-namespace first name ("Влад", not "Владислав"). */
  rosterName: string;
}

export const DRONE_OWNERS: DroneOwner[] = [
  { userId: "U091JDN2U5B", rosterName: "Влад" },
  { userId: "U091JDPH9L5", rosterName: "Любомир" },
  { userId: "U09AAVAEE6L", rosterName: "Андріан" },
];

/** The owner for a Slack user id, or undefined when that user owns no drones. */
export function droneOwnerForUserId(userId: string): DroneOwner | undefined {
  return DRONE_OWNERS.find((o) => o.userId === userId);
}

/** The owner for a roster-namespace name, or undefined. */
export function droneOwnerForRosterName(name: string): DroneOwner | undefined {
  return DRONE_OWNERS.find((o) => o.rosterName === name.trim());
}
