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

// Opus with adaptive thinking: the weekly investor draft is important enough to
// spend the extra reasoning on (one call a week). `budget_tokens` is gone on
// current models — adaptive thinking + `output_config.effort` replaces it.
const MODEL = "claude-opus-5";

export async function generateSummary(
  data: InvestorWeekData,
): Promise<{ text: string; source: "claude" | "fallback" }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: fallbackSummary(data), source: "fallback" };
  }
  try {
    // 45s cap: fits the cron's 60s budget; a hung/slow call soft-fails to the
    // deterministic bullets rather than blowing up the whole run.
    const client = new Anthropic({ timeout: 45_000 });
    const message = await client.messages.create({
      model: MODEL,
      // Thinking counts against max_tokens on Opus 5 — leave it headroom.
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
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
