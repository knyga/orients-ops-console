/**
 * Internal self-invoke runner (Phase C.2). NOT called by Slack — only fire-and-forget
 * from the events webhook, authed by AGENT_RUN_SECRET. Runs the agent loop off the
 * request path (Slack's 3s ack is respected by the webhook), then edits the
 * `🤔 думаю…` placeholder with the answer / proposal echo. Both DM and @mention turns
 * use the write-capable loop + memory, keyed by `conversationKey` (DM → channelId;
 * @mention → thread_ts) — but always post/edit via the real `channelId`. SERVER-ONLY
 * route.
 */
import { runSlackTurn } from "@/lib/agent/slackTurn";
import { markdownToMrkdwn } from "@/lib/mrkdwn";
import { loadTranscript, appendTurn } from "@/lib/agentThread";
import { insertPending } from "@/lib/agentProposals";
import { updateMessage } from "@/lib/slack";
import { agentReplyKey } from "@/lib/outboundKeys";
import type { ProposalKind } from "@/lib/proposalExecutor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The agent loop budgets ~50s for itself (lib/agent/loop.ts BUDGET_MS); without
// an explicit maxDuration Vercel applies the plan default and can kill the
// function mid-loop, freezing the «думаю…» placeholder before the catch block
// gets to edit it. 60 is the Hobby cap, matching the cron routes.
export const maxDuration = 60;

interface RunBody {
  surface: "dm" | "mention";
  conversationKey: string; // DM → channelId; @mention → thread_ts
  channelId: string;       // real Slack channel (for posting/editing)
  userId: string;
  incomingTs: string;
  placeholderTs: string;
  threadTs?: string;
  question: string;
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.AGENT_RUN_SECRET;
  if (!secret || req.headers.get("x-agent-secret") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = (await req.json()) as RunBody;
  const meta = {
    key: agentReplyKey(body.userId, `${body.incomingTs}:run`),
    feature: "agent",
    channel: body.surface,
    trigger: "webhook" as const,
  };

  try {
    const history = await loadTranscript(body.conversationKey);
    const result = await runSlackTurn(body.question, history);
    if (result.kind === "proposal" && result.proposal) {
      await updateMessage(body.channelId, body.placeholderTs, result.proposal.echoUk, meta);
      await insertPending({
        channelId: body.conversationKey,
        kind: result.proposal.kind as ProposalKind,
        params: result.proposal.params,
        summaryUk: result.proposal.echoUk,
        proposedBy: body.userId,
      });
      await appendTurn(body.conversationKey, body.question, result.proposal.echoUk);
      return Response.json({ ok: true, surface: body.surface, proposal: result.proposal.kind });
    }
    // The model writes GitHub markdown; Slack renders mrkdwn — convert at this boundary.
    const answer = markdownToMrkdwn(result.text.trim()) || "Не маю відповіді на це.";
    await updateMessage(body.channelId, body.placeholderTs, answer, meta);
    await appendTurn(body.conversationKey, body.question, answer);
    return Response.json({ ok: true, surface: body.surface });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("agent run failed:", err);
    const uaError = /ANTHROPIC_API_KEY/.test(message)
      ? "Помилка: на сервері не налаштований ключ ANTHROPIC_API_KEY."
      : "Сталася помилка під час обробки запиту.";
    try {
      await updateMessage(body.channelId, body.placeholderTs, uaError, meta);
    } catch (editErr) {
      console.error("agent run: placeholder edit failed:", editErr);
    }
    return Response.json({ ok: true, error: message });
  }
}
