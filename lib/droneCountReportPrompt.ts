/** Pure prompt + tool schema for extracting a day's #field-qa drone-count /
 *  production report into per-person / per-category entries. */
import type Anthropic from "@anthropic-ai/sdk";
import type { DroneEntry } from "./droneReport";

export interface DroneCountResult {
  /** Derived by the classifier: entries.length > 0. Kept for the bonus gate. */
  present: boolean;
  entries: DroneEntry[];
  /** YYYY-MM-DD only when the report text explicitly names a date; else null. */
  forDate: string | null;
  note: string;
}

export const DRONE_COUNT_TOOL: Anthropic.Tool = {
  name: "record_drone_count_report",
  description:
    "Extract the day's #field-qa drone-count / production tally: how many drone units each person or category had that day.",
  input_schema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        description:
          "One item per person or category named in the drone-count report. Empty when the messages contain no drone-count tally (a flight-hours 'Звіт' or general chatter is NOT a drone-count report).",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Person or category name exactly as written, e.g. 'Андріан', 'Демонстраційні', '15ка'. A qualifier like 'R&D' is a tag, not a separate entry — use the person's name.",
            },
            isPerson: {
              type: "boolean",
              description: "true for a person's name, false for a category ('Демонстраційні', 'Перевірені', '15ка', ...).",
            },
            count: {
              type: "integer",
              description: "Total drone units for this entry, summing every 'Nшт' on its line(s), e.g. '1шт вартовий + 1 шт азимут' → 2.",
            },
          },
          required: ["name", "isPerson", "count"],
        },
      },
      forDate: {
        type: "string",
        description: "YYYY-MM-DD ONLY if the report text explicitly names the date it is for; otherwise omit it.",
      },
      note: { type: "string", description: "short quote of the matched drone-count line(s), or '' if none" },
    },
    required: ["entries", "note"],
  },
};

export function buildDroneCountPrompt(dayText: string): string {
  return [
    `This is one #field-qa Slack message (Ukrainian).`,
    `Extract the drone-count / production tally: how many drone units each person or category had that day, e.g.`,
    `"Андріан R&D - 1шт вартовий+ 1 шт азимут" → {name:"Андріан", isPerson:true, count:2};`,
    `"Демонстраційні - 8 шт" → {name:"Демонстраційні", isPerson:false, count:8}; "15ка - 1шт" → {name:"15ка", isPerson:false, count:1}.`,
    `A flight-hours "Звіт" (roster + time window) or general chatter is NOT a drone-count report → return entries: [].`,
    `Set forDate ONLY if the text explicitly names the date it is for; otherwise omit it.`,
    `Messages:`,
    `"""${dayText}"""`,
    `Call record_drone_count_report with entries, note (and forDate only if explicit).`,
  ].join("\n");
}
