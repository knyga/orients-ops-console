/**
 * THE thread-reply handler (pilot evidence autonomy, spec §3). Any human reply in
 * a published-verdict thread or a bot gap-question thread:
 *   stage 1 (code)   role gate + regex hints
 *   stage 2 (model)  role-narrowed classification (classifyThreadReply)
 *   stage 3 (code)   decideThreadReply → inline effect, or DeferredWork for the
 *                    slow paths (verify / chat) the caller runs off the request.
 * Approver confirm/cancel/instruction reuse applyClassifiedInstruction verbatim.
 * SERVER-ONLY (Claude + Slack + DB).
 */
import "server-only";
import { classifyThreadReply } from "./instructionClassify";
import { decideThreadReply, publishedStatusHint } from "./threadReplyDecide";
import { extractHints, type ReplyHints } from "./threadReplyHints";
import { askClaimToInstruction, claimToInstruction, renderEscalationEcho } from "./claimProposal";
import { applyClassifiedInstruction } from "./applyInstructionReply";
import { createProposal, readActiveProposals } from "./proposals";
import { renderProposalSummary } from "./proposalSummary";
import { recordEvidenceEvent } from "./evidenceEvents";
import { postMessage } from "./slack";
import { instructionAckKey, type SendTrigger } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { reportKey } from "./fieldDayVerdict";
import type { PublishedEntry } from "./published";
import type { AskRecord } from "./asks";
import type { ClaimItem, ReplyRole } from "./instructionClassifyPrompt";
import type { Period } from "./period";

export type ReplyTarget =
  | { kind: "verdict"; entry: PublishedEntry; period: Period }
  | { kind: "ask"; record: AskRecord; period: Period };

export interface ThreadReplyArgs {
  target: ReplyTarget;
  replyText: string;
  userId: string;
  userName: string;
  role: ReplyRole;
  replyTs: string;
  replyPermalink: string;
  trigger?: SendTrigger;
}

export interface DeferredWork {
  kind: "verify" | "chat";
  target: ReplyTarget;
  replyText: string;
  userId: string;
  userName: string;
  role: ReplyRole;
  replyTs: string;
  replyPermalink: string;
  hints: ReplyHints;
  claim?: ClaimItem;
  trigger: SendTrigger;
}

export type ThreadReplyResult =
  | { handled: "confirmed" | "cancelled" | "proposed" | "escalated" | "silent"; intent: string; applied?: boolean; failed?: string[] }
  | { handled: "deferred"; work: DeferredWork };

const DATASETS_ID = TRACKED_CHANNELS.find((c) => c.name === "datasets")?.id ?? "";

/** The thread root as a PublishedEntry — real for a verdict, synthetic for an ask
 *  (the ask's own message is the thread root; dataset/video axes are day-wide). */
export function targetEntry(t: ReplyTarget): PublishedEntry {
  if (t.kind === "verdict") return t.entry;
  return { date: t.record.date, reportTs: null, channel: t.record.channel, text: t.record.question, postedAt: t.record.askedAt, ts: t.record.askedTs };
}

export async function escalateClaim(a: {
  target: ReplyTarget; claim: ClaimItem; userName: string; userId: string; role: ReplyRole; replyTs: string; trigger: SendTrigger;
  verifyLine?: string; statusBefore?: string | null; statusAfter?: string | null; hints?: ReplyHints;
}): Promise<{ created: boolean; proposalId: string | null }> {
  const entry = targetEntry(a.target);
  const mapped = a.target.kind === "ask" ? askClaimToInstruction(a.target.record.gapType, a.claim, a.userName) : claimToInstruction(a.claim, a.userName);
  const summaryUk = renderProposalSummary(entry.date, mapped.instruction);
  const { created, proposal } = await createProposal({
    threadTs: entry.ts, channel: entry.channel, date: entry.date, axis: mapped.axis, payload: mapped.instruction,
    summaryUk, proposedBy: a.userName, origin: "pilot", sourceReplyTs: a.replyTs,
  });
  if (!created) return { created: false, proposalId: proposal.id };
  const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
  if (channel) {
    await postMessage(
      channel.id,
      renderEscalationEcho({ byName: a.userName, claimText: a.claim.text, summaryUk, verifyLine: a.verifyLine }),
      { key: instructionAckKey(reportKey(entry.date, entry.reportTs), "escalate", a.replyTs), feature: "evidence", channel: channel.name, trigger: a.trigger },
      entry.ts,
    );
  }
  try {
    await recordEvidenceEvent({
      threadTs: entry.ts, channel: entry.channel, date: entry.date, reportTs: entry.reportTs, byUserId: a.userId, byName: a.userName, role: a.role,
      kind: "claim", evidence: { claim: a.claim, hints: a.hints ?? null }, outcome: "escalated", statusBefore: a.statusBefore ?? null, statusAfter: a.statusAfter ?? null,
      sourceReplyTs: a.replyTs, proposalId: proposal.id,
    });
  } catch (err) {
    // A valid escalation must never surface as a thread error just because the
    // audit row failed to write — the proposal is already created and echoed.
    console.error("escalateClaim: audit write failed:", err);
  }
  return { created: true, proposalId: proposal.id };
}

