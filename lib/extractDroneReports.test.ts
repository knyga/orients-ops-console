import { describe, it, expect, vi } from "vitest";
vi.mock("./droneCountReport", () => ({ classifyDroneCount: vi.fn() }));
import { extractDroneReports, type DroneMessage } from "./extractDroneReports";
import { type DroneEntry } from "./droneReport";

const E = (name: string, isPerson: boolean, count: number): DroneEntry => ({ name, isPerson, count });
// 2026-06-25 12:00 Kyiv ≈ 09:00 UTC. Use a fixed UTC ts that maps to the Kyiv day.
const tsFor = (isoUtc: string) => String(Math.floor(new Date(isoUtc).getTime() / 1000));

describe("extractDroneReports", () => {
  it("attributes to the post date and merges same-day reports", async () => {
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-25T09:00:00Z"), text: "Андріан R&D - 1шт" },
      { ts: tsFor("2026-06-25T15:00:00Z"), text: "Андріан R&D - 1шт" },
    ];
    const classify = vi.fn(async () => ({ entries: [E("Андріан", true, 1)], forDate: null }));
    const out = await extractDroneReports(messages, classify);
    // one classify call PER candidate message; same target day merges.
    expect(classify).toHaveBeenCalledTimes(2);
    expect(out.get("2026-06-25")).toEqual([E("Андріан", true, 2)]);
  });

  it("skips non-candidate messages (no шт tally) without a classify call", async () => {
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-25T09:00:00Z"), text: "просто балачки без звіту" },
      { ts: tsFor("2026-06-25T10:00:00Z"), text: "Андріан R&D - 1шт" },
    ];
    const classify = vi.fn(async () => ({ entries: [E("Андріан", true, 1)], forDate: null }));
    const out = await extractDroneReports(messages, classify);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith("Андріан R&D - 1шт");
    expect(out.get("2026-06-25")).toEqual([E("Андріан", true, 1)]);
  });

  it("keeps a lagged date-named report and the same day's own report separate", async () => {
    // The real 06-02 case: newest-first input order must not matter.
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-02T09:32:00Z"), text: "Готові : Андріан R&D - 3 шт" },
      { ts: tsFor("2026-06-02T09:31:00Z"), text: "Готові 01.06 : Андріан R&D - 2 шт" },
    ];
    const classify = vi.fn(async (t: string) =>
      t.includes("01.06")
        ? { entries: [E("Андріан", true, 2)], forDate: "2026-06-01" }
        : { entries: [E("Андріан", true, 3)], forDate: null },
    );
    const out = await extractDroneReports(messages, classify);
    expect(out.get("2026-06-01")).toEqual([E("Андріан", true, 2)]);
    expect(out.get("2026-06-02")).toEqual([E("Андріан", true, 3)]);
  });

  it("reassigns entries to an explicit forDate and merges across source days", async () => {
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-25T09:00:00Z"), text: "for 2026-06-20: Андріан 1шт" },
      { ts: tsFor("2026-06-26T09:00:00Z"), text: "for 2026-06-20: Андріан 2шт" },
    ];
    const classify = vi.fn(async (t: string) => ({
      entries: [E("Андріан", true, t.includes("2шт") ? 2 : 1)],
      forDate: "2026-06-20",
    }));
    const out = await extractDroneReports(messages, classify);
    expect(out.get("2026-06-20")).toEqual([E("Андріан", true, 3)]);
    expect(out.has("2026-06-25")).toBe(false);
  });

  it("skips candidate messages the classifier judges not to be reports", async () => {
    const messages: DroneMessage[] = [{ ts: tsFor("2026-06-25T09:00:00Z"), text: "балачки про шт" }];
    const classify = vi.fn(async () => ({ entries: [], forDate: null }));
    const out = await extractDroneReports(messages, classify);
    expect(out.size).toBe(0);
  });

  it("isolates classifier failures per message, continuing with the others", async () => {
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-25T09:00:00Z"), text: "Андріан R&D - 1шт" },
      { ts: tsFor("2026-06-26T09:00:00Z"), text: "Влад R&D - 2шт" },
    ];
    const classify = vi.fn(async (text: string) => {
      if (text.includes("Влад")) {
        throw new Error("Classifier API error");
      }
      return { entries: [E("Андріан", true, 1)], forDate: null };
    });
    const out = await extractDroneReports(messages, classify);
    // Should have the successful day
    expect(out.get("2026-06-25")).toEqual([E("Андріан", true, 1)]);
    // Failed day should not be in the map
    expect(out.has("2026-06-26")).toBe(false);
  });
});
