/**
 * Pure parser for the stats-bot daily flight-summary posted as TEXT in #field-qa.
 * The bot now publishes the same `Статистика польотів` card as a text body in
 * addition to the image, so we can read airborne time deterministically (no LLM,
 * no image download) when the text is present and fall back to vision otherwise.
 *
 * Kept server-only-free and side-effect-free so it unit-tests without the guard.
 */
import type { AirborneExtract } from "./flightExtractPrompt";

const FLEW = /Сьогодні літали:\s*(Так|Ні)/;
const AIRBORNE = /Час в повітрі:\s*(\d+)\s*сек/;
const FLIGHTS = /Кількість польотів:\s*(\d+)/;

/**
 * Read airborne time + flight count from a summary message body. Returns null
 * when the text lacks the `Сьогодні літали` line (e.g. an image-only post),
 * signalling the caller to fall back to vision.
 */
export function parseAirborneFromText(text: string): AirborneExtract | null {
  const flewMatch = FLEW.exec(text);
  if (!flewMatch) return null;
  const flew = flewMatch[1] === "Так";
  return {
    flew,
    airborneSeconds: Number(AIRBORNE.exec(text)?.[1] ?? 0),
    flights: Number(FLIGHTS.exec(text)?.[1] ?? 0),
  };
}
