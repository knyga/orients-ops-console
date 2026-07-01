/**
 * Classify an approver's verdict-thread reply into ONE data-overwrite instruction
 * (any axis) or a confirm/cancel of the pending proposal, via Claude. SERVER-ONLY
 * (reads ANTHROPIC_API_KEY). One Messages call, forced tool-use. Mirrors
 * lib/rosterCorrectionClassify.ts.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  CLASSIFY_INSTRUCTION_TOOL,
  buildInstructionPrompt,
  type InstructionAxis,
  type InstructionClassification,
  type InstructionIntent,
} from "./instructionClassifyPrompt";

const MODEL = "claude-sonnet-4-6";
const VALID_INTENT: InstructionIntent[] = ["confirm", "cancel", "instruction", "unclear"];
const VALID_AXIS: InstructionAxis[] = ["crew", "eligibility", "day", "dataset", "video", "airborne"];

export class InstructionClassifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstructionClassifyError";
  }
}

const arr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined;

/**
 * @param verdictMessage the bot's posted verdict text (thread root)
 * @param reply the approver's reply text
 * @param pendingEcho the Ukrainian echo of a currently-PROPOSED proposal, or null
 */
export async function classifyInstruction(
  verdictMessage: string,
  reply: string,
  pendingEcho: string | null,
): Promise<InstructionClassification> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new InstructionClassifyError("ANTHROPIC_API_KEY is not set on the server.");
  }
  const client = new Anthropic();
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      tools: [CLASSIFY_INSTRUCTION_TOOL],
      tool_choice: { type: "tool", name: CLASSIFY_INSTRUCTION_TOOL.name },
      messages: [{ role: "user", content: buildInstructionPrompt(verdictMessage, reply, pendingEcho) }],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InstructionClassifyError(`Claude request failed: ${detail}`);
  }
  if (message.stop_reason === "refusal") throw new InstructionClassifyError("Claude declined the classification.");
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new InstructionClassifyError("Claude returned no tool_use block.");
  const input = toolUse.input as Partial<InstructionClassification>;

  const intent: InstructionIntent = VALID_INTENT.includes(input.intent as InstructionIntent)
    ? (input.intent as InstructionIntent)
    : "unclear";
  const axis = VALID_AXIS.includes(input.axis as InstructionAxis) ? (input.axis as InstructionAxis) : undefined;
  const airborneMinutes = typeof input.airborneMinutes === "number" && Number.isFinite(input.airborneMinutes)
    ? input.airborneMinutes
    : undefined;

  return {
    intent,
    axis,
    roster: arr(input.roster),
    add: arr(input.add),
    remove: arr(input.remove),
    counted: arr(input.counted),
    notCounted: arr(input.notCounted),
    decision: input.decision === "accepted_exception" || input.decision === "rejected" ? input.decision : undefined,
    datasetStatus: input.datasetStatus === "WAIVED" || input.datasetStatus === "DECLINED" ? input.datasetStatus : undefined,
    videoWaive: input.videoWaive === true ? true : undefined,
    airborneMinutes,
    reason: String(input.reason ?? ""),
  };
}
