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
import { after } from "next/server";
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
      const channelId = channel.id;
      const replyPermalink = permalinkFor(channelId, e.ts);
      const replyText = e.text ?? "";
      const userId = e.user;
      const threadTs = e.thread_ts;
      const replyTs = e.ts;

      // Defer the slow work (Neon lookup + Claude classify + Slack edit/ack) so
      // we ack Slack within its 3s window — otherwise Slack retries and can
      // disable delivery. `after` runs the callback once the response is sent.
      // The effect is idempotent, so the lost-on-error retry guarantee isn't
      // needed (the field-approvals/field-remember CLIs remain a backstop).
      after(async () => {
        try {
          // S7: an authorized approver overriding a published verdict.
          const pub = await findPublishedByTs(threadTs);
          if (pub && isApprover(userId)) {
            const approver = approverFor(userId)!;
            await applyApproverReply({
              entry: pub.entry,
              period: pub.period,
              replyText,
              approverName: approver.name,
              replyPermalink,
              replyTs,
            });
            return;
          }
          // S6: a reply to one of the bot's S5 questions.
          const ask = await findAskByTs(threadTs);
          if (ask) {
            await applyAnswerReply({
              record: ask.record,
              period: ask.period,
              replyText,
              replyPermalink,
            });
            return;
          }
          // Reached only for a thread reply in a tracked channel that matches
          // neither a published verdict nor a bot question — log it (low volume;
          // e.g. a verdict published before the Postgres migration has no row).
          console.log(
            `slack events: no published verdict or ask for thread_ts=${threadTs} (reply by ${userId} in #${channel.name}) — ignoring`,
          );
        } catch (err) {
          console.error("slack events handler failed:", err);
        }
      });
    }
  }

  return new Response("ok"); // ack immediately; the work runs in after()
}
