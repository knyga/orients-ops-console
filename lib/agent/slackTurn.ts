/**
 * Write-capable Slack agent turn (Phase C.2). Runs the Phase-B loop with the FULL
 * tool set (read + proposal-gated writes) and seeded DM history; returns the
 * structured AgentResult (text | proposal | error). Fails loud on a missing key.
 * The read-only sibling (@mention) stays in lib/agent/slackAgent.askAgent.
 * SERVER-ONLY reachable. Tests mock ./loop.
 */
import { runAgent, type AgentResult } from "./loop";
import { isFakeConfirmAsk, FAKE_CONFIRM_CORRECTION_UK } from "./fakeConfirm";
import type { Turn } from "@/lib/agentThread";

const SLACK_MAX_ITERS = 6;

export async function runSlackTurn(
  text: string,
  history: Turn[],
  opts: { sourceUrl?: string; channelId?: string; threadTs?: string } = {},
): Promise<AgentResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set on the server.");
  }
  // No `tools:` override — this picks up runAgent's default FULL tool set
  // (jiraTools + fieldLossTools + calendarTools), keeping Slack in sync with
  // the loop default permanently.
  const base = {
    maxIters: SLACK_MAX_ITERS,
    history,
    sourceUrl: opts.sourceUrl,
    channelId: opts.channelId,
    threadTs: opts.threadTs,
  };
  const result = await runAgent(text, base);
  // A TEXT answer that reads like a confirm ask is a hallucinated proposal —
  // no write tool was called, so a «так» on it dies silently (2026-09-01,
  // ATP-1891). One corrective retry demands the real tool call; the fake
  // exchange rides along as history so the retry keeps full context. Never
  // loops: a second fake falls through to the run route's warning stamp.
  if (result.kind !== "text" || !isFakeConfirmAsk(result.text)) return result;
  try {
    const retry = await runAgent(FAKE_CONFIRM_CORRECTION_UK, {
      ...base,
      history: [...history, { role: "user", text }, { role: "assistant", text: result.text }],
    });
    if (retry.kind === "proposal") return retry;
    if (retry.kind === "text" && !isFakeConfirmAsk(retry.text)) return retry;
  } catch (err) {
    console.error("slackTurn: fake-confirm retry failed:", err);
  }
  return result;
}
