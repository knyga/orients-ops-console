/**
 * Pure dispatch for a classified thread reply (pilot evidence autonomy). The
 * model said WHAT the text is; this decides WHAT HAPPENS, with the role gate
 * repeated in code so a mislabel can never let a pilot confirm or instruct.
 * Priority within one reply: confirm/cancel → instruction → verify → escalate → chat → silent.
 */
import type { ClaimItem, EvidenceItem, ReplyRole, ThreadReplyClassification } from "./instructionClassifyPrompt";

export type PublishedStatusHint = "accepted" | "needs_review" | "rejected" | "unknown";

/** Status of a published verdict from its leading icon (the only status signal the
 *  handler has without a recompute). Ask-question texts have no icon → unknown. */
export function publishedStatusHint(text: string): PublishedStatusHint {
  const head = text.trimStart().slice(0, 2);
  if (head.startsWith("✅")) return "accepted";
  if (head.startsWith("⚠️") || head.startsWith("⚠")) return "needs_review";
  if (head.startsWith("⛔")) return "rejected";
  return "unknown";
}

export type ThreadReplyAction =
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "instruction" }
  | { type: "verify"; evidence: EvidenceItem[]; claim?: ClaimItem }
  | { type: "escalate"; claim: ClaimItem }
  | { type: "chat" }
  | { type: "silent"; reason: string };

export function decideThreadReply(
  c: ThreadReplyClassification,
  role: ReplyRole,
  hasPending: boolean,
  status: PublishedStatusHint,
): ThreadReplyAction {
  if (c.intent === "confirm" || c.intent === "cancel") {
    if (role !== "approver") return { type: "silent", reason: "pilot-cannot-confirm" };
    if (!hasPending) return { type: "silent", reason: "nothing-pending" };
    return { type: c.intent };
  }
  if (c.intent === "instruction") {
    if (role !== "approver" || !c.axis) return { type: "silent", reason: "instruction-not-allowed" };
    return { type: "instruction" };
  }
  if (c.intent === "evidence" && c.evidence?.length) {
    return { type: "verify", evidence: c.evidence, ...(c.claim ? { claim: c.claim } : {}) };
  }
  // Any claim escalates, regardless of the overall intent the model landed on
  // (spec §3.3 step 4 keys on "claim present", before chat) — a claim riding
  // along with a "chat"/"unclear" intent must still reach approvers, never be
  // silently answered as chat. Only an explanation/deploy_window claim on an
  // already-accepted day is a no-op; airborne/loss_found always escalate.
  if (c.claim) {
    const skip = (c.claim.kind === "explanation" || c.claim.kind === "deploy_window") && status === "accepted";
    if (skip) return { type: "silent", reason: "already-accepted" };
    return { type: "escalate", claim: c.claim };
  }
  if (c.intent === "chat") return { type: "chat" };
  return { type: "silent", reason: "unclear" };
}
