/**
 * Write-capable Slack agent turn (Phase C.2). Runs the Phase-B loop with the FULL
 * tool set (read + proposal-gated writes) and seeded DM history; returns the
 * structured AgentResult (text | proposal | error). Fails loud on a missing key.
 * The read-only sibling (@mention) stays in lib/agent/slackAgent.askAgent.
 * SERVER-ONLY reachable. Tests mock ./loop.
 */
import { runAgent, type AgentResult } from "./loop";
import { jiraTools } from "./tools/jira";
import type { Turn } from "@/lib/agentThread";

const SLACK_MAX_ITERS = 6;

export async function runSlackTurn(
  text: string,
  history: Turn[],
  opts: { sourceUrl?: string } = {},
): Promise<AgentResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set on the server.");
  }
  return runAgent(text, { tools: jiraTools, maxIters: SLACK_MAX_ITERS, history, sourceUrl: opts.sourceUrl });
}
