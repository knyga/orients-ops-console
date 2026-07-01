/**
 * Single-reply confirm-first path for the events webhook. Classifies ONE approver
 * verdict-thread reply and either: confirms/cancels the pending proposal, or
 * records a NEW proposal and echoes it for confirmation, or (unclear/question)
 * stays silent. SERVER-ONLY (Claude classify + Slack + DB). One Claude call per
 * event (fits the 3s budget). Idempotent: proposal `source_reply_ts` uniqueness +
 * the pure state machine make a redelivered event a no-op.
 *
 * The apply happens ONLY on confirmation (via lib/applyInstruction), which owns
 * the per-axis ack — so this handler posts the proposal echo + the cancel note,
 * never a duplicate "applied" ack.
 */
import "server-only";
import { classifyInstruction } from "./instructionClassify";
import { applyInstruction } from "./applyInstruction";
import { createProposal, readActiveProposal, settleProposal } from "./proposals";
import { renderProposalSummary } from "./proposalSummary";
import { postMessage } from "./slack";
import { contentRev, instructionAckKey, type SendTrigger } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import type { PublishedEntry } from "./published";
import type { InstructionClassification } from "./instructionClassifyPrompt";
import type { Period } from "./period";

export interface InstructionReplyResult {
  handled: "confirmed" | "cancelled" | "proposed" | "noop";
  applied?: boolean;
  intent?: string;
}

export interface InstructionReplyArgs {
  entry: PublishedEntry;
  period: Period;
  replyText: string;
  approverName: string;
  replyPermalink: string;
  replyTs: string;
  trigger?: SendTrigger;
}

export async function applyInstructionReply(args: InstructionReplyArgs): Promise<InstructionReplyResult> {
  const { entry, period, replyText, approverName, replyPermalink, replyTs, trigger = "webhook" } = args;
  const channel = TRACKED_CHANNELS.find((ch) => ch.name === entry.channel);

  const active = await readActiveProposal(entry.ts);
  const c = await classifyInstruction(entry.text, replyText, active ? active.summaryUk : null);

  // Confirm the pending proposal → apply it now.
  if (active && c.intent === "confirm") {
    const next = await settleProposal(active, "confirm");
    if (next !== "CONFIRMED") return { handled: "noop", intent: c.intent }; // already settled (redelivery)
    const res = await applyInstruction({
      entry,
      period,
      axis: active.axis,
      instruction: active.payload as InstructionClassification,
      by: active.proposedBy,
      evidence: replyPermalink,
      trigger,
    });
    return { handled: "confirmed", applied: res.applied, intent: c.intent };
  }

  // Cancel the pending proposal.
  if (active && c.intent === "cancel") {
    const next = await settleProposal(active, "cancel");
    if (next !== "CANCELLED") return { handled: "noop", intent: c.intent };
    if (channel) {
      const text = `❌ Скасовано: ${active.summaryUk} — ${approverName}.`;
      await postMessage(
        channel.id,
        text,
        { key: instructionAckKey(entry.date, "cancel", contentRev(text)), feature: "instruction", channel: channel.name, trigger },
        entry.ts,
      );
    }
    return { handled: "cancelled", intent: c.intent };
  }

  // A fresh instruction → record PROPOSED (superseding any prior) + echo for confirmation.
  if (c.intent === "instruction" && c.axis) {
    const summary = renderProposalSummary(entry.date, c);
    const { created } = await createProposal({
      threadTs: entry.ts,
      channel: entry.channel,
      date: entry.date,
      axis: c.axis,
      payload: c,
      summaryUk: summary,
      proposedBy: approverName,
      sourceReplyTs: replyTs,
    });
    if (!created) return { handled: "noop", intent: c.intent }; // redelivery of the same reply
    if (channel) {
      const text = `📝 Зрозумів: ${summary}. Підтвердьте «так»/👍 або «ні».`;
      await postMessage(
        channel.id,
        text,
        { key: instructionAckKey(entry.date, "propose", contentRev(text)), feature: "instruction", channel: channel.name, trigger },
        entry.ts,
      );
    }
    return { handled: "proposed", intent: c.intent };
  }

  // unclear / question → stay silent (avoid thread noise).
  return { handled: "noop", intent: c.intent };
}
