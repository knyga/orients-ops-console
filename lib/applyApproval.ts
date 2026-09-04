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
import { approvalOutboundKeys, type SendTrigger } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { writePublished, recordPublished, type PublishedEntry } from "./published";
import { upsertResolution, type ResolutionDecision } from "./resolutions";
import { formatOverride, splitRosterSuffix } from "./verdictPublish";
import { reportKey } from "./fieldDayVerdict";
import type { Period } from "./period";
import { decideApproval } from "../scripts/fieldApprovalsReport";
import { liveVerdictText } from "./liveText";

export interface ApproverDecisionArgs {
  entry: PublishedEntry;
  period: Period;
  decision: ResolutionDecision; // accepted_exception (approve) | rejected (disapprove)
  by: string;                   // approver name
  reason: string;
  evidence: string;             // permalink to the deciding reply (or "")
  trigger?: SendTrigger;
  /** Per-instruction outbound salt (the instructing reply's ts) — see approvalOutboundKeys. */
  salt?: string;
}

export interface ApproverDecisionResult {
  applied: boolean;
  /** True when this exact decision was already acknowledged (skipped, no writes). */
  alreadyAcked: boolean;
}

export interface AmendVerdictArgs {
  entry: PublishedEntry;
  period: Period;
  decision: ResolutionDecision;
  by: string;
  reason: string;
  trigger: SendTrigger;
  /** Post the generic "Зафіксовано" threaded ack. Callers with an axis-specific ack pass false. */
  postAck: boolean;
  /** Per-instruction outbound salt (the instructing reply's ts) — see approvalOutboundKeys. */
  salt?: string;
}

/**
 * Amend a published verdict in Slack: strike the BODY (from the pristine
 * `entry.text`); keep the roster suffix, the trailing drone line AND the 🔗
 * links line intact — each is a disjoint region, read from the message's
 * CURRENT live text (`lib/liveText.ts liveVerdictText`) so a crew correction
 * or a cross-link edit already on the message survives the strike. Optionally
 * posts the generic threaded ack, and stamps the entry's `override`; `text`
 * itself is left untouched by the write-back (always the FIRST-posted
 * render). Skips entirely when this same decision was already acked (Slack's
 * at-least-once delivery / a CLI re-run never double-posts); a CHANGED
 * decision re-amends (formatOverride always strikes the ORIGINAL text, never
 * double-striking even though the live text is already struck once). Shared
 * by the day axis and the dataset-decline path.
 */
export async function amendPublishedVerdict(args: AmendVerdictArgs): Promise<ApproverDecisionResult> {
  const { entry, period, decision, by, reason, trigger, postAck, salt } = args;

  if (entry.override?.decision === decision) {
    return { applied: false, alreadyAcked: true };
  }

  const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
  if (!channel) {
    return { applied: false, alreadyAcked: false };
  }

  // The BODY to strike must come from entry.text (pristine — the FIRST-posted
  // render), so a decision flip / re-amend strikes the ORIGINAL text exactly
  // once (formatOverride's double-strike guard). The roster/drone/links TAIL,
  // though, comes from the message's LIVE text (lib/liveText.ts) — a crew
  // correction or a cross-link edit landing AFTER a prior override never
  // wrote back to `published.text` (see lib/applyRosterCorrection.ts /
  // lib/relinkDay.ts), so entry.text's tail can be stale; reading it live
  // means this strike never erases a tail region added since.
  const { body } = splitRosterSuffix(entry.text);
  const { rosterLine, droneLine, linksLine } = splitRosterSuffix(await liveVerdictText(entry));
  const { updatedText: struck, replyText } = formatOverride(body, decision, by, reason);
  const tail = [rosterLine, droneLine, linksLine].filter(Boolean).join("\n");
  const updatedText = tail ? `${struck}\n${tail}` : struck;
  // Key the edit + ack by the DECISION, not the (non-deterministic) reason text,
  // so a redelivered Slack event dedups to a single post while a genuine flip
  // (accept → reject) still reposts; the salt keeps a flip BACK (accept → reject
  // → accept) from colliding with the first accept. See lib/outboundKeys.ts.
  const { editKey, ackKey } = approvalOutboundKeys(reportKey(entry.date, entry.reportTs), decision, salt);
  await updateMessage(channel.id, entry.ts, updatedText, {
    key: editKey,
    feature: "approval",
    channel: channel.name,
    trigger,
  });
  if (postAck) {
    await postMessage(
      channel.id,
      replyText,
      {
        key: ackKey,
        feature: "approval",
        channel: channel.name,
        trigger,
      },
      entry.ts,
    );
  }

  await writePublished(
    period,
    recordPublished({}, { ...entry, override: { decision, by, ackedAt: new Date().toISOString() } }),
  );

  return { applied: true, alreadyAcked: false };
}

/**
 * The override effect: write the day-axis resolution, then amend the verdict in
 * Slack + ack + stamp `override` (amendPublishedVerdict). Skips entirely when
 * this same decision was already acked.
 */
export async function applyApproverDecision(
  args: ApproverDecisionArgs,
): Promise<ApproverDecisionResult> {
  const { entry, period, decision, by, reason, evidence, trigger = "unknown", salt } = args;

  if (entry.override?.decision === decision) {
    return { applied: false, alreadyAcked: true };
  }

  await upsertResolution({
    date: entry.date,
    reportTs: entry.reportTs ?? "",
    axis: "day",
    decision,
    note: reason,
    source: evidence || "slack",
    recordedAt: new Date().toISOString(),
    by,
  });

  // Resolution is recorded even when no tracked channel exists to edit/ack.
  return amendPublishedVerdict({ entry, period, decision, by, reason, trigger, postAck: true, salt });
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
