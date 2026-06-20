/**
 * Authorized verdict approvers — the only people whose in-thread reply to a
 * published verdict can override a flight day's state (approve → accepted
 * exception; disapprove → rejected). Hardcoded for the Orients workspace (like
 * lib/slackChannels): membership is a deliberate, auditable decision, not config.
 *
 * Matched against a Slack message's author user id (the `user` on a thread reply).
 * Resolved from the workspace 2026-06-20 (users.list).
 */
export interface Approver {
  /** Slack user id (U…). */
  userId: string;
  name: string;
  role: string;
}

export const APPROVERS: Approver[] = [
  { userId: "U08G4EC244X", name: "Oleksandr K", role: "CEO/CTO" },
  { userId: "U08G4HZQTTR", name: "Bohdan Forostianyi", role: "Head of Engineering" },
];

/** The approver for a user id, or undefined if that user is not authorized. */
export function approverFor(userId: string): Approver | undefined {
  return APPROVERS.find((a) => a.userId === userId);
}

/** Whether a user id is an authorized verdict approver. */
export function isApprover(userId: string): boolean {
  return APPROVERS.some((a) => a.userId === userId);
}
