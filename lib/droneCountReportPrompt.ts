/** Pure prompt + tool schema for classifying whether a day's #field-qa messages
 *  contain a drone-count/production report (the bonus gate). */
import type Anthropic from "@anthropic-ai/sdk";

export interface DroneCountResult {
  present: boolean;
  note: string;
}

export const DRONE_COUNT_TOOL: Anthropic.Tool = {
  name: "record_drone_count_report",
  description:
    "Classify whether the day's #field-qa messages include a drone-count / production tally (how many units were built/checked/at R&D that day).",
  input_schema: {
    type: "object",
    properties: {
      present: {
        type: "boolean",
        description:
          "true if the text contains a per-unit drone-count/production report (e.g. 'R&D - 1шт вартовий', 'Демонстраційні - 8шт', 'Перевірені - 8шт', '15ка - 1шт'). A flight-hours 'Звіт' or general chatter is NOT a drone-count report.",
      },
      note: { type: "string", description: "short quote of the matched drone-count line, or '' if none" },
    },
    required: ["present", "note"],
  },
};

export function buildDroneCountPrompt(dayText: string): string {
  return [
    `These are the #field-qa messages posted on one calendar day (Ukrainian).`,
    `Decide whether they include a drone-count / production tally: counts of drone units by category,`,
    `such as "R&D - 1шт вартовий", "Демонстраційні - 8шт", "Перевірені - 8шт", "15ка - 1шт".`,
    `A flight-hours "Звіт" (roster + time window) or general chatter is NOT a drone-count report.`,
    `Messages:`,
    `"""${dayText}"""`,
    `Call record_drone_count_report with present, note.`,
  ].join("\n");
}
