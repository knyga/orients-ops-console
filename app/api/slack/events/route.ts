/**
 * Slack Events API webhook — the bot's automatic reaction. Slack POSTs every
 * subscribed event here; we verify the signature and (for a thread reply in a
 * tracked channel) run the SAME S6/S7 effect the `field-remember` /
 * `field-approvals` CLIs run — only event-triggered.
 *
 * Routing for a thread reply (thread_ts = the bot's verdict/question ts):
 *   - reply under a published verdict, BY an authorized approver → applyApproverReply (S7)
 *   - reply under a bot question                                  → applyAnswerReply  (S6)
 *
 * The effect runs INLINE (awaited before the response). It's a Neon lookup +
 * one Claude classify + Slack edit/ack (~2-3s); Next's `after()` proved
 * unreliable on Vercel (the deferred work silently didn't run), so we do the
 * work synchronously. The whole flow is idempotent (override marker / ask-state
 * guards), so if the ack ever exceeds Slack's 3s window the retry is a no-op.
 *
 * The 200 response carries a small diagnostic body (handled / applied / error).
 * Slack only checks the 2xx status and ignores the body; it lets an operator
 * probing the endpoint see the outcome directly. SERVER-ONLY route.
 */
import { verifySlackSignature } from "@/lib/slackSignature";
import { TRACKED_CHANNELS } from "@/lib/slackChannels";
import { findPublishedByTs } from "@/lib/published";
import { findAskByTs } from "@/lib/asks";
import { approverFor, isApprover } from "@/lib/approvers";
import { applyApproverReply } from "@/lib/applyApproval";
import { applyAnswerReply } from "@/lib/applyAnswer";
import { permalinkFor } from "@/lib/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minimal shape of the Slack event envelope + message event we consume. */
interface SlackEventBody {
  type?: string;
  challenge?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    channel?: string;
  };
}

/** Always a 2xx for Slack; the JSON body is diagnostic (Slack ignores it). */
function ack(detail: Record<string, unknown>): Response {
  return Response.json({ ok: true, ...detail });
}

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text(); // raw body is required for signature verification
  console.log("slack events: POST received");

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error("slack events: SLACK_SIGNING_SECRET not set");
    return new Response("server not configured", { status: 500 });
  }
  const okSig = verifySlackSignature({
    signingSecret,
    signature: req.headers.get("x-slack-signature"),
    timestamp: req.headers.get("x-slack-request-timestamp"),
    rawBody: raw,
    nowSec: Math.floor(Date.now() / 1000),
  });
  if (!okSig) {
    console.warn("slack events: signature verification FAILED");
    return new Response("bad signature", { status: 401 });
  }

  let body: SlackEventBody;
  try {
    body = JSON.parse(raw) as SlackEventBody;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  if (body.type === "url_verification") {
    return Response.json({ challenge: body.challenge });
  }
  if (body.type !== "event_callback") return ack({ skipped: "not-event-callback" });

  const e = body.event;
  console.log(
    `slack events: event type=${e?.type} subtype=${e?.subtype ?? "-"} bot=${e?.bot_id ?? "-"} user=${e?.user ?? "-"} ch=${e?.channel ?? "-"} thread_ts=${e?.thread_ts ?? "-"} ts=${e?.ts ?? "-"}`,
  );

  // Only human thread REPLIES in a tracked channel.
  if (
    !(
      e?.type === "message" &&
      !e.subtype &&
      !e.bot_id &&
      e.user &&
      e.ts &&
      e.thread_ts &&
      e.thread_ts !== e.ts &&
      e.channel
    )
  ) {
    return ack({ skipped: "filter" });
  }

  const channel = TRACKED_CHANNELS.find((c) => c.id === e.channel);
  if (!channel) return ack({ skipped: "untracked-channel", channel: e.channel });

  const replyPermalink = permalinkFor(channel.id, e.ts);
  const replyText = e.text ?? "";
  const userId = e.user;
  const threadTs = e.thread_ts;
  const replyTs = e.ts;

  try {
    // S7: an authorized approver overriding a published verdict.
    const pub = await findPublishedByTs(threadTs);
    console.log(`slack events: findPublishedByTs → ${pub ? pub.entry.date : "null"}; isApprover(${userId})=${isApprover(userId)}`);
    if (pub && isApprover(userId)) {
      const approver = approverFor(userId)!;
      const result = await applyApproverReply({
        entry: pub.entry,
        period: pub.period,
        replyText,
        approverName: approver.name,
        replyPermalink,
        replyTs,
      });
      console.log(`slack events: applyApproverReply → applied=${result.applied} alreadyAcked=${result.alreadyAcked}`);
      return ack({ handled: "approver", date: pub.entry.date, ...result });
    }

    // S6: a reply to one of the bot's S5 questions.
    const ask = await findAskByTs(threadTs);
    if (ask) {
      await applyAnswerReply({ record: ask.record, period: ask.period, replyText, replyPermalink });
      console.log(`slack events: applyAnswerReply done for ${ask.record.date}`);
      return ack({ handled: "answer", date: ask.record.date });
    }

    // A tracked-channel thread reply matching neither a verdict nor a question.
    console.log(`slack events: no published verdict or ask for thread_ts=${threadTs} (reply by ${userId} in #${channel.name})`);
    return ack({ handled: "none", thread_ts: threadTs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("slack events handler failed:", err);
    return ack({ error: message });
  }
}
