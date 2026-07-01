/** Classify whether a day's #field-qa messages contain a drone-count report via Claude. SERVER-ONLY. */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { DRONE_COUNT_TOOL, buildDroneCountPrompt, type DroneCountResult } from "./droneCountReportPrompt";

const MODEL = "claude-sonnet-4-6";

export async function classifyDroneCount(dayText: string): Promise<DroneCountResult> {
  if (!dayText.trim()) return { present: false, note: "" };
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (needed for field-bonus drone-count gate).");
  const client = new Anthropic();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    tools: [DRONE_COUNT_TOOL],
    tool_choice: { type: "tool", name: DRONE_COUNT_TOOL.name },
    messages: [{ role: "user", content: [{ type: "text", text: buildDroneCountPrompt(dayText) }] }],
  });
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const input = (block?.input ?? {}) as Partial<DroneCountResult>;
  return { present: Boolean(input.present), note: String(input.note ?? "") };
}
