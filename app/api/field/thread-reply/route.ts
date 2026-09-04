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
  // Parsed INSIDE the try so a malformed body is reported the same way as a
  // failed run (and never throws an unhandled 500 at the fire-and-forget caller).
  let body: Body | null = null;
  try {
    body = (await req.json()) as Body;
    const r = await runDeferredWork(body.work, { placeholderTs: body.placeholderTs });
    return Response.json({ ok: true, outcome: r.outcome });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("thread-reply work failed:", err);
    if (!body) return Response.json({ ok: false, error: message });
    const { work, placeholderTs } = body;
    const entry = targetEntry(work.target);
    const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
    // Fixed Ukrainian text — the raw error message stays in the server log. Only
    // PRE-deliver failures reach here (runDeferredWork swallows everything after
    // the result is posted), so overwriting the placeholder is safe.
    const uk = work.kind === "verify"
      ? "❌ Не вдалося перевірити — спробуйте пізніше або напишіть затверджувачам."
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
    return Response.json({ ok: false, error: message });
  }
}
