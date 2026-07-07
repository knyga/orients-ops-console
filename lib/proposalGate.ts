/**
 * Pure apply-time gate for confirm-first agent proposals. Money-affecting
 * kinds (the loss ledger) may only be applied by an authorized approver
 * (lib/approvers.ts) — mirroring the verdict-thread instruction gate. The
 * gate also injects the approver's display name as the write's `by`.
 */
import { approverFor } from "./approvers";

const APPROVER_GATED_KINDS = new Set(["field_loss_set"]);

export function gateProposalApply(
  kind: string,
  proposedBy: string,
): { ok: true; extraParams: Record<string, unknown> } | { ok: false; refusalUk: string } {
  if (!APPROVER_GATED_KINDS.has(kind)) return { ok: true, extraParams: {} };
  const approver = approverFor(proposedBy);
  if (!approver) {
    return { ok: false, refusalUk: "⛔ Зміни щодо втрат бортів може підтвердити лише затверджувач (Oleksandr K або Bohdan Forostianyi)." };
  }
  return { ok: true, extraParams: { by: approver.name } };
}
