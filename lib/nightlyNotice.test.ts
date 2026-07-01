import { describe, it, expect } from "vitest";
import { formatNightlyFailureNotice } from "./nightlyNotice";

describe("formatNightlyFailureNotice", () => {
  it("names the stage and includes the reason", () => {
    const msg = formatNightlyFailureNotice("extract", "Vimeo 502");
    expect(msg).toContain("extract");
    expect(msg).toContain("Vimeo 502");
    expect(msg.startsWith("⚠️")).toBe(true);
  });

  it("truncates a very long reason", () => {
    const msg = formatNightlyFailureNotice("publish", "x".repeat(1000));
    expect(msg.length).toBeLessThan(360);
  });

  it("falls back when the reason is blank", () => {
    expect(formatNightlyFailureNotice("verdict", "   ")).toContain("невідома помилка");
  });
});
