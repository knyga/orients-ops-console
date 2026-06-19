/**
 * Classify a human's free-text reply to a bot question via Claude. SERVER-ONLY
 * (reads ANTHROPIC_API_KEY). One Messages call per reply, forced tool-use for
 * structured output. Mirrors lib/flightExtract.ts.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  ANSWER_TOOL,
  buildClassifyPrompt,
  type AnswerClassification,
  type AnswerType,
} from "./answerClassifyPrompt";

const MODEL = "claude-sonnet-4-6";
const VALID_TYPES: AnswerType[] = ["accepted_exception", "data_provided", "still_missing", "unclear"];

export class AnswerClassifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerClassifyError";
  }
}

/** Classify one (question, reply) pair into a structured resolution signal. */
export async function classifyAnswer(question: string, reply: string): Promise<AnswerClassification> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AnswerClassifyError("ANTHROPIC_API_KEY is not set on the server (needed for answer classification).");
  }
  const client = new Anthropic();
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      tools: [ANSWER_TOOL],
      tool_choice: { type: "tool", name: ANSWER_TOOL.name },
      messages: [{ role: "user", content: buildClassifyPrompt(question, reply) }],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AnswerClassifyError(`Claude request failed: ${detail}`);
  }
  if (message.stop_reason === "refusal") throw new AnswerClassifyError("Claude declined the classification.");
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new AnswerClassifyError("Claude returned no tool_use block.");
  const input = toolUse.input as Partial<AnswerClassification>;
  const type: AnswerType = VALID_TYPES.includes(input.type as AnswerType) ? (input.type as AnswerType) : "unclear";
  return {
    resolved: Boolean(input.resolved),
    type,
    note: String(input.note ?? ""),
  };
}
