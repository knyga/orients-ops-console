/**
 * Pure prompt + tool schema for classifying an approver's verdict-thread reply
 * into a roster correction. Two intents: set_roster (authoritative crew) and
 * patch (add/remove a person, or count/don't-count a person for the bonus).
 * Server-only-free so it unit-tests (mirrors lib/approvalClassifyPrompt.ts).
 */
import type Anthropic from "@anthropic-ai/sdk";

export type RosterCorrectionKind = "set_roster" | "patch" | "unclear";

export interface RosterCorrectionClassification {
  kind: RosterCorrectionKind;
  roster?: string[];      // set_roster: the full authoritative crew
  add?: string[];         // patch: add to the crew
  remove?: string[];      // patch: remove from the crew
  counted?: string[];     // patch: count this person for the bonus this day
  notCounted?: string[];  // patch: do NOT count this person this day (stays on the crew)
  reason: string;
}

export const ROSTER_CORRECTION_TOOL: Anthropic.Tool = {
  name: "classify_roster_correction",
  description:
    "Classify an approver's reply correcting who was in the field on a flight day, and/or who should count for that day's bonus.",
  input_schema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["set_roster", "patch", "unclear"],
        description:
          "set_roster = the reply states the full crew (replace the list); " +
          "patch = add/remove a person, or count/don't-count a person; " +
          "unclear = not a roster/eligibility correction",
      },
      roster: { type: "array", items: { type: "string" }, description: "set_roster: full crew, names or initials" },
      add: { type: "array", items: { type: "string" }, description: "patch: people to add to the crew" },
      remove: { type: "array", items: { type: "string" }, description: "patch: people to remove from the crew" },
      counted: { type: "array", items: { type: "string" }, description: "patch: people to COUNT for the bonus this day" },
      notCounted: { type: "array", items: { type: "string" }, description: "patch: people NOT to count this day (kept on crew)" },
      reason: { type: "string", description: "Short factual summary of the correction" },
    },
    required: ["kind", "reason"],
  },
};

export function buildRosterCorrectionPrompt(verdictMessage: string, reply: string): string {
  return [
    `You are reconciling a drone field-ops bonus. The bot posted a per-day verdict that lists`,
    `the crew ("👥 У полі: …"), and an AUTHORIZED approver replied in the thread to correct it.`,
    `Decide the correction, then call classify_roster_correction.`,
    ``,
    `BOT VERDICT MESSAGE:`,
    verdictMessage,
    ``,
    `APPROVER REPLY:`,
    reply,
    ``,
    `Guidance (Ukrainian or English):`,
    `- set_roster: states the whole crew ("були А, Б, В", "склад: Тарас, Влад") → roster=[…].`,
    `- patch add/remove: "додай Тараса" → add=["Тарас"]; "прибери Влада"/"Влада не було" → remove=["Влад"].`,
    `- patch eligibility: "Данило не рахується цього дня" → notCounted=["Данило"]; "Тарасу зарахуй" → counted=["Тарас"].`,
    `- unclear: a question or comment that doesn't change the crew or eligibility.`,
    `Return people as written (names or single-initial); the caller resolves initials. Return only the tool call.`,
  ].join("\n");
}
