/**
 * Per-user occupation summaries via Claude. SERVER-ONLY.
 *
 * Reads ANTHROPIC_API_KEY from process.env and never exposes it to the browser
 * — same discipline as lib/jira.ts / lib/vimeo.ts. The `server-only` import
 * makes an accidental client import a build error. Only the CLI's `--summarize`
 * path uses this; the web/API surface does not.
 *
 * One Messages API call per user (small fan-out: a handful of users per period).
 * Uses claude-opus-4-8, the default model.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { UserTickets } from "./jiraStats";
import { buildOccupationPrompt } from "./occupationPrompt";

const MODEL = "claude-opus-4-8";

export class SummarizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummarizeError";
  }
}

/**
 * Summarize each user's occupation from the titles of their resolved issues.
 * Returns a map keyed by accountId → summary text (matching UserRow.accountId so
 * toCsv can look it up directly). The Unassigned bucket (accountId null) is
 * skipped — there's no single person to describe.
 */
export async function summarizeOccupations(
  users: UserTickets[],
): Promise<Map<string | null, string>> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new SummarizeError(
      "ANTHROPIC_API_KEY is not set on the server (needed for --summarize).",
    );
  }

  const client = new Anthropic();
  const summaries = new Map<string | null, string>();

  for (const user of users) {
    if (user.accountId === null) continue; // skip the Unassigned bucket

    let message;
    try {
      message = await client.messages.create({
        model: MODEL,
        max_tokens: 512,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: buildOccupationPrompt(user) }],
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SummarizeError(`Claude request failed for ${user.displayName}: ${detail}`);
    }

    if (message.stop_reason === "refusal") {
      summaries.set(user.accountId, "(summary unavailable — request was declined)");
      continue;
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    summaries.set(user.accountId, text);
  }

  return summaries;
}
