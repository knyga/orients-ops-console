/**
 * Slack Events API webhook — the bot's automatic reaction. Slack POSTs every
 * subscribed event here; we verify the signature, ack within Slack's 3s window,
 * and (for a thread reply in a tracked channel) run the SAME S6/S7 effect the
 * `field-remember` / `field-approvals` CLIs run — only event-triggered.
 *
 * Routing for a thread reply (thread_ts = the bot's verdict/question ts):
 *   - reply under a published verdict, BY an authorized approver → applyApproverReply (S7)
 *   - reply under a bot question                                  → applyAnswerReply  (S6)
 *
 * Idempotent: the override marker / ask-state guards make Slack's at-least-once
 * re-delivery a no-op. SERVER-ONLY route (token + Claude live here, never browser).
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

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text(); // raw body is required for signature verification

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    // Misconfiguration, not a client error — fail closed.
    return new Response("server not configured", { status: 500 });
  }
  const ok = verifySlackSignature({
    signingSecret,
    signature: req.headers.get("x-slack-signature"),
    timestamp: req.headers.get("x-slack-request-timestamp"),
    rawBody: raw,
    nowSec: Math.floor(Date.now() / 1000),
  });
  if (!ok) return new Response("bad signature", { status: 401 });

  let body: SlackEventBody;
  try {
    body = JSON.parse(raw) as SlackEventBody;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Slack's one-time endpoint handshake.
  if (body.type === "url_verification") {
    return Response.json({ challenge: body.challenge });
  }
  if (body.type !== "event_callback") return new Response("ok");

  const e = body.event;
  // Only human thread REPLIES in a tracked channel: a message with a thread_ts
  // pointing at a different (parent) ts, authored by a user, no edit/delete
  // subtype, and not the bot's own post (avoid reacting to our own acks).
  if (
    e?.type === "message" &&
    !e.subtype &&
    !e.bot_id &&
    e.user &&
    e.ts &&
    e.thread_ts &&
    e.thread_ts !== e.ts &&
    e.channel
  ) {
    const channel = TRACKED_CHANNELS.find((c) => c.id === e.channel);
    if (channel) {
      const replyPermalink = permalinkFor(channel.id, e.ts);
      const replyText = e.text ?? "";

      // S7: an authorized approver overriding a published verdict.
      const pub = await findPublishedByTs(e.thread_ts);
      if (pub && isApprover(e.user)) {
        const approver = approverFor(e.user)!;
        await applyApproverReply({
          entry: pub.entry,
          period: pub.period,
          replyText,
          approverName: approver.name,
          replyPermalink,
          replyTs: e.ts,
        });
      } else {
        // S6: a reply to one of the bot's S5 questions.
        const ask = await findAskByTs(e.thread_ts);
        if (ask) {
          await applyAnswerReply({
            record: ask.record,
            period: ask.period,
            replyText,
            replyPermalink,
          });
        }
      }
    }
  }

  return new Response("ok"); // ack fast; the work above is one Claude call (~1–2s)
}
