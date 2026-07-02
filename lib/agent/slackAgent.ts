/**
 * Slack-facing wrapper over the Phase-B agent loop. Runs the loop with ONLY read
 * tools (Slack C.1 is read-only — no confirm-first writes yet) and a bounded
 * iteration count, and fails loud when ANTHROPIC_API_KEY is missing (the console
 * has been bitten by a silent no-op when this env var is absent on Vercel).
 *
 * SERVER-ONLY reachable (loop + tools read env). Tests mock ./loop.
 */
import { runAgent } from "./loop";
import { jiraTools } from "./tools/jira";

/** Slack answers use a slightly tighter iteration bound than the CLI default. */
const SLACK_MAX_ITERS = 6;

export async function askAgent(text: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set on the server.");
  }
  const readTools = jiraTools.filter((t) => t.kind === "read");
  const result = await runAgent(text, { tools: readTools, maxIters: SLACK_MAX_ITERS });
  return result.text;
}
