/** Pure prompt + tool schema for classifying a Звіт's free text for drone loss. */
import type Anthropic from "@anthropic-ai/sdk";

export interface LossExtract {
  lost: boolean;
  found: boolean;
  note: string;
}

export const LOSS_TOOL: Anthropic.Tool = {
  name: "report_loss",
  description: "Classify whether a field report describes a lost/destroyed drone, and whether it was recovered.",
  input_schema: {
    type: "object",
    properties: {
      lost: { type: "boolean", description: "true if a drone was lost, crashed, or destroyed during this flight day" },
      found: { type: "boolean", description: "true if a lost drone was recovered/found (per the rules, then it is NOT a loss)" },
      note: { type: "string", description: "short quote or paraphrase of the relevant sentence" },
    },
    required: ["lost", "found", "note"],
  },
};

export function buildLossPrompt(crashText: string): string {
  return [
    `This is the free-text body of a Ukrainian field-flight report.`,
    `Decide whether a drone was lost/crashed/destroyed, and whether it was later found.`,
    `A drone reported lost but recovered ("знайшли", "found") counts as found=true.`,
    `Report text:`,
    `"""${crashText}"""`,
    `Call report_loss with lost, found, note.`,
  ].join("\n");
}
