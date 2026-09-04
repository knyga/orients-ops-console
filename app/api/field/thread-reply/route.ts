/**
 * Internal deferred runner for verdict/ask thread replies (pilot evidence
 * autonomy). NOT called by Slack — fire-and-forget from the events webhook,
 * authed by AGENT_RUN_SECRET (same contract as /api/agent/run). Runs the slow
 * work (live recompute / read-only chat) and edits the placeholder. SERVER-ONLY.
 */
import { runDeferredWork } from "@/lib/threadReplyWork";
import { targetEntry, type DeferredWork } from "@/lib/applyThreadReply";
import { updateMessage } from "@/lib/slack";
import { instructionAckKey } from "@/lib/outboundKeys";
import { TRACKED_CHANNELS } from "@/lib/slackChannels";
import { reportKey } from "@/lib/fieldDayVerdict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Body { work: DeferredWork; placeholderTs: string }

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.AGENT_RUN_SECRET;
  if (!secret || req.headers.get("x-agent-secret") !== secret) return new Response("unauthorized", { status: 401 });
  const { work, placeholderTs } = (await req.json()) as Body;
  try {
    const r = await runDeferredWork(work, { placeholderTs });
    return Response.json({ ok: true, outcome: r.outcome });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("thread-reply work failed:", err);
    const entry = targetEntry(work.target);
    const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
    const uk = work.kind === "verify"
      ? `❌ Не вдалося перевірити: ${message}. Спробуйте пізніше або напишіть затверджувачам.`
      : "Сталася помилка під час обробки запиту.";
    if (channel) {
      try {
        await updateMessage(channel.id, placeholderTs, uk, {
          key: instructionAckKey(reportKey(entry.date, entry.reportTs), `${work.kind}-failed`, work.replyTs), feature: "evidence", channel: channel.name, trigger: work.trigger,
        });
      } catch (editErr) {
        console.error("thread-reply work: placeholder edit failed:", editErr);
      }
    }
    return Response.json({ ok: true, error: message });
  }
}
