/**
 * The one Claude call that narrates the week's numbers into the investor
 * summary paragraph. SERVER-ONLY (needs ANTHROPIC_API_KEY). Soft-fails by
 * design: any error returns the deterministic fallback — the weekly draft is
 * human-edited in #general anyway, so a degraded summary must never block it.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { buildInvestorPrompt, fallbackSummary, type InvestorWeekData } from "./investorReport";

const MODEL = "claude-sonnet-5";

export async function generateSummary(
  data: InvestorWeekData,
): Promise<{ text: string; source: "claude" | "fallback" }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: fallbackSummary(data), source: "fallback" };
  }
  try {
    const client = new Anthropic({ timeout: 20_000 });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: buildInvestorPrompt(data) }],
    });
    if (message.stop_reason === "refusal") {
      return { text: fallbackSummary(data), source: "fallback" };
    }
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) return { text: fallbackSummary(data), source: "fallback" };
    return { text, source: "claude" };
  } catch (err) {
    console.error("investorSummary: Claude call failed, using fallback:", err);
    return { text: fallbackSummary(data), source: "fallback" };
  }
}
