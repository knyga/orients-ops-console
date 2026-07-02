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
 * The S6/S7 effect runs INLINE (awaited before the response). It's a Neon lookup +
 * one Claude classify + Slack edit/ack (~2-3s); Next's `after()` proved
 * unreliable on Vercel, so we do the work synchronously. Each Slack event is
 * claimed by its `event_id` (lib/slackEventClaim) BEFORE any effect and
 * processed at most once, so Slack's at-least-once redelivery can never
 * re-classify or flip an already-decided day. The decision-keyed outbound dedup
 * (lib/outboundKeys) is a second layer on the resulting edit/ack.
 *
 * The conversational agent (DM / @mention / a plain thread follow-up in a known
 * agent thread), Phase C.2, does NOT run inline: the loop can take well over
 * Slack's 3s ack budget, so the webhook only claims the event, posts a
 * `🤔 думаю…` placeholder, and fires a non-awaited self-invoke to
 * `/api/agent/run` (see `deferAgentTurn`) which does the real work and edits the
 * placeholder. A reply to a pending write proposal ("так"/"ні") is the
 * exception — that decision is a fast DB flip + Slack post, so it's handled
 * inline in `handleAgentConversation` without deferring. Outside a DM, only the
 * original proposer's reply can drive that decision (requester-gating); anyone
 * else's reply is silently ignored.
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
import { applyInstructionReply } from "@/lib/applyInstructionReply";
import { applyAnswerReply } from "@/lib/applyAnswer";
import { permalinkFor, postMessage } from "@/lib/slack";
import { formatWebhookFailureNotice } from "@/lib/webhookNotice";
import { formatDmHelp } from "@/lib/dmHelp";
import { isAllowedSlackUser, AGENT_REFUSAL_UK } from "@/lib/agent/access";
import { classifyDmReply } from "@/lib/agentDm";
import { readPendingProposal, claimApply, setState } from "@/lib/agentProposals";
import { applyProposal } from "@/lib/proposalExecutor";
import { selfOrigin } from "@/lib/selfOrigin";
import { contentRev, dmHelpKey, agentReplyKey, webhookFailureKey } from "@/lib/outboundKeys";
import { parseSlackEvent, stripBotMention, hasLeadingMention, type SlackEventBody } from "@/lib/slackEventParse";
import { claimSlackEvent } from "@/lib/slackEventClaim";
import { agentThreadExists } from "@/lib/agentThread";

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

/**
 * Post the `🤔 думаю…` placeholder and fire a non-awaited self-invoke to
 * `/api/agent/run`, which runs the (potentially slow) agent loop OFF the
 * request path and edits the placeholder with the real answer/proposal echo.
 * Returns the 200 ack immediately — Slack's 3s budget never sees the loop.
 * If the placeholder post itself fails, that's surfaced (still acked, per the
 * webhook's no-5xx contract) rather than silently deferring nothing. If
 * AGENT_RUN_SECRET is missing, we log loudly and still ack — the placeholder
 * stays visible in Slack rather than silently vanishing, which is the signal
 * an operator needs to notice the misconfiguration.
 *
 * `ts` is used only for the placeholder-post outbound key's uniqueness suffix;
 * `conversationKey` is the actual agent-memory/proposal key (DM → channelId,
 * @mention/thread → thread_ts) forwarded to `/api/agent/run`. `surface` "thread"
 * (a plain follow-up with no bot mention) is normalized to "mention" for the run
 * route, which only distinguishes DM vs. everything-else memory-keying.
 */
