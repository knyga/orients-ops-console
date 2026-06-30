/**
 * Classify an approver's roster-correction reply via Claude. SERVER-ONLY
 * (reads ANTHROPIC_API_KEY). One Messages call, forced tool-use. Mirrors
 * lib/approvalClassify.ts.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  ROSTER_CORRECTION_TOOL,
  buildRosterCorrectionPrompt,
  type RosterCorrectionClassification,
  type RosterCorrectionKind,
} from "./rosterCorrectionClassifyPrompt";

const MODEL = "claude-sonnet-4-6";
const VALID: RosterCorrectionKind[] = ["set_roster", "patch", "unclear"];

export class RosterCorrectionClassifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RosterCorrectionClassifyError";
  }
}

const arr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined;

export async function classifyRosterCorrection(
  verdictMessage: string,
  reply: string,
): Promise<RosterCorrectionClassification> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new RosterCorrectionClassifyError("ANTHROPIC_API_KEY is not set on the server.");
  }
  const client = new Anthropic();
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      tools: [ROSTER_CORRECTION_TOOL],
      tool_choice: { type: "tool", name: ROSTER_CORRECTION_TOOL.name },
      messages: [{ role: "user", content: buildRosterCorrectionPrompt(verdictMessage, reply) }],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RosterCorrectionClassifyError(`Claude request failed: ${detail}`);
  }
  if (message.stop_reason === "refusal") throw new RosterCorrectionClassifyError("Claude declined the classification.");
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new RosterCorrectionClassifyError("Claude returned no tool_use block.");
  const input = toolUse.input as Partial<RosterCorrectionClassification>;
  const kind: RosterCorrectionKind = VALID.includes(input.kind as RosterCorrectionKind)
    ? (input.kind as RosterCorrectionKind)
    : "unclear";
  return {
    kind,
    roster: arr(input.roster),
    add: arr(input.add),
    remove: arr(input.remove),
    counted: arr(input.counted),
    notCounted: arr(input.notCounted),
    reason: String(input.reason ?? ""),
  };
}
