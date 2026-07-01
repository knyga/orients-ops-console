import { describe, expect, it } from "vitest";
import { overlayAirborne, type AirborneOverride } from "./airborneOverride";

const ov = (date: string, minutes: number): AirborneOverride => ({
  date,
  minutes,
  note: "n",
  by: "Oleksandr K",
  source: "manual",
  recordedAt: "2026-07-01T00:00:00.000Z",
});

describe("overlayAirborne", () => {
  it("overrides an existing date's minutes (override wins)", () => {
    const base = new Map([["2026-06-25", 0]]);
    const out = overlayAirborne(base, [ov("2026-06-25", 133)]);
    expect(out.get("2026-06-25")).toBe(133);
  });

  it("adds a date that had no committed airborne figure", () => {
    const out = overlayAirborne(new Map<string, number>(), [ov("2026-06-27", 42)]);
    expect(out.get("2026-06-27")).toBe(42);
  });

  it("leaves non-overridden dates unchanged and does not mutate the input", () => {
    const base = new Map([["2026-06-24", 65]]);
    const out = overlayAirborne(base, [ov("2026-06-25", 133)]);
    expect(out.get("2026-06-24")).toBe(65);
    expect(base.has("2026-06-25")).toBe(false);
  });
});
