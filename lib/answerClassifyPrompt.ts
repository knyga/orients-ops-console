/**
 * Pure prompt + tool schema for classifying a human's free-text (Ukrainian) reply
 * to one of the bot's S5 questions. Kept server-only-free so it unit-tests without
 * the guard (mirrors lib/flightExtractPrompt.ts).
 */
import type Anthropic from "@anthropic-ai/sdk";

export type AnswerType =
  | "accepted_exception" // a legitimate exception (force majeure / tech failure) — accept the day
  | "data_provided"      // the missing data was provided (dataset link, videos uploaded)
  | "still_missing"      // the gap genuinely remains (no dataset / not recorded)
  | "unclear";           // the reply doesn't resolve the question

/** The model's structured read of one reply. */
export interface AnswerClassification {
  /** True when the reply settles the gap (accepted_exception or data_provided). */
  resolved: boolean;
  type: AnswerType;
  /** Short factual summary of the human's reason/answer (their language is fine). */
  note: string;
}

export const ANSWER_TOOL: Anthropic.Tool = {
  name: "classify_answer",
  description: "Classify how a human's reply resolves the bot's question about a flight day.",
  input_schema: {
    type: "object",
    properties: {
      resolved: {
        type: "boolean",
        description: "true only if the reply settles the gap (accepted_exception or data_provided)",
      },
      type: {
        type: "string",
        enum: ["accepted_exception", "data_provided", "still_missing", "unclear"],
        description:
          "accepted_exception = a valid exception (force majeure, tech failure) to accept the day; " +
          "data_provided = the missing dataset/videos were provided; " +
          "still_missing = the gap genuinely remains; unclear = reply doesn't resolve it",
      },
      note: { type: "string", description: "Short factual summary of the human's reason/answer" },
    },
    required: ["resolved", "type", "note"],
  },
};

/** Build the classification prompt for a (question, reply) pair. */
export function buildClassifyPrompt(question: string, reply: string): string {
  return [
    `You are reconciling a drone field-ops bonus. The bot asked a question about a`,
    `flight day, and a team member replied (Ukrainian). Classify how the reply`,
    `resolves the question, then call classify_answer.`,
    ``,
    `BOT QUESTION:`,
    question,
    ``,
    `HUMAN REPLY:`,
    reply,
    ``,
    `Guidance:`,
    `- "accepted_exception": a legitimate reason to accept despite the miss`,
    `  (e.g. погодні умови / форс-мажор, технічна несправність запису/борта).`,
    `- "data_provided": they supplied the missing thing (a dataset link/drive`,
    `  folder, or say videos were uploaded / "залив відео").`,
    `- "still_missing": they confirm nothing was published / not recorded`,
    `  (e.g. "немає датасету", "не записували").`,
    `- "unclear": anything that doesn't actually resolve the question.`,
    `Set resolved=true only for accepted_exception or data_provided.`,
    `Return only the tool call.`,
  ].join("\n");
}
