import { describe, it, expect } from "vitest";
import { mergeDroneEntries, droneTotals, formatDroneLine, formatDroneCsv, type DroneEntry } from "./droneReport";
import { mentionize } from "./mention";

const E = (name: string, isPerson: boolean, count: number): DroneEntry => ({ name, isPerson, count });

describe("mergeDroneEntries", () => {
  it("sums same name+isPerson, preserves first-seen order", () => {
    expect(mergeDroneEntries([E("Андріан", true, 1), E("15ка", false, 1), E("Андріан", true, 1)])).toEqual([
      E("Андріан", true, 2),
      E("15ка", false, 1),
    ]);
  });
  it("keeps a person and a category of the same name distinct", () => {
    expect(mergeDroneEntries([E("X", true, 1), E("X", false, 2)])).toEqual([E("X", true, 1), E("X", false, 2)]);
  });
});

describe("droneTotals", () => {
  it("splits people vs other and totals", () => {
    expect(droneTotals([E("Андріан", true, 2), E("Демонстраційні", false, 8), E("15ка", false, 1)])).toEqual({
      peopleTotal: 2,
      otherTotal: 9,
      grandTotal: 11,
    });
  });
});

describe("formatDroneLine", () => {
  it("renders people as-written + folded other + grand total", () => {
    const entries = [E("Андріан", true, 2), E("Любомир", true, 3), E("Демонстраційні", false, 8), E("15ка", false, 1)];
    expect(formatDroneLine(entries)).toBe("🛸 Дрони: Андріан 2, Любомир 3, інші 9 (усього 14)");
  });
  it("omits the other term when there are no categories", () => {
    expect(formatDroneLine([E("Андріан", true, 2)])).toBe("🛸 Дрони: Андріан 2 (усього 2)");
  });
  it("renders only the other term when there are no people", () => {
    expect(formatDroneLine([E("15ка", false, 1)])).toBe("🛸 Дрони: інші 1 (усього 1)");
  });
  it("returns null for empty / all-zero entries", () => {
    expect(formatDroneLine([])).toBeNull();
    expect(formatDroneLine([E("X", true, 0)])).toBeNull();
  });
  it("mentions person entries when opts.mention is set", () => {
    const line = formatDroneLine([E("Андріан", true, 2)], { mention: true });
    expect(line).toBe(`🛸 Дрони: ${mentionize("Андріан")} 2 (усього 2)`);
  });
});

describe("formatDroneCsv", () => {
  it("is CSV-friendly: semicolons, plain total, no emoji", () => {
    const entries = [E("Андріан", true, 2), E("Любомир", true, 3), E("Демонстраційні", false, 8), E("15ка", false, 1)];
    expect(formatDroneCsv(entries)).toBe("Андріан 2; Любомир 3; інші 9 (14)");
  });
  it("is empty for no entries", () => {
    expect(formatDroneCsv([])).toBe("");
  });
});
