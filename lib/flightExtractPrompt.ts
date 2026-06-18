/**
 * Pure prompt construction + tool schema for field-qa flight-hours extraction.
 * Kept separate from lib/flightExtract.ts (server-only, hits the Anthropic API)
 * so the prompt/schema can be unit-tested without a network call or the
 * server-only guard — same split as lib/occupationPrompt.ts / lib/summarize.ts.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { SlackMessage } from "./policySchedule";

export interface FlightWindow {
  start: string; // HH:MM
  end: string; // HH:MM
}

export interface ExtractedDay {
  /** Flight date in YYYY-MM-DD (converted from the report's DD.MM.YYYY). */
  date: string;
  /** Total decimal hours, summed across all windows that day. */
  flightHours: number;
  windows: FlightWindow[];
  /** Crew code from the report (e.g. "А+Д"), or null. */
  crew: string | null;
  /** Slack ts of the source "Звіт" message. */
  sourceTs: string;
}

/** Forced-tool-use schema: Claude must return the days array via this tool. */
export const FLIGHT_HOURS_TOOL: Anthropic.Tool = {
  name: "report_flight_hours",
  description: "Return the per-day flight hours extracted from the field-qa reports.",
  input_schema: {
    type: "object",
    properties: {
      days: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: "string", description: "Flight date, YYYY-MM-DD" },
            flightHours: {
              type: "number",
              description: "Total decimal hours, summed across all windows that day",
            },
            windows: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  start: { type: "string", description: "HH:MM" },
                  end: { type: "string", description: "HH:MM" },
                },
                required: ["start", "end"],
              },
            },
            crew: { type: ["string", "null"], description: "Crew code e.g. А+Д, or null" },
            sourceTs: { type: "string", description: "Slack ts of the source Звіт message" },
          },
          required: ["date", "flightHours", "windows", "crew", "sourceTs"],
        },
      },
    },
    required: ["days"],
  },
};

/**
 * Build the extraction prompt from the candidate #field-qa messages. The model
 * is told to consider only "Звіт <date>" daily reports and to call the tool.
 */
export function buildExtractionPrompt(messages: SlackMessage[]): string {
  const list = messages.map((m) => `[ts=${m.ts}] ${m.text}`).join("\n---\n");
  return [
    `You extract drone field flight hours from #field-qa Slack reports (Ukrainian free-text).`,
    ``,
    `Rules:`,
    `- Consider ONLY daily flight reports that begin with "Звіт <DD.MM.YYYY>". Ignore inventory/repair notes, "Статистика польотів" posts, and chatter.`,
    `- Convert the report date DD.MM.YYYY to YYYY-MM-DD.`,
    `- A crew line looks like "А+Д 15:20-18:30" — a crew code followed by one or more HH:MM-HH:MM flight windows. Sum the duration of every window in the report to decimal hours (15:20-18:30 = 3.17).`,
    `- If a window's end time is earlier than its start, it crossed midnight: add 24h to the end before subtracting.`,
    `- Round flightHours to 2 decimals.`,
    `- Emit exactly one entry per distinct report date; if multiple reports share a date, sum their hours. Set sourceTs to the ts of a source message for that date and crew to the crew code (or null).`,
    `- If there are no flight reports, return an empty days array.`,
    ``,
    `Call the report_flight_hours tool with the result.`,
    ``,
    `Messages:`,
    list,
  ].join("\n");
}