async function deferAgentTurn(
  req: Request,
  channelId: string,
  userId: string,
  question: string,
  ts: string,
  threadTs: string | undefined,
  surface: "dm" | "mention" | "thread",
  conversationKey: string,
): Promise<Response> {
  const runSurface = surface === "thread" ? "mention" : surface;
  let placeholderTs: string;
  try {
    placeholderTs = await postMessage(
      channelId,
      "🤔 думаю…",
      { key: agentReplyKey(userId, `${ts}:ph`), feature: "agent", channel: surface, trigger: "webhook" },
      threadTs,
    );
  } catch (err) {
    console.error("slack events: placeholder post failed:", err);
    return ack({ handled: "agent", error: "placeholder-failed" });
  }
  const secret = process.env.AGENT_RUN_SECRET;
  if (secret) {
    void fetch(`${selfOrigin(req)}/api/agent/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-secret": secret },
      body: JSON.stringify({ surface: runSurface, conversationKey, channelId, userId, incomingTs: ts, placeholderTs, threadTs, question }),
    }).catch((err) => console.error("slack events: self-invoke failed:", err));
  } else {
    console.error("slack events: AGENT_RUN_SECRET not set — cannot dispatch agent turn");
  }
  return ack({ handled: "agent", surface, deferred: true });
}

interface AgentTurnInput {
  surface: "dm" | "mention" | "thread";
  conversationKey: string;
  channelId: string;
  threadTs: string | undefined;
  userId: string;
  text: string;
  eventId: string | null;
  incomingTs: string;
}

/**
 * Surface-agnostic agent ingress — DM, @mention, or a plain thread follow-up all
 * funnel through here. Claims the event (dedup), gates on the allowlist, then
 * checks for a PENDING write proposal keyed on `conversationKey`:
 *   - a pending proposal exists AND we're outside a DM AND the replier isn't the
 *     original proposer → ignore (requester-gated: only the proposer drives a
 *     channel/thread write, so a bystander's "так" can't hijack it).
 *   - "так" (confirm)         → atomically claim + apply, post the result. FAST (inline).
 *   - "ні" (cancel)           → mark CANCELLED, post an ack. FAST (inline).
 *   - anything else ("other") → supersede the pending proposal, post a notice, then
 *                                fall through to a NEW deferred turn.
 *   - no pending proposal     → defer a new turn directly.
 * Only the "start a new turn" paths defer (post a placeholder + self-invoke); the
 * confirm/cancel/supersede/ignore decisions themselves are fast DB + Slack calls
 * that comfortably fit inside Slack's 3s ack budget.
 */
async function handleAgentConversation(req: Request, inp: AgentTurnInput): Promise<Response> {
  if (inp.eventId) {
    const fresh = await claimSlackEvent(inp.eventId, new Date().toISOString(), { eventType: "message" });
    if (!fresh) return ack({ skipped: "duplicate-event", event_id: inp.eventId });
  }
  if (!isAllowedSlackUser(inp.userId)) {
    try {
      await postMessage(
        inp.channelId,
        AGENT_REFUSAL_UK,
        {
          key: agentReplyKey(inp.userId, inp.incomingTs),
          feature: "agent",
          channel: inp.surface,
          trigger: "webhook",
        },
        inp.threadTs,
      );
    } catch (err) {
      console.error("slack events: refusal post failed:", err);
    }
    return ack({ handled: "agent", refused: true, user: inp.userId });
  }

  const q = inp.text.trim();
  const pending = await readPendingProposal(inp.conversationKey);
  if (pending) {
    // Requester-gating: in a channel/thread, only the proposer drives the pending write.
    if (inp.surface !== "dm" && pending.proposedBy !== inp.userId) {
      return ack({ handled: "agent", ignored: "not-requester", user: inp.userId });
    }
    const decision = classifyDmReply(q);
    if (decision === "confirm") {
      const won = await claimApply(pending.id);
      const result = won ? await applyProposal(pending.kind, pending.params) : "Вже застосовано.";
      await postMessage(
        inp.channelId,
        result,
        { key: agentReplyKey(inp.userId, `${inp.incomingTs}:apply`), feature: "agent", channel: inp.surface, trigger: "webhook" },
        inp.threadTs,
      );
      return ack({ handled: "agent", applied: won });
    }
    if (decision === "cancel") {
      await setState(pending.id, "CANCELLED");
      await postMessage(
        inp.channelId,
        "Скасовано.",
        { key: agentReplyKey(inp.userId, `${inp.incomingTs}:cancel`), feature: "agent", channel: inp.surface, trigger: "webhook" },
        inp.threadTs,
      );
      return ack({ handled: "agent", cancelled: true });
    }
    // "other" → supersede the pending proposal, then fall through to a new turn.
    await setState(pending.id, "SUPERSEDED");
    await postMessage(
      inp.channelId,
      "Скасував попередню пропозицію, обробляю новий запит.",
      { key: agentReplyKey(inp.userId, `${inp.incomingTs}:supersede`), feature: "agent", channel: inp.surface, trigger: "webhook" },
      inp.threadTs,
    );
  }
  return deferAgentTurn(req, inp.channelId, inp.userId, q, inp.incomingTs, inp.threadTs, inp.surface, inp.conversationKey);
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

  // An @mention anywhere → the conversational agent (read-only in C.1). Handled
  // before the tracked-channel lookup because a mention can land in any channel.
  //
  // Slack delivers a channel @mention as TWO events (app_mention + message) with
  // distinct event_ids, so they do NOT dedup against each other. If the mention is
  // a reply under a published verdict / bot question thread, the sibling `message`
  // event already drives the S6/S7 handler below — so defer those here (skip the
  // agent) to avoid a spurious answer + wasted Claude call on an approver's confirm.
  if (parsed.kind === "mention") {
    if (parsed.threadTs !== parsed.ts) {
      let deferToThreadHandler = false;
      try {
        const [pub, ask] = await Promise.all([
          findPublishedByTs(parsed.threadTs),
          findAskByTs(parsed.threadTs),
        ]);
        deferToThreadHandler = Boolean(pub || ask);
      } catch (err) {
        console.error("slack events: mention verdict/ask lookup failed:", err);
      }
      if (deferToThreadHandler) {
        return ack({ skipped: "mention-in-verdict-or-ask-thread", thread_ts: parsed.threadTs });
      }
    }
    return await handleAgentConversation(req, {
      surface: "mention",
      conversationKey: parsed.threadTs, // thread_ts (== ts for a top-level mention)
      channelId: parsed.channelId,
      threadTs: parsed.threadTs,
      userId: parsed.userId,
      text: stripBotMention(parsed.text),
      eventId: parsed.eventId,
      incomingTs: parsed.ts,
    });
  }

  // A human DM to the bot → reply once with the help cheat sheet. Info-only (a DM
  // never mutates verdict data); handled before the tracked-channel lookup because
  // the DM channel is not a tracked channel. Keyed on the incoming ts so a Slack
  // redelivery dedups to one reply while a new DM re-replies. The bot's own reply
  // carries a bot_id, so the parser filters it — no echo loop.
  if (parsed.kind === "dm") {
    // A bare help request keeps the static cheat sheet; anything else goes to the
    // DM agent (C.2: confirm-first proposal state machine + deferred loop). The
    // agent path claims the event inside handleAgentConversation, so only the
    // help path claims here.
    const q = parsed.text.trim();
    const isHelp = q === "" || /^\/?(help|допомога)\??$/i.test(q);
    if (!isHelp) {
      return await handleAgentConversation(req, {
        surface: "dm",
        conversationKey: parsed.channelId,
        channelId: parsed.channelId,
        threadTs: undefined,
        userId: parsed.userId,
        text: parsed.text,
        eventId: parsed.eventId,
        incomingTs: parsed.ts,
      });
    }
    if (parsed.eventId) {
      const fresh = await claimSlackEvent(parsed.eventId, new Date().toISOString(), {
        eventType: "message",
      });
      if (!fresh) return ack({ skipped: "duplicate-event", event_id: parsed.eventId });
    }
    try {
      await postMessage(parsed.channelId, formatDmHelp(), {
        key: dmHelpKey(parsed.userId, parsed.ts),
        feature: "help",
        channel: "dm",
        trigger: "webhook",
      });
      console.log(`slack events: dm-help replied to ${parsed.userId} in ${parsed.channelId}`);
      return ack({ handled: "dm-help", user: parsed.userId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("slack events: dm-help post failed:", err);
      return ack({ handled: "dm-help", error: message });
    }
  }

  // A plain thread reply (no bot mention) — e.g. "так" / a follow-up — inside a
  // known agent conversation. The mention-sibling of an @mention leads with a
  // mention token and is handled by the mention branch, so skip those here to
  // avoid double-processing. Runs BEFORE the tracked-channel filter because an
  // agent thread can live in any channel (e.g. #issue-log needn't be tracked).
  //
  // INVARIANT: agent-thread keys and verdict/ask (S6/S7) thread ts never overlap
  // — `agent_threads` rows are created ONLY by `appendTurn` in /api/agent/run, so
  // a published-verdict/ask thread is never an agent thread and still reaches the
  // S7/S6 handlers below. If anything ever seeds agent_threads from a verdict
  // thread, this branch would shadow the approver path — keep that from happening.
  if (parsed.kind === "actionable" && !hasLeadingMention(parsed.replyText)) {
    let isAgent = false;
    try {
      isAgent = await agentThreadExists(parsed.threadTs);
    } catch (err) {
      console.error("slack events: agentThreadExists lookup failed:", err);
    }
    if (isAgent) {
      return await handleAgentConversation(req, {
        surface: "thread",
        conversationKey: parsed.threadTs,
        channelId: parsed.channelId,
        threadTs: parsed.threadTs,
        userId: parsed.userId,
        text: parsed.replyText,
        eventId: parsed.eventId,
        incomingTs: parsed.replyTs,
      });
    }
  }

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
    // S7 (confirm-first): an authorized approver instructing a data change on a
    // published verdict. The bot echoes the change and applies it ONLY once the
    // approver confirms in-thread (a question/comment is a silent no-op).
    const pub = await findPublishedByTs(threadTs);
    console.log(`slack events: findPublishedByTs → ${pub ? pub.entry.date : "null"}; isApprover(${userId})=${isApprover(userId)}`);
    if (pub && isApprover(userId)) {
      const approver = approverFor(userId)!;
      try {
        const result = await applyInstructionReply({
          entry: pub.entry,
          period: pub.period,
          replyText,
          approverName: approver.name,
          replyPermalink,
          replyTs,
          trigger: "webhook",
        });
        console.log(`slack events: applyInstructionReply → handled=${result.handled} applied=${result.applied ?? "-"} intent=${result.intent ?? "-"}`);
        return ack({ date: pub.entry.date, ...result });
      } catch (err) {
        // Recognised an approver instruction but couldn't classify/apply it —
        // make it visible (this fires loudly if ANTHROPIC_API_KEY is missing).
        return await failVisibly(channel, threadTs, "instruction", pub.entry.date, err);
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
