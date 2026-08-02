/**
 * The one Claude call that turns the week's numbers into the 3–5 «•» takeaway
 * bullets. SERVER-ONLY (needs ANTHROPIC_API_KEY). Soft-fails by design: any
 * error — or output that isn't bullet lines — returns the deterministic
 * fallback bullets; the weekly draft is human-edited in #general anyway, so a
 * degraded summary must never block it.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildInvestorPrompt,
  fallbackSummary,
  normalizeSummaryBullets,
  type InvestorWeekData,
} from "./investorReport";

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
    const bullets = normalizeSummaryBullets(text);
    if (!bullets) return { text: fallbackSummary(data), source: "fallback" };
    return { text: bullets, source: "claude" };
  } catch (err) {
    console.error("investorSummary: Claude call failed, using fallback:", err);
    return { text: fallbackSummary(data), source: "fallback" };
  }
}
