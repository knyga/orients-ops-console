/**
 * Field-qa flight-hours extraction via Claude. SERVER-ONLY.
 *
 * Reads ANTHROPIC_API_KEY from process.env and never exposes it to the browser
 * — same discipline as lib/summarize.ts. The `server-only` import makes an
 * accidental client import a build error. One Messages API call per period with
 * forced tool-use for structured output.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SlackMessage } from "./policySchedule";
import { buildExtractionPrompt, FLIGHT_HOURS_TOOL, type ExtractedDay } from "./flightExtractPrompt";

const MODEL = "claude-sonnet-4-6";

export class FlightExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlightExtractError";
  }
}

/**
 * Extract per-day flight hours from the given #field-qa messages. Returns the
 * raw model output (unvalidated — callers run validateDays). An empty input
 * short-circuits without a network call.
 */
export async function extractFlightDays(messages: SlackMessage[]): Promise<ExtractedDay[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new FlightExtractError(
      "ANTHROPIC_API_KEY is not set on the server (needed for field-qa extraction).",
    );
  }
  if (messages.length === 0) return [];

  const client = new Anthropic();
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: [FLIGHT_HOURS_TOOL],
      tool_choice: { type: "tool", name: FLIGHT_HOURS_TOOL.name },
      messages: [{ role: "user", content: buildExtractionPrompt(messages) }],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FlightExtractError(`Claude request failed: ${detail}`);
  }

  if (message.stop_reason === "refusal") {
    throw new FlightExtractError("Claude declined the extraction request.");
  }

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    throw new FlightExtractError("Claude returned no tool_use block.");
  }

  const input = toolUse.input as { days?: ExtractedDay[] };
  return input.days ?? [];
}
