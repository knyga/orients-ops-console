import { describe, it, expect, vi } from "vitest";
vi.mock("./droneCountReport", () => ({ classifyDroneCount: vi.fn() }));
import { extractDroneReports, type DroneMessage } from "./extractDroneReports";
import { type DroneEntry } from "./droneReport";

const E = (name: string, isPerson: boolean, count: number): DroneEntry => ({ name, isPerson, count });
// 2026-06-25 12:00 Kyiv ≈ 09:00 UTC. Use a fixed UTC ts that maps to the Kyiv day.
const tsFor = (isoUtc: string) => String(Math.floor(new Date(isoUtc).getTime() / 1000));

describe("extractDroneReports", () => {
  it("attributes to the post date; a later same-day report replaces the earlier (snapshot, not increment)", async () => {
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-25T09:00:00Z"), text: "Андріан R&D - 1шт" },
      { ts: tsFor("2026-06-25T15:00:00Z"), text: "Андріан R&D - 3шт" },
    ];
    const classify = vi.fn(async (t: string) => ({
      reports: [{ entries: [E("Андріан", true, t.includes("3шт") ? 3 : 1)], forDate: null }],
    }));
    const out = await extractDroneReports(messages, classify);
    // one classify call PER candidate message; the LAST report for a day wins.
    expect(classify).toHaveBeenCalledTimes(2);
    expect(out.byDate.get("2026-06-25")).toEqual([E("Андріан", true, 3)]);
  });

  it("skips non-candidate messages (no шт tally) without a classify call", async () => {
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-25T09:00:00Z"), text: "просто балачки без звіту" },
      { ts: tsFor("2026-06-25T10:00:00Z"), text: "Андріан R&D - 1шт" },
    ];
    const classify = vi.fn(async () => ({ reports: [{ entries: [E("Андріан", true, 1)], forDate: null }] }));
    const out = await extractDroneReports(messages, classify);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith("Андріан R&D - 1шт", "2026-06-25");
    expect(out.byDate.get("2026-06-25")).toEqual([E("Андріан", true, 1)]);
  });

  it("keeps a lagged date-named report and the same day's own report separate", async () => {
    // The real 06-02 case: newest-first input order must not matter.
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-02T09:32:00Z"), text: "Готові : Андріан R&D - 3 шт" },
      { ts: tsFor("2026-06-02T09:31:00Z"), text: "Готові 01.06 : Андріан R&D - 2 шт" },
    ];
    const classify = vi.fn(async (t: string) =>
      t.includes("01.06")
        ? { reports: [{ entries: [E("Андріан", true, 2)], forDate: "2026-06-01" }] }
        : { reports: [{ entries: [E("Андріан", true, 3)], forDate: null }] },
    );
    const out = await extractDroneReports(messages, classify);
    expect(out.byDate.get("2026-06-01")).toEqual([E("Андріан", true, 2)]);
    expect(out.byDate.get("2026-06-02")).toEqual([E("Андріан", true, 3)]);
  });

  // Regression: the real 06-25 message carried 23.06 / 24.06 / 25.06 sections in
  // ONE message; the old single-report shape lost 06-24 entirely and stamped
  // 06-23's numbers onto 06-25.
  it("attributes each dated section of a multi-date message to its own day", async () => {
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-25T10:56:00Z"), text: "23.06 Андріан - 5шт\n24.06 Андріан - 4шт\n25.06 Андріан - 3шт" },
    ];
    const classify = vi.fn(async () => ({
      reports: [
        { entries: [E("Андріан", true, 5)], forDate: "2026-06-23" },
        { entries: [E("Андріан", true, 4)], forDate: "2026-06-24" },
        { entries: [E("Андріан", true, 3)], forDate: "2026-06-25" },
      ],
    }));
    const out = await extractDroneReports(messages, classify);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(out.byDate.get("2026-06-23")).toEqual([E("Андріан", true, 5)]);
    expect(out.byDate.get("2026-06-24")).toEqual([E("Андріан", true, 4)]);
    expect(out.byDate.get("2026-06-25")).toEqual([E("Андріан", true, 3)]);
  });

  it("reassigns entries to an explicit forDate; a later restatement replaces the earlier report", async () => {
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-25T09:00:00Z"), text: "for 2026-06-20: Андріан 1шт" },
      { ts: tsFor("2026-06-26T09:00:00Z"), text: "for 2026-06-20: Андріан 2шт" },
    ];
    const classify = vi.fn(async (t: string) => ({
      reports: [{ entries: [E("Андріан", true, t.includes("2шт") ? 2 : 1)], forDate: "2026-06-20" }],
    }));
    const out = await extractDroneReports(messages, classify);
    expect(out.byDate.get("2026-06-20")).toEqual([E("Андріан", true, 2)]);
    expect(out.byDate.has("2026-06-25")).toBe(false);
  });

  // Regression: the real 06-02 case — the day's own "Готові" post plus a lagged
  // "02.06 Готові" restatement posted 06-04. Summing them doubled every entry
  // (Андріан 4, Любомир 6, Демо 16); the restatement must WIN, not add.
  it("lets a lagged date-named restatement replace the day's own earlier report", async () => {
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-04T14:29:00Z"), text: "02.06 Готові : Андріан R&D - 1 шт" },
      { ts: tsFor("2026-06-02T09:32:00Z"), text: "Готові : Андріан R&D - 3 шт" },
    ];
    const classify = vi.fn(async (t: string) =>
      t.includes("02.06")
        ? { reports: [{ entries: [E("Андріан", true, 1)], forDate: "2026-06-02" }] }
        : { reports: [{ entries: [E("Андріан", true, 3)], forDate: null }] },
    );
    const out = await extractDroneReports(messages, classify);
    expect(out.byDate.get("2026-06-02")).toEqual([E("Андріан", true, 1)]);
  });

  it("merges same-date entries WITHIN one message instead of replacing", async () => {
    const messages: DroneMessage[] = [
      { ts: tsFor("2026-06-25T09:00:00Z"), text: "Андріан - 1шт\n…\nАндріан - 1шт азимут" },
    ];
    const classify = vi.fn(async () => ({
      reports: [
        { entries: [E("Андріан", true, 1)], forDate: null },
        { entries: [E("Андріан", true, 1)], forDate: null },
      ],
    }));
    const out = await extractDroneReports(messages, classify);
    expect(out.byDate.get("2026-06-25")).toEqual([E("Андріан", true, 2)]);
  });

  it("skips candidate messages the classifier judges not to be reports", async () => {
    const messages: DroneMessage[] = [{ ts: tsFor("2026-06-25T09:00:00Z"), text: "балачки про шт" }];
    const classify = vi.fn(async () => ({ reports: [] }));
    const out = await extractDroneReports(messages, classify);
    expect(out.byDate.size).toBe(0);
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
      return { reports: [{ entries: [E("Андріан", true, 1)], forDate: null }] };
    });
    const out = await extractDroneReports(messages, classify);
    // Should have the successful day
    expect(out.byDate.get("2026-06-25")).toEqual([E("Андріан", true, 1)]);
    // Failed day should not be in the map — it's unknown, not "no report".
    expect(out.byDate.has("2026-06-26")).toBe(false);
    expect(out.failedDates.has("2026-06-26")).toBe(true);
    expect(out.failedDates.has("2026-06-25")).toBe(false);
  });
});
