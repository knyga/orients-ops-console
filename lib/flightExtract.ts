/**
 * Read airborne time from a stats-bot flight-summary image via Claude vision.
 * SERVER-ONLY (reads ANTHROPIC_API_KEY). One Messages call per image, forced
 * tool-use for structured output.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { AIRBORNE_TOOL, buildVisionPrompt, type AirborneExtract } from "./flightExtractPrompt";

const MODEL = "claude-sonnet-4-6";

export class FlightExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlightExtractError";
  }
}

/** Extract airborne time + flight count from one summary image (base64). */
export async function extractAirborne(
  imageBase64: string,
  mediaType: string,
): Promise<AirborneExtract> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new FlightExtractError("ANTHROPIC_API_KEY is not set on the server (needed for field-qa extraction).");
  }
  const client = new Anthropic();
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      tools: [AIRBORNE_TOOL],
      tool_choice: { type: "tool", name: AIRBORNE_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildVisionPrompt() },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                data: imageBase64,
              },
            },
          ],
        },
      ],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FlightExtractError(`Claude request failed: ${detail}`);
  }
  if (message.stop_reason === "refusal") throw new FlightExtractError("Claude declined the extraction.");
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new FlightExtractError("Claude returned no tool_use block.");
  const input = toolUse.input as Partial<AirborneExtract>;
  return {
    flew: Boolean(input.flew),
    airborneSeconds: Number(input.airborneSeconds ?? 0),
    flights: Number(input.flights ?? 0),
  };
}
