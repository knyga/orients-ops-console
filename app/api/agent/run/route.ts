/**
 * Internal self-invoke runner (Phase C.2). NOT called by Slack — only fire-and-forget
 * from the events webhook, authed by AGENT_RUN_SECRET. Runs the agent loop off the
 * request path (Slack's 3s ack is respected by the webhook), then edits the
 * `🤔 думаю…` placeholder with the answer / proposal echo. DM turns use the
 * write-capable loop + memory; @mention is read-only. SERVER-ONLY route.
 */
import { runSlackTurn } from "@/lib/agent/slackTurn";
import { askAgent } from "@/lib/agent/slackAgent";
import { loadTranscript, appendTurn } from "@/lib/agentThread";
import { insertPending } from "@/lib/agentProposals";
import { updateMessage } from "@/lib/slack";
import { agentReplyKey } from "@/lib/outboundKeys";
import type { ProposalKind } from "@/lib/proposalExecutor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RunBody {
  surface: "dm" | "mention";
  channelId: string;
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
    if (body.surface === "mention") {
      const answer = await askAgent(body.question);
      await updateMessage(body.channelId, body.placeholderTs, answer, meta);
      return Response.json({ ok: true, surface: "mention" });
    }
    const history = await loadTranscript(body.channelId);
    const result = await runSlackTurn(body.question, history);
    if (result.kind === "proposal" && result.proposal) {
      await updateMessage(
        body.channelId,
        body.placeholderTs,
        result.proposal.echoUk,
        meta,
      );
      await insertPending({
        channelId: body.channelId,
        kind: result.proposal.kind as ProposalKind,
        params: result.proposal.params,
        summaryUk: result.proposal.echoUk,
        proposedBy: body.userId,
      });
      await appendTurn(
        body.channelId,
        body.question,
        result.proposal.echoUk,
      );
      return Response.json({
        ok: true,
        surface: "dm",
        proposal: result.proposal.kind,
      });
    }
    const answer = result.text.trim() || "Не маю відповіді на це.";
    await updateMessage(body.channelId, body.placeholderTs, answer, meta);
    await appendTurn(body.channelId, body.question, answer);
    return Response.json({ ok: true, surface: "dm" });
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
