/** Pure prompt + tool schema for extracting a day's #field-qa drone-count /
 *  production report into per-person / per-category entries. */
import type Anthropic from "@anthropic-ai/sdk";
import type { DroneEntry } from "./droneReport";

/** One dated (or undated) section of a drone-count message. */
export interface DroneDayReport {
  entries: DroneEntry[];
  /** YYYY-MM-DD only when the section's text explicitly names a date; else null. */
  forDate: string | null;
}

export interface DroneCountResult {
  /** Derived by the classifier: some report has entries. Kept for the bonus gate. */
  present: boolean;
  /** One item per dated section — a single message may tally several days. */
  reports: DroneDayReport[];
  note: string;
}

export const DRONE_COUNT_TOOL: Anthropic.Tool = {
  name: "record_drone_count_report",
  description:
    "Extract the #field-qa drone-count / production tally: how many drone units each person or category had, one report per dated section of the message.",
  input_schema: {
    type: "object",
    properties: {
      reports: {
        type: "array",
        description:
          "One item per dated section of the message. A message with a single (usually undated) tally is ONE report. A message listing several dated sections — e.g. '23.06 …', '24.06 …', '25.06 …' each followed by its own tally — is one report PER section, each with its own forDate; never merge sections or drop one. Empty when the message contains no drone-count tally (a flight-hours 'Звіт' or general chatter is NOT a drone-count report).",
        items: {
          type: "object",
          properties: {
            entries: {
              type: "array",
              description:
                "One item per person or category named in this section's tally. A parenthetical qualifier after a counted line — e.g. '(Перевірені - 8шт ( 2 шт азимут)', '(3 ремонт : …)', '(3шт необлітані)' — describes the SAME already-counted units (checked/repair/status), so it is never a separate entry and never adds to any count.",
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
                    description: "true for a person's name, false for a category ('Демонстраційні', '15ка', ...).",
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
              description: "YYYY-MM-DD ONLY if this section's text explicitly names the date it is for; otherwise omit it.",
            },
          },
          required: ["entries"],
        },
      },
      note: { type: "string", description: "short quote of the matched drone-count line(s), or '' if none" },
    },
    required: ["reports", "note"],
  },
};

export function buildDroneCountPrompt(dayText: string, postedOn?: string): string {
  return [
    `This is one #field-qa Slack message (Ukrainian)${postedOn ? `, posted on ${postedOn} (Kyiv)` : ""}.`,
    `Extract the drone-count / production tally: how many drone units each person or category had that day, e.g.`,
    `"Андріан R&D - 1шт вартовий+ 1 шт азимут" → {name:"Андріан", isPerson:true, count:2};`,
    `"Демонстраційні - 8 шт (Перевірені - 8шт ( 2 шт азимут)" → {name:"Демонстраційні", isPerson:false, count:8} — the parenthetical says the same 8 units are checked, NOT a separate entry; "15ка - 1шт" → {name:"15ка", isPerson:false, count:1}.`,
    `A parenthetical after a counted line ('Перевірені …', 'ремонт …', 'необлітані …') qualifies units already counted on that line: never emit it as its own entry and never add its numbers to any count.`,
    `A flight-hours "Звіт" (roster + time window) or general chatter is NOT a drone-count report → return reports: [].`,
    `A message with one tally is one report. A message with several dated sections (e.g. "23.06 …", "24.06 …", "25.06 …", each heading followed by its own tally) is one report per section — keep every section, each with its own forDate.`,
    `Set a report's forDate ONLY if its section explicitly names the date it is for; otherwise omit it.`,
    `A day-month form like "01.06" names a date: resolve it against the posting date (it is that day-month on or shortly before the posting date) and return it as YYYY-MM-DD.`,
    `Messages:`,
    `"""${dayText}"""`,
    `Call record_drone_count_report with reports, note (per-report forDate only if explicit).`,
  ].join("\n");
}
