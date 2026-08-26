/**
 * Write-capable Slack agent turn (Phase C.2). Runs the Phase-B loop with the FULL
 * tool set (read + proposal-gated writes) and seeded DM history; returns the
 * structured AgentResult (text | proposal | error). Fails loud on a missing key.
 * The read-only sibling (@mention) stays in lib/agent/slackAgent.askAgent.
 * SERVER-ONLY reachable. Tests mock ./loop.
 */
import { runAgent, type AgentResult } from "./loop";
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
  return runAgent(text, {
    maxIters: SLACK_MAX_ITERS,
    history,
    sourceUrl: opts.sourceUrl,
    channelId: opts.channelId,
    threadTs: opts.threadTs,
  });
}
