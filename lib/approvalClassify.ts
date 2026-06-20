/**
 * Classify an authorized approver's reply to a verdict via Claude. SERVER-ONLY
 * (reads ANTHROPIC_API_KEY). One Messages call per reply, forced tool-use for
 * structured output. Mirrors lib/answerClassify.ts.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  APPROVAL_TOOL,
  buildApprovalPrompt,
  type ApprovalClassification,
  type ApprovalDecision,
} from "./approvalClassifyPrompt";

const MODEL = "claude-sonnet-4-6";
const VALID: ApprovalDecision[] = ["approve", "disapprove", "unclear"];

export class ApprovalClassifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalClassifyError";
  }
}

/** Classify one approver reply (against the verdict it replies to). */
export async function classifyApproval(verdictMessage: string, reply: string): Promise<ApprovalClassification> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ApprovalClassifyError("ANTHROPIC_API_KEY is not set on the server (needed for approval classification).");
  }
  const client = new Anthropic();
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      tools: [APPROVAL_TOOL],
      tool_choice: { type: "tool", name: APPROVAL_TOOL.name },
      messages: [{ role: "user", content: buildApprovalPrompt(verdictMessage, reply) }],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApprovalClassifyError(`Claude request failed: ${detail}`);
  }
  if (message.stop_reason === "refusal") throw new ApprovalClassifyError("Claude declined the classification.");
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new ApprovalClassifyError("Claude returned no tool_use block.");
  const input = toolUse.input as Partial<ApprovalClassification>;
  const decision: ApprovalDecision = VALID.includes(input.decision as ApprovalDecision)
    ? (input.decision as ApprovalDecision)
    : "unclear";
  return { decision, reason: String(input.reason ?? "") };
}
