import { describe, expect, it } from "vitest";
import { formatDmHelp } from "./dmHelp";

describe("formatDmHelp", () => {
  const text = formatDmHelp();

  it("is Ukrainian and explains the verdict-thread reply flow", () => {
    // Approvers act by replying in a verdict thread — that must be the core message.
    expect(text).toMatch(/гілц|гілк|треді|вердикт/i); // "у гілці вердикту"
  });

  it("mentions the three change axes an approver can instruct", () => {
    expect(text).toMatch(/екіпаж|склад/i); // crew
    expect(text).toMatch(/прийн|відхил/i); // accept / reject a day
    expect(text).toMatch(/наліт|хвилин/i); // airborne minutes
  });

  it("is a non-trivial multi-line message", () => {
    expect(text.split("\n").length).toBeGreaterThan(3);
    expect(text.length).toBeGreaterThan(80);
  });
});
