/**
 * Pure apply-time gate for confirm-first agent proposals, run on the SLACK
 * confirm path only (app/api/slack/events). Consequential kinds — the
 * money-affecting loss ledger, and the sprint plan that freezes the weekly
 * completion baseline — may only be applied by an authorized approver
 * (lib/approvers.ts), mirroring the verdict-thread instruction gate; the gate
 * also injects the approver's display name as the write's `by`. On Slack this
 * is defense in depth (the agent surface already refuses non-approvers
 * wholesale). The CLI `--yes` path deliberately does NOT run this gate: it
 * calls proposal.apply() directly on an operator machine that already holds
 * the JIRA and Slack credentials, so a CLI-side identity check would be
 * theatre, not security.
 */
import { approverFor, isApprover } from "./approvers";

/**
 * Who may drive (confirm/cancel/supersede) a pending proposal outside a DM:
 * its requester, or any authorized approver. Everyone else is a bystander.
 */
export function canDriveProposal(proposedBy: string, userId: string): boolean {
  return userId === proposedBy || isApprover(userId);
}

/** kind → the Ukrainian refusal a non-approver gets. */
const APPROVER_GATED_KINDS = new Map<string, string>([
  [
    "field_loss_set",
    "⛔ Зміни щодо втрат бортів може підтвердити лише затверджувач (Oleksandr K або Bohdan Forostianyi).",
  ],
  [
    "sprint_plan_build",
    "⛔ Скласти план спринту може лише затверджувач (Oleksandr K або Bohdan Forostianyi).",
  ],
]);

export function gateProposalApply(
  kind: string,
  proposedBy: string,
): { ok: true; extraParams: Record<string, unknown> } | { ok: false; refusalUk: string } {
  const refusalUk = APPROVER_GATED_KINDS.get(kind);
  if (refusalUk === undefined) return { ok: true, extraParams: {} };
  const approver = approverFor(proposedBy);
  if (!approver) return { ok: false, refusalUk };
  return { ok: true, extraParams: { by: approver.name } };
}
