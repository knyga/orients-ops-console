/**
 * Pure prompt + tool schema for reading the stats-bot daily flight-summary image
 * (Час в повітрі). Kept server-only-free so it unit-tests without the guard.
 */
import type Anthropic from "@anthropic-ai/sdk";

/** The model's structured read of one daily summary image. */
export interface AirborneExtract {
  /** Whether the day had any flight ("Сьогодні літали" = Так). */
  flew: boolean;
  /** "Час в повітрі" in seconds (0 when they did not fly). */
  airborneSeconds: number;
  /** "Кількість польотів". */
  flights: number;
}

export const AIRBORNE_TOOL: Anthropic.Tool = {
  name: "report_airborne",
  description: "Return the airborne time and flight count read from the flight-summary image.",
  input_schema: {
    type: "object",
    properties: {
      flew: { type: "boolean", description: "Сьогодні літали = Так → true, Ні → false" },
      airborneSeconds: { type: "number", description: "Час в повітрі (сек); 0 if they did not fly" },
      flights: { type: "number", description: "Кількість польотів" },
    },
    required: ["flew", "airborneSeconds", "flights"],
  },
};

/** Instruction paired with the image content block. */
export function buildVisionPrompt(): string {
  return [
    `This image is a Ukrainian drone flight-summary card with label/value rows.`,
    `Read these values and call report_airborne:`,
    `- "Сьогодні літали" → flew (Так = true, Ні = false)`,
    `- "Час в повітрі (сек)" → airborneSeconds (an integer number of seconds; 0 if they did not fly)`,
    `- "Кількість польотів" → flights`,
    `Return only the tool call.`,
  ].join("\n");
}
