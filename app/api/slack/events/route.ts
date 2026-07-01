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
 * unreliable on Vercel, so we do the work synchronously. Each Slack event is
 * claimed by its `event_id` (lib/slackEventClaim) BEFORE any effect and
 * processed at most once, so Slack's at-least-once redelivery can never
 * re-classify or flip an already-decided day. The decision-keyed outbound dedup
 * (lib/outboundKeys) is a second layer on the resulting edit/ack.
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
import { permalinkFor, postMessage } from "@/lib/slack";
import { formatWebhookFailureNotice } from "@/lib/webhookNotice";
import { contentRev, webhookFailureKey } from "@/lib/outboundKeys";
import { parseSlackEvent, type SlackEventBody } from "@/lib/slackEventParse";
import { claimSlackEvent } from "@/lib/slackEventClaim";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Always a 2xx for Slack; the JSON body is diagnostic (Slack ignores it). */
function ack(detail: Record<string, unknown>): Response {
  return Response.json({ ok: true, ...detail });
}

/**
 * An actionable reply (an approver override / an answer) that we recognised but
 * could not apply because the effect threw. Surface it instead of swallowing it:
 * post a visible notice into the thread (best-effort — a failure to post must not
 * mask the original error) and log it. We still ack 200: a 5xx would make Slack
 * retry and, on sustained failure, DISABLE the subscription — silently breaking
 * every future event. A thread notice + log is the right signal for what is
 * almost always a config error (e.g. a missing server key) a human must fix.
 */
async function failVisibly(
  channel: { id: string; name: string },
  threadTs: string,
  kind: string,
  date: string,
  err: unknown,
): Promise<Response> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`slack events: ${kind} apply failed for ${date}:`, err);
  try {
    await postMessage(
      channel.id,
      formatWebhookFailureNotice(message),
      {
        key: webhookFailureKey(date, kind, contentRev(message)),
        feature: "webhook-failure",
        channel: channel.name,
        trigger: "webhook",
      },
      threadTs,
    );
  } catch (postErr) {
    console.error("slack events: failed to post failure notice:", postErr);
  }
  return ack({ handled: kind, date, error: message });
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

  const parsed = parseSlackEvent(body);
  if (parsed.kind === "challenge") return Response.json({ challenge: parsed.challenge });
  if (parsed.kind === "skip") return ack({ skipped: parsed.reason });

  const channel = TRACKED_CHANNELS.find((c) => c.id === parsed.channelId);
  if (!channel) return ack({ skipped: "untracked-channel", channel: parsed.channelId });

  // Event-id idempotency: Slack delivers at-least-once and retries any delivery
  // it doesn't see 2xx'd within 3s, reusing the same event_id. Claim it once
  // (atomic) so a redelivery never re-classifies and flips an already-decided
  // day. At-most-once: we keep the claim even if the effect below fails — a
  // transient failure recovers via the in-thread notice + a manual
  // `field-approvals` re-run, not via Slack's retry.
  if (parsed.eventId) {
    const fresh = await claimSlackEvent(parsed.eventId, new Date().toISOString(), {
      eventType: "message",
    });
    if (!fresh) {
      console.log(`slack events: duplicate event_id=${parsed.eventId} — skipping`);
      return ack({ skipped: "duplicate-event", event_id: parsed.eventId });
    }
  } else {
    console.warn("slack events: event_callback without event_id — processing without dedup");
  }

  const replyPermalink = permalinkFor(channel.id, parsed.replyTs);
  const replyText = parsed.replyText;
  const userId = parsed.userId;
  const threadTs = parsed.threadTs;
  const replyTs = parsed.replyTs;

  try {
    // S7: an authorized approver overriding a published verdict.
    const pub = await findPublishedByTs(threadTs);
    console.log(`slack events: findPublishedByTs → ${pub ? pub.entry.date : "null"}; isApprover(${userId})=${isApprover(userId)}`);
    if (pub && isApprover(userId)) {
      const approver = approverFor(userId)!;
      try {
        const result = await applyApproverReply({
          entry: pub.entry,
          period: pub.period,
          replyText,
          approverName: approver.name,
          replyPermalink,
          replyTs,
          trigger: "webhook",
        });
        console.log(`slack events: applyApproverReply → applied=${result.applied} alreadyAcked=${result.alreadyAcked}`);
        return ack({ handled: "approver", date: pub.entry.date, ...result });
      } catch (err) {
        // Recognised an approver override but couldn't apply it — make it visible.
        return await failVisibly(channel, threadTs, "approver", pub.entry.date, err);
      }
    }

    // S6: a reply to one of the bot's S5 questions.
    const ask = await findAskByTs(threadTs);
    if (ask) {
      try {
        await applyAnswerReply({ record: ask.record, period: ask.period, replyText, replyPermalink });
        console.log(`slack events: applyAnswerReply done for ${ask.record.date}`);
        return ack({ handled: "answer", date: ask.record.date });
      } catch (err) {
        return await failVisibly(channel, threadTs, "answer", ask.record.date, err);
      }
    }

    // A tracked-channel thread reply matching neither a verdict nor a question.
    console.log(`slack events: no published verdict or ask for thread_ts=${threadTs} (reply by ${userId} in #${channel.name})`);
    return ack({ handled: "none", thread_ts: threadTs });
  } catch (err) {
    // Backstop for an unexpected failure BEFORE we recognised an actionable reply
    // (e.g. the verdict/ask lookup itself threw). No thread notice here — we don't
    // know the reply was for us, and posting into an unrelated conversation would
    // be noise. Logged + 200; the per-action paths above own the visible notices.
    const message = err instanceof Error ? err.message : String(err);
    console.error("slack events handler failed:", err);
    return ack({ error: message });
  }
}
