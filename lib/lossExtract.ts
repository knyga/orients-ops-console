/** Classify a Звіт report's free text for drone loss via Claude. SERVER-ONLY. */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { LOSS_TOOL, buildLossPrompt, type LossExtract } from "./lossExtractPrompt";

const MODEL = "claude-sonnet-4-6";

export async function extractLoss(crashText: string): Promise<LossExtract> {
  if (!crashText.trim()) return { lost: false, found: false, note: "" };
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (needed for field-bonus loss extraction).");
  const client = new Anthropic();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    tools: [LOSS_TOOL],
    tool_choice: { type: "tool", name: LOSS_TOOL.name },
    messages: [{ role: "user", content: [{ type: "text", text: buildLossPrompt(crashText) }] }],
  });
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const input = (block?.input ?? {}) as Partial<LossExtract>;
  return { lost: Boolean(input.lost), found: Boolean(input.found), note: String(input.note ?? "") };
}
