/**
 * The slow half of the thread-reply handler (pilot evidence autonomy): verify
 * (live recompute) and chat (read-only agent). Runs OFF the webhook request —
 * from /api/field/thread-reply behind a placeholder — or inline from the CLI
 * twin with no placeholder (then it posts into the thread). SERVER-ONLY.
 */
import "server-only";
import { escalateClaim, targetEntry, type DeferredWork } from "./applyThreadReply";
import { verifyEvidence } from "./evidenceVerify";
import { runVerdictChat } from "./agent/verdictChat";
import { recordEvidenceEvent } from "./evidenceEvents";
import { postMessage, updateMessage } from "./slack";
import { chunkForSlack } from "./slackChunk";
import { instructionAckKey } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { reportKey } from "./fieldDayVerdict";

export const PLACEHOLDER_UK: Record<DeferredWork["kind"], string> = { verify: "🔎 Перевіряю…", chat: "💬 Думаю…" };

export function workPlaceholderKey(work: DeferredWork): string {
  const e = targetEntry(work.target);
  return instructionAckKey(reportKey(e.date, e.reportTs), `${work.kind}-ph`, work.replyTs);
}

export async function runDeferredWork(
  work: DeferredWork,
  opts: { placeholderTs?: string; onLog?: (m: string) => void },
): Promise<{ outcome: string; text: string }> {
  const entry = targetEntry(work.target);
  const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
  if (!channel) throw new Error(`thread-reply work: untracked channel "${entry.channel}"`);
  const meta = { key: instructionAckKey(reportKey(entry.date, entry.reportTs), work.kind, work.replyTs), feature: "evidence", channel: channel.name, trigger: work.trigger };

  /** Edit the placeholder (or post) with the first chunk; overflow threads under the root. */
  const deliver = async (text: string): Promise<void> => {
    const chunks = chunkForSlack(text);
    if (opts.placeholderTs) {
      const ts = await updateMessage(channel.id, opts.placeholderTs, chunks[0], meta);
      if (!ts) throw new Error("thread-reply work: placeholder edit was skipped (stuck pending row)");
    } else {
      await postMessage(channel.id, chunks[0], meta, entry.ts);
    }
    for (let i = 1; i < chunks.length; i++) await postMessage(channel.id, chunks[i], { ...meta, key: `${meta.key}:${i + 1}` }, entry.ts);
  };

  if (work.kind === "verify") {
    const r = await verifyEvidence({ date: entry.date, reportTs: entry.reportTs, period: work.target.period, hints: work.hints, byName: work.userName, trigger: work.trigger, onLog: opts.onLog });
    await deliver(r.text);
    if (r.outcome !== "closed" && work.claim) {
      await escalateClaim({
        target: work.target, claim: work.claim, userName: work.userName, userId: work.userId, role: work.role, replyTs: work.replyTs, trigger: work.trigger,
        verifyLine: r.verifyLine, statusBefore: r.statusBefore, statusAfter: r.statusAfter,
      });
    } else {
      await recordEvidenceEvent({
        threadTs: entry.ts, channel: entry.channel, date: entry.date, reportTs: entry.reportTs, byUserId: work.userId, byName: work.userName, role: work.role,
        kind: "evidence", evidence: { hints: work.hints, claim: work.claim ?? null }, outcome: r.outcome, statusBefore: r.statusBefore, statusAfter: r.statusAfter,
        sourceReplyTs: work.replyTs, proposalId: null,
      });
    }
    return { outcome: r.outcome, text: r.text };
  }

  const answer = await runVerdictChat({
    question: work.replyText, verdictText: entry.text, channelId: channel.id, threadTs: entry.ts,
    excludeTs: [work.replyTs, ...(opts.placeholderTs ? [opts.placeholderTs] : [])],
  });
  await deliver(answer);
  await recordEvidenceEvent({
    threadTs: entry.ts, channel: entry.channel, date: entry.date, reportTs: entry.reportTs, byUserId: work.userId, byName: work.userName, role: work.role,
    kind: "chat", evidence: null, outcome: "answered", statusBefore: null, statusAfter: null, sourceReplyTs: work.replyTs, proposalId: null,
  });
  return { outcome: "answered", text: answer };
}
