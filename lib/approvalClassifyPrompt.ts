/**
 * Pure prompt + tool schema for classifying an AUTHORIZED approver's in-thread
 * reply to a published verdict as approve / disapprove / unclear. Free text,
 * Ukrainian or English. Kept server-only-free so it unit-tests without the guard
 * (mirrors lib/answerClassifyPrompt.ts).
 */
import type Anthropic from "@anthropic-ai/sdk";

export type ApprovalDecision = "approve" | "disapprove" | "unclear";

export interface ApprovalClassification {
  decision: ApprovalDecision;
  /** Short factual summary of the approver's reasoning (their language is fine). */
  reason: string;
}

export const APPROVAL_TOOL: Anthropic.Tool = {
  name: "classify_approval",
  description: "Classify an authorized approver's reply to a flight-day verdict as approve/disapprove/unclear.",
  input_schema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["approve", "disapprove", "unclear"],
        description:
          "approve = the day is fine / the miss is acceptable (accept it); " +
          "disapprove = the day is NOT acceptable (reject it); " +
          "unclear = the reply doesn't decide",
      },
      reason: { type: "string", description: "Short factual summary of the approver's reasoning" },
    },
    required: ["decision", "reason"],
  },
};

/** Build the classification prompt for an approver's reply to a verdict message. */
export function buildApprovalPrompt(verdictMessage: string, reply: string): string {
  return [
    `You are reconciling a drone field-ops bonus. The bot posted a per-day verdict,`,
    `and an AUTHORIZED approver (a company decision-maker) replied in the thread.`,
    `Decide whether they approve or disapprove the day, then call classify_approval.`,
    ``,
    `BOT VERDICT MESSAGE:`,
    verdictMessage,
    ``,
    `APPROVER REPLY:`,
    reply,
    ``,
    `Guidance:`,
    `- "approve": they say it's fine / acceptable / a valid exception`,
    `  (e.g. "все ок", "так і має бути", "ми тестували інше, датасет не потрібен",`,
    `  "форс-мажор, зараховуємо").`,
    `- "disapprove": they say it's NOT acceptable / must be redone / rejected`,
    `  (e.g. "ні, так не можна", "не зараховуємо", "треба перезняти").`,
    `- "unclear": a question or comment that doesn't decide.`,
    `Return only the tool call.`,
  ].join("\n");
}
