/**
 * Pure prompt + tool schema for classifying an approver's verdict-thread reply
 * into ONE data-overwrite instruction across every axis, OR a confirmation /
 * cancellation of a pending proposal. One forced tool-call per Slack event (the
 * 3s webhook budget allows exactly one Claude call). Server-only-free so it
 * unit-tests (mirrors lib/rosterCorrectionClassifyPrompt.ts).
 *
 * Axes: crew / eligibility / day (accept-reject) / dataset / video / airborne.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type InstructionIntent = "confirm" | "cancel" | "instruction" | "unclear";
export type InstructionAxis = "crew" | "eligibility" | "day" | "dataset" | "video" | "airborne";

export interface InstructionClassification {
  intent: InstructionIntent;
  axis?: InstructionAxis;
  // crew / eligibility
  roster?: string[]; // crew: full authoritative crew (set)
  add?: string[]; // crew: add to the crew
  remove?: string[]; // crew: remove from the crew
  counted?: string[]; // eligibility: count for the bonus this day
  notCounted?: string[]; // eligibility: do NOT count this day (kept on crew)
  // day
  decision?: "accepted_exception" | "rejected";
  // dataset
  datasetStatus?: "WAIVED" | "DECLINED";
  // video
  videoWaive?: boolean;
  // airborne
  airborneMinutes?: number;
  reason: string;
}

export const CLASSIFY_INSTRUCTION_TOOL: Anthropic.Tool = {
  name: "classify_instruction",
  description:
    "Classify an authorized approver's reply in a flight-day verdict thread as a single data-overwrite " +
    "instruction (crew / eligibility / day accept-reject / dataset / video / airborne minutes), or as a " +
    "confirmation / cancellation of the pending proposal, or unclear.",
  input_schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: ["confirm", "cancel", "instruction", "unclear"],
        description:
          "confirm = approves the PENDING proposal shown; cancel = rejects the PENDING proposal; " +
          "instruction = a new data change (set axis + payload); unclear = a question/comment that changes nothing",
      },
      axis: {
        type: "string",
        enum: ["crew", "eligibility", "day", "dataset", "video", "airborne"],
        description: "instruction only: which datum to overwrite",
      },
      roster: { type: "array", items: { type: "string" }, description: "crew: full authoritative crew (names/initials)" },
      add: { type: "array", items: { type: "string" }, description: "crew: people to add" },
      remove: { type: "array", items: { type: "string" }, description: "crew: people to remove" },
      counted: { type: "array", items: { type: "string" }, description: "eligibility: people to COUNT for the bonus this day" },
      notCounted: { type: "array", items: { type: "string" }, description: "eligibility: people NOT to count this day (kept on crew)" },
      decision: {
        type: "string",
        enum: ["accepted_exception", "rejected"],
        description: "day: accept the flagged day as an exception, or reject/veto it",
      },
      datasetStatus: {
        type: "string",
        enum: ["WAIVED", "DECLINED"],
        description: "dataset: waive the missing #datasets notice, or decline the stated reason",
      },
      videoWaive: { type: "boolean", description: "video: true to forgive the < 50% video coverage for the day" },
      airborneMinutes: { type: "number", description: "airborne: the corrected airborne minutes for the day" },
      reason: { type: "string", description: "Short factual summary of the correction (or why it is a confirm/cancel/unclear)" },
    },
    required: ["intent", "reason"],
  },
};

export function buildInstructionPrompt(
  verdictMessage: string,
  reply: string,
  pendingEcho: string | null,
): string {
  const lines = [
    `You are reconciling a drone field-ops bonus. The bot posted a per-day verdict (it lists the crew`,
    `"👥 У полі: …"), and an AUTHORIZED approver replied in the thread. Decide what the reply means, then`,
    `call classify_instruction.`,
    ``,
    `BOT VERDICT MESSAGE:`,
    verdictMessage,
    ``,
  ];
  if (pendingEcho) {
    lines.push(
      `THERE IS A PROPOSAL ОЧІКУЄ ПІДТВЕРДЖЕННЯ (awaiting confirmation) — the bot already echoed this change`,
      `and is waiting for the approver to confirm or reject it:`,
      `  «${pendingEcho}»`,
      `If the reply agrees ("так", "ок", "підтверджую", "+", "давай", "вірно", 👍) → intent="confirm".`,
      `If it disagrees ("ні", "скасуй", "не треба", "відміна") → intent="cancel".`,
      `If it is a DIFFERENT change → intent="instruction" (a new proposal replaces the pending one).`,
      ``,
    );
  }
  lines.push(
    `APPROVER REPLY:`,
    reply,
    ``,
    `Instruction guidance (Ukrainian or English) — pick ONE axis:`,
    `- crew: "склад: Тарас, Влад" → axis="crew", roster=[…]; "додай Тараса" → add=["Тарас"]; "прибери Влада"/"Влада не було" → remove=["Влад"].`,
    `- eligibility: "Данило не рахується цього дня" → axis="eligibility", notCounted=["Данило"]; "Тарасу зарахуй" → counted=["Тарас"].`,
    `- day: "зараховуємо, форс-мажор"/"day approved" → axis="day", decision="accepted_exception"; "ні, не прийнято"/"день не зараховано" → axis="day", decision="rejected".`,
    `- dataset: "датасет не потрібен цього дня" → axis="dataset", datasetStatus="WAIVED"; "причина не приймається" → datasetStatus="DECLINED".`,
    `- video: "відео можна не рахувати"/"нормально що менше відео" → axis="video", videoWaive=true.`,
    `- airborne: "в повітрі було 133 хв"/"насправді 90 хвилин у польоті" → axis="airborne", airborneMinutes=133.`,
    `- unclear: a question or comment that does not itself state a change ("тільки ти був?", "де звіт?").`,
    `Return people as written (names or single-initial); the caller resolves initials. Return only the tool call.`,
  );
  return lines.join("\n");
}