export async function applyThreadReply(a: ThreadReplyArgs): Promise<ThreadReplyResult> {
  const trigger = a.trigger ?? "webhook";
  const entry = targetEntry(a.target);
  const pending = await readActiveProposals(entry.ts);
  const pendingEcho = pending.length ? pending.map((p) => p.summaryUk).join("; ") : null;
  const hints = extractHints(a.replyText, DATASETS_ID);
  const c = await classifyThreadReply(entry.text, a.replyText, pendingEcho, a.role, hints);
  const action = decideThreadReply(c, a.role, pending.length > 0, publishedStatusHint(entry.text));

  if (action.type === "confirm" || action.type === "cancel" || action.type === "instruction") {
    // An ask thread's "entry" is a SYNTHETIC one (the bot's own question message,
    // keyed by the bare date). Only the two axes an ask thread is actually about
    // — waiving the dataset it asked for, or accepting the video it asked about —
    // are safe to apply there (both are ack-only posts, no message amendment).
    // Anything else (day/crew/airborne/loss, or a dataset DECLINE) would target
    // the wrong Slack message / published row — redirect instead of applying.
    if (action.type === "instruction" && a.target.kind === "ask") {
      const allowed = (c.axis === "dataset" && c.datasetStatus === "WAIVED") || c.axis === "video";
      if (!allowed) {
        const channel = TRACKED_CHANNELS.find((ch) => ch.name === entry.channel);
        if (channel) {
          await postMessage(
            channel.id,
            `ℹ️ Це можна зробити лише у треді вердикту за ${entry.date} (тут — лише «датасет не потрібен» / «відео зарахувати»).`,
            { key: instructionAckKey(reportKey(entry.date, entry.reportTs), "ask-redirect", a.replyTs), feature: "evidence", channel: channel.name, trigger },
            entry.ts,
          );
        }
        return { handled: "silent", intent: c.intent };
      }
    }
    // Approver-only by construction (decideThreadReply); the existing path owns echo/apply/acks.
    const res = await applyClassifiedInstruction({
      entry, period: a.target.period, approverName: a.userName, replyPermalink: a.replyPermalink, replyTs: a.replyTs, trigger,
      classification: { ...c, intent: action.type },
      pending,
    });
    // applyClassifiedInstruction's "noop" (redelivery / already-settled) has no
    // slot in ThreadReplyResult — it collapses to "silent" here.
    if (res.handled === "noop") return { handled: "silent", intent: c.intent };
    return { handled: res.handled, intent: res.intent ?? c.intent, ...(res.applied !== undefined ? { applied: res.applied } : {}), ...(res.failed ? { failed: res.failed } : {}) };
  }
  if (action.type === "verify" || action.type === "chat") {
    return {
      handled: "deferred",
      work: {
        kind: action.type, target: a.target, replyText: a.replyText, userId: a.userId, userName: a.userName, role: a.role,
        replyTs: a.replyTs, replyPermalink: a.replyPermalink, hints, trigger,
        ...(action.type === "verify" && action.claim ? { claim: action.claim } : {}),
      },
    };
  }
  if (action.type === "escalate") {
    const r = await escalateClaim({ target: a.target, claim: action.claim, userName: a.userName, userId: a.userId, role: a.role, replyTs: a.replyTs, trigger });
    return r.created ? { handled: "escalated", intent: c.intent } : { handled: "silent", intent: c.intent };
  }
  return { handled: "silent", intent: c.intent };
}
