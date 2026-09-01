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
import { updateMessage, postMessage, permalinkFor } from "@/lib/slack";
import { chunkForSlack } from "@/lib/slackChunk";
import { agentReplyKey } from "@/lib/outboundKeys";
import type { ProposalKind } from "@/lib/proposalExecutor";
import { fetchThreadContext } from "@/lib/agent/threadContext";
import { alertApprovers } from "@/lib/opsAlert";

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

  /**
   * Deliver `text` by editing the placeholder, splitting the overflow into
   * follow-up posts. Slack rejects texts over ~4000 UTF-8 bytes with
   * `msg_too_long` (bit the 2026-08-01 «список завершених задач» answers —
   * the edit threw and the catch below masked the whole turn as a generic
   * error), so a long answer MUST be chunked, never sent as one message.
   * Follow-ups thread under the incoming thread when there is one; in a
   * channel mention without a thread they thread under the placeholder
   * (keeps the channel tidy); in a DM they post top-level.
   */
  const deliver = async (text: string): Promise<void> => {
    const chunks = chunkForSlack(text);
    await updateMessage(body.channelId, body.placeholderTs, chunks[0], meta);
    const followUpThreadTs =
      body.threadTs ?? (body.surface === "dm" ? undefined : body.placeholderTs);
    for (let i = 1; i < chunks.length; i++) {
      await postMessage(
        body.channelId,
        chunks[i],
        { ...meta, key: `${meta.key}:${i + 1}` },
        followUpThreadTs,
      );
    }
  };

  try {
    const history = await loadTranscript(body.conversationKey);
    // A mention/thread turn carries threadTs: inject the surrounding thread as
    // context ("create a ticket from this thread"). Best-effort — a Slack
    // hiccup must not kill the turn. Memory (appendTurn) keeps the original.
    let question = body.question;
    if (body.threadTs) {
      try {
        const ctx = await fetchThreadContext(body.channelId, body.threadTs, [
          body.incomingTs,
          body.placeholderTs,
        ]);
        if (ctx) question = `${ctx}\n\n${body.question}`;
      } catch (err) {
        console.error("agent run: thread-context fetch failed:", err);
      }
    }
    // A thread turn carries the thread's permalink so a created ticket links
    // back to its source (attached to the proposal deterministically, not by
    // the model). Pure string build — works even when the context fetch failed.
    const sourceUrl = body.threadTs ? permalinkFor(body.channelId, body.threadTs) : undefined;
    // channelId + threadTs ride along so a thread-scoped write (sprint_plan_build)
    // can target the thread's anchor deterministically.
    const result = await runSlackTurn(question, history, {
      sourceUrl,
      channelId: body.channelId,
      threadTs: body.threadTs,
    });
    if (result.kind === "proposal" && result.proposal) {
      await deliver(result.proposal.echoUk);
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
    let answer = markdownToMrkdwn(result.text.trim()) || "Не маю відповіді на це.";
    // A TEXT answer that reads like a confirmation ask is a hallucinated
    // proposal — no PENDING row exists, so a «так» on it dies silently (bit us
    // 2026-09-01 on ATP-1891). The prompt forbids it; prompts are not
    // enforcement, so the surface stamps a deterministic warning on top.
    if (/\(так\s*\/\s*ні\)|(продовжити|підтвердити|створити|додати)\s*\?\s*$/iu.test(answer)) {
      answer +=
        "\n\n⚠️ Це лише текст, не пропозиція: жодної дії не заплановано, «так» нічого не виконає. Згадайте мене із запитом ще раз.";
    }
    await deliver(answer);
    await appendTurn(body.conversationKey, body.question, answer);
    return Response.json({ ok: true, surface: body.surface });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("agent run failed:", err);
    // The user only sees a generic «Сталася помилка» — the approvers need to
    // know the bot is broken (e.g. a dead Jira token). Best-effort, deduped
    // per error class per day inside alertApprovers.
    await alertApprovers(err, "agent-run", "webhook");
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
