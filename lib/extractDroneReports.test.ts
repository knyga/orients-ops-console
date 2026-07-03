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
    // both messages fall on the same Kyiv day → one classify call over joined text → but our
    // stub returns one entry per call; same-day grouping means ONE call here.
    expect(classify).toHaveBeenCalledTimes(1);
    expect(out.get("2026-06-25")).toEqual([E("Андріан", true, 1)]);
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

  it("skips days with no drone entries", async () => {
    const messages: DroneMessage[] = [{ ts: tsFor("2026-06-25T09:00:00Z"), text: "just chatter" }];
    const classify = vi.fn(async () => ({ entries: [], forDate: null }));
    const out = await extractDroneReports(messages, classify);
    expect(out.size).toBe(0);
  });
});
