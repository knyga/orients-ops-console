/**
 * Console access allowlist — the Slack user ids permitted to sign in to the ops
 * console. Hardcoded for the Orients workspace (like lib/approvers.ts):
 * membership is a deliberate, auditable decision, not config.
 *
 * Kept SEPARATE from lib/approvers.ts on purpose: "can log in" and "can override
 * a verdict" are distinct authorizations that may diverge. Seeded with the two
 * approvers; add ids here (then redeploy) to grant access.
 */
export interface AllowedUser {
  /** Slack user id (U…). */
  userId: string;
  name: string;
}

export const ALLOWED_USERS: AllowedUser[] = [
  { userId: "U08G4EC244X", name: "Oleksandr K" },
  { userId: "U08G4HZQTTR", name: "Bohdan Forostianyi" },
];

/** The allowed user for a Slack user id, or undefined if not permitted. */
export function allowedUserFor(userId: string): AllowedUser | undefined {
  return ALLOWED_USERS.find((u) => u.userId === userId);
}
