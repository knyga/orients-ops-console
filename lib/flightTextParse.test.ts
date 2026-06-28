import { describe, expect, test } from "vitest";
import { parseAirborneFromText } from "./flightTextParse";

describe("parseAirborneFromText", () => {
  test("reads airborne seconds, flights and flew=true from a flight day", () => {
    const text = [
      "Статистика польотів за 2026-06-27",
      "Сьогодні літали: Так ✅",
      "Кількість польотів: 2",
      "Час в повітрі: 466 сек",
      "Пролетіли метрів: 660",
      "Час польоту (min / avg / max): 166 / 233 / 299 сек",
    ].join("\n");

    expect(parseAirborneFromText(text)).toEqual({
      flew: true,
      airborneSeconds: 466,
      flights: 2,
    });
  });

  test("tolerates leading whitespace on the data lines", () => {
    const text = [
      "Статистика польотів за 2026-06-27",
      " Сьогодні літали: Так ✅",
      " Кількість польотів: 2",
      " Час в повітрі: 466 сек",
    ].join("\n");

    expect(parseAirborneFromText(text)).toEqual({
      flew: true,
      airborneSeconds: 466,
      flights: 2,
    });
  });

  test("returns flew=false with zeroed values on a no-fly day", () => {
    const text = ["Статистика польотів за 2026-06-20", "Сьогодні літали: Ні ❌"].join("\n");

    expect(parseAirborneFromText(text)).toEqual({
      flew: false,
      airborneSeconds: 0,
      flights: 0,
    });
  });

  test("returns null when the text has no parseable flew line (image-only post)", () => {
    const text = ["Статистика польотів за 2026-06-27", "Статистика польотів за 2026-06-27"].join("\n");

    expect(parseAirborneFromText(text)).toBeNull();
  });

  test("does not mistake the flight-time min/avg/max line for airborne seconds", () => {
    const text = [
      "Статистика польотів за 2026-06-27",
      "Сьогодні літали: Так",
      "Кількість польотів: 1",
      "Час в повітрі: 299 сек",
      "Час польоту (min / avg / max): 299 / 299 / 299 сек",
    ].join("\n");

    expect(parseAirborneFromText(text)?.airborneSeconds).toBe(299);
  });
});
