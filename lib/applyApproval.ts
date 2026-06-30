/**
 * Shared S7 effect: apply an authorized approver's override to a published
 * verdict. SERVER-ONLY (classifies via Claude + writes to Slack). One source of
 * truth for the override effect, called by BOTH the `field-approvals` CLI (batch
 * decide → applyApproverDecision) and the `/api/slack/events` webhook (one reply
 * → applyApproverReply). Idempotent: re-applying the same decision is a no-op.
 */
import "server-only";
import { classifyApproval } from "./approvalClassify";
import { postMessage, updateMessage } from "./slack";
import { approvalAckKey, approvalEditKey, contentRev, type SendTrigger } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { writePublished, type PublishedEntry } from "./published";
import { upsertResolution, type ResolutionDecision } from "./resolutions";
import { formatOverride, splitRosterSuffix } from "./verdictPublish";
import type { Period } from "./period";
import { decideApproval } from "../scripts/fieldApprovalsReport";

export interface ApproverDecisionArgs {
  entry: PublishedEntry;
  period: Period;
  decision: ResolutionDecision; // accepted_exception (approve) | rejected (disapprove)
  by: string;                   // approver name
  reason: string;
  evidence: string;             // permalink to the deciding reply (or "")
  trigger?: SendTrigger;
}

export interface ApproverDecisionResult {
  applied: boolean;
  /** True when this exact decision was already acknowledged (skipped, no writes). */
  alreadyAcked: boolean;
}

/**
 * The override effect: write the resolution, amend the original verdict in Slack
 * (strike-through + new state), post a threaded ack, and stamp the published
 * entry's `override`. Skips entirely when this same decision was already acked
 * (so Slack's at-least-once delivery / a CLI re-run never double-posts). A
 * CHANGED decision re-acks (formatOverride always strikes the ORIGINAL text).
 */
export async function applyApproverDecision(
  args: ApproverDecisionArgs,
): Promise<ApproverDecisionResult> {
  const { entry, period, decision, by, reason, evidence, trigger = "unknown" } = args;

  if (entry.override?.decision === decision) {
    return { applied: false, alreadyAcked: true };
  }

  await upsertResolution({
    date: entry.date,
    axis: "day",
    decision,
    note: reason,
    source: evidence || "slack",
    recordedAt: new Date().toISOString(),
    by,
  });

  const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
  if (!channel) {
    // Resolution is recorded, but without a tracked channel we cannot edit/ack.
    return { applied: false, alreadyAcked: false };
  }

  // Strike only the verdict BODY; preserve the crew suffix (👥 У полі: …) so an
  // override and a roster correction edit disjoint regions of the message.
  const { body, rosterLine } = splitRosterSuffix(entry.text);
  const { updatedText: struck, replyText } = formatOverride(body, decision, by, reason);
  const updatedText = rosterLine ? `${struck}\n${rosterLine}` : struck;
  const editRev = contentRev(updatedText);
  await updateMessage(channel.id, entry.ts, updatedText, {
    key: approvalEditKey(entry.date, editRev),
    feature: "approval",
    channel: channel.name,
    trigger,
  });
  await postMessage(
    channel.id,
    replyText,
    {
      key: approvalAckKey(entry.date, contentRev(replyText)),
      feature: "approval",
      channel: channel.name,
      trigger,
    },
    entry.ts,
  );

  await writePublished(period, {
    [entry.date]: { ...entry, override: { decision, by, ackedAt: new Date().toISOString() } },
  });

  return { applied: true, alreadyAcked: false };
}

export interface ApproverReplyArgs {
  entry: PublishedEntry;
  period: Period;
  replyText: string;
  approverName: string;
  replyPermalink: string;
  replyTs: string;
  trigger?: SendTrigger;
}

/**
 * Single-reply path for the events webhook: classify one approver reply, decide
 * approve/disapprove (an `unclear` reply is a no-op), and apply the effect.
 */
export async function applyApproverReply(
  args: ApproverReplyArgs,
): Promise<ApproverDecisionResult> {
  const classification = await classifyApproval(args.entry.text, args.replyText);
  const outcome = decideApproval([
    { classification, by: args.approverName, permalink: args.replyPermalink, ts: args.replyTs },
  ]);
  if (!outcome) return { applied: false, alreadyAcked: false };

  const decision: ResolutionDecision =
    outcome.decision === "approve" ? "accepted_exception" : "rejected";
  return applyApproverDecision({
    entry: args.entry,
    period: args.period,
    decision,
    by: outcome.by,
    reason: outcome.reason,
    evidence: outcome.evidencePermalink,
    trigger: args.trigger,
  });
}
