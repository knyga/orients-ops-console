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
import { mentionize } from "./mention";
import { createProposal, readActiveProposals, settleProposal } from "./proposals";
import { renderProposalSummary } from "./proposalSummary";
import { postMessage } from "./slack";
import { contentRev, instructionAckKey, type SendTrigger } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { reportKey } from "./fieldDayVerdict";
import { findPublishedByTs, type PublishedEntry } from "./published";
import type { InstructionClassification } from "./instructionClassifyPrompt";
import type { Period } from "./period";
import type { Proposal, ProposalOrigin } from "./proposals";

export interface InstructionReplyResult {
  handled: "confirmed" | "cancelled" | "proposed" | "noop";
  applied?: boolean;
  intent?: string;
  /** Summaries of confirmed proposals whose apply threw (posted in-thread, never silently lost). */
  failed?: string[];
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

export interface ClassifiedInstructionArgs extends Omit<InstructionReplyArgs, "replyText"> {
  classification: InstructionClassification;
  pending: Proposal[];
  /** Who raised a NEW proposal from this reply; default "approver". */
  origin?: ProposalOrigin;
}

export async function applyInstructionReply(args: InstructionReplyArgs): Promise<InstructionReplyResult> {
  const { entry, replyText } = args;
  const pending = await readActiveProposals(entry.ts); // oldest first, possibly several axes
  const pendingEcho = pending.length ? pending.map((p) => p.summaryUk).join("; ") : null;
  const c = await classifyInstruction(entry.text, replyText, pendingEcho);
  return applyClassifiedInstruction({ ...args, classification: c, pending });
}

export async function applyClassifiedInstruction(args: ClassifiedInstructionArgs): Promise<InstructionReplyResult> {
  const { entry, period, approverName, replyPermalink, replyTs, trigger = "webhook", classification: c, pending, origin = "approver" } = args;
  const channel = TRACKED_CHANNELS.find((ch) => ch.name === entry.channel);

  // Confirm → apply EVERY pending proposal (day accept + crew fix + … stack up under one «так»).
  if (pending.length && c.intent === "confirm") {
    let applied = false;
    let settledAny = false;
    const failed: { summary: string; reason: string }[] = [];
    // Each apply rebuilds the Slack message from `entry.text` and rewrites
    // `published`; the next sibling must build on the RESULT, not on the
    // entry this reply arrived with (a day amendment followed by a crew edit
    // would otherwise restore the un-amended text).
    let current: PublishedEntry = entry;
    for (const p of pending) {
      const next = await settleProposal(p, "confirm");
      if (next !== "CONFIRMED") continue; // already settled (redelivery)
      settledAny = true;
      // One sibling's failure must not block the others, nor vanish: it is
      // CONFIRMED in the store already, so the only trace left is this note.
      try {
        const res = await applyInstruction({
          entry: current,
          period,
          axis: p.axis,
          instruction: p.payload as InstructionClassification,
          by: p.origin === "pilot" ? approverName : p.proposedBy,
          evidence: replyPermalink,
          trigger,
          // The instructing reply's ts: a re-instruction of an earlier state
          // (accept → reject → accept) must re-edit + re-ack, not dedup against
          // the first send; a redelivered confirm never reaches here (settled).
          salt: p.sourceReplyTs,
        });
        applied = applied || res.applied;
      } catch (err) {
        failed.push({ summary: p.summaryUk, reason: err instanceof Error ? err.message : String(err) });
      }
      if (pending.length > 1) {
        const fresh = await findPublishedByTs(entry.ts).catch(() => null);
        if (fresh) current = fresh.entry;
      }
    }
    if (!settledAny) return { handled: "noop", intent: c.intent };
    if (failed.length && channel) {
      const text = `❌ Не вдалося застосувати: ${failed.map((f) => `${f.summary} — ${f.reason}`).join("; ")}. Повторіть інструкцію.`;
      await postMessage(
        channel.id,
        text,
        { key: instructionAckKey(reportKey(entry.date, entry.reportTs), "apply-failed", replyTs), feature: "instruction", channel: channel.name, trigger },
        entry.ts,
      );
    }
    return { handled: "confirmed", applied, intent: c.intent, ...(failed.length ? { failed: failed.map((f) => f.summary) } : {}) };
  }

  // Cancel → every pending proposal, one note.
  if (pending.length && c.intent === "cancel") {
    const cancelled = [];
    for (const p of pending) if ((await settleProposal(p, "cancel")) === "CANCELLED") cancelled.push(p);
    if (cancelled.length === 0) return { handled: "noop", intent: c.intent };
    if (channel) {
      const text = `❌ Скасовано: ${cancelled.map((p) => p.summaryUk).join("; ")} — ${mentionize(approverName)}.`;
      await postMessage(
        channel.id,
        text,
        { key: instructionAckKey(reportKey(entry.date, entry.reportTs), "cancel", replyTs), feature: "instruction", channel: channel.name, trigger },
        entry.ts,
      );
    }
    return { handled: "cancelled", intent: c.intent };
  }

  // A fresh instruction → record PROPOSED (superseding a prior one on the SAME axis only) + echo for confirmation.
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
      origin,
      sourceReplyTs: replyTs,
    });
    if (!created) return { handled: "noop", intent: c.intent }; // redelivery of the same reply
    if (channel) {
      // Other-axis proposals stay pending; name them so the approver knows one «так» covers all.
      const stillPending = pending.filter((p) => p.axis !== c.axis).map((p) => p.summaryUk);
      const also = stillPending.length ? ` Разом із: ${stillPending.join("; ")}.` : "";
      // Keyed by the instructing reply's ts, NOT the echo text: the same summary
      // re-proposed later (accept → reject → accept) renders byte-identical text,
      // and a content key made the second echo dedup into silence (2026-09-04).
      // A redelivery of this reply is already stopped above (`created` false).
      const text = `📝 Зрозумів: ${summary}.${also} Підтвердьте «так»/👍 або «ні».`;
      await postMessage(
        channel.id,
        text,
        { key: instructionAckKey(reportKey(entry.date, entry.reportTs), "propose", replyTs), feature: "instruction", channel: channel.name, trigger },
        entry.ts,
      );
    }
    return { handled: "proposed", intent: c.intent };
  }

  // unclear / question → stay silent (avoid thread noise).
  return { handled: "noop", intent: c.intent };
}
