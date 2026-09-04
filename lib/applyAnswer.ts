/**
 * S6 effect, aligned with pilot evidence autonomy (2026-09-04): a reply to one
 * of the bot's gap questions never writes an exception on its own. An
 * explanation becomes a pilot-origin proposal for the approvers (escalateClaim);
 * provided data is left to the live recompute. Called by the `field-remember`
 * CLI (batch). The webhook path goes through lib/applyThreadReply directly.
 */
import "server-only";
import { setAskState, writeAsks, type AskRecord } from "./asks";
import { escalateClaim } from "./applyThreadReply";
import type { Period } from "./period";
import type { Outcome } from "../scripts/fieldRememberReport";

export interface AnswerDecisionArgs {
  record: AskRecord;
  period: Period;
  outcome: Outcome;
  /** The deciding reply (for the proposal's sourceReplyTs + attribution). */
  replyTs: string;
  userId: string;
  userName: string;
  trigger?: "cli" | "webhook";
}

/**
 * The answer effect: when the outcome is an escalation, raise a pilot-origin
 * proposal for the approvers (never write a resolution directly); always
 * advance the ask's state. Persists the single ask record (upsert) so the
 * CLI's batch loop is the sole caller of this path.
 */
export async function applyAnswerDecision(a: AnswerDecisionArgs): Promise<void> {
  if (a.outcome.escalate && a.outcome.claimText) {
    await escalateClaim({
      target: { kind: "ask", record: a.record, period: a.period },
      claim: { kind: "explanation", text: a.outcome.claimText },
      userName: a.userName,
      userId: a.userId,
      role: "pilot",
      replyTs: a.replyTs,
      trigger: a.trigger ?? "cli",
    });
  }

  const key = `${a.record.gapType}:${a.record.date}`;
  const updated = setAskState({ [key]: a.record }, key, a.outcome.state, a.outcome.note);
  await writeAsks(a.period, updated);
}
