import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchMessages, writeReport, extractDroneReports } = vi.hoisted(() => ({
  fetchMessages: vi.fn(),
  writeReport: vi.fn(),
  extractDroneReports: vi.fn(),
}));
vi.mock("./slack", () => ({ fetchMessages, downloadFileBase64: vi.fn() }));
vi.mock("./flightExtract", () => ({ extractAirborne: vi.fn() }));
vi.mock("./extractDroneReports", () => ({
  extractDroneReports,
  kyivPostDate: (ts: string) => ts,
}));
vi.mock("./droneCountReport", () => ({ classifyDroneCount: vi.fn() }));
// Keep the real (pure) cache helpers; only stub the DB-backed store to a cold
// no-op so the extract runs without a database in unit tests.
vi.mock("./extractCache", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, dbExtractCacheStore: () => ({ readMany: async () => new Map(), write: async () => {} }) };
});
vi.mock("./reports", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, writeReport };
});

import { extractFieldQa } from "./fieldQaExtract";

beforeEach(() => {
  fetchMessages.mockReset();
  writeReport.mockReset();
  writeReport.mockResolvedValue({ key: "2026-06" });
  extractDroneReports.mockReset();
  extractDroneReports.mockResolvedValue({ byDate: new Map(), failedDates: new Set() });
});

// Real parseable card: parseAirborneFromText needs the `Сьогодні літали` line and
// airborne time in SECONDS (сек), not minutes — see lib/flightTextParse.ts.
const summary = (date: string, seconds: number, ts: string) => ({
  channel: "field-qa",
  ts,
  permalink: `https://slack/${ts}`,
  files: [],
  text: `Статистика польотів за ${date}\nСьогодні літали: Так\nЧас в повітрі: ${seconds} сек\nКількість польотів: 2`,
});

describe("extractFieldQa", () => {
  it("extracts text-parsed days into the report and does not write when write=false", async () => {
    fetchMessages.mockResolvedValue([summary("2026-06-29", 1800, "100.1"), summary("2026-06-30", 1080, "101.2")]);
    const { report, days } = await extractFieldQa(
      { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" },
      { write: false },
    );
    expect(days.map((d) => d.date)).toEqual(["2026-06-29", "2026-06-30"]);
    expect(report.days).toHaveLength(2);
    expect(writeReport).not.toHaveBeenCalled();
  });

  it("persists the DB report when write=true", async () => {
    fetchMessages.mockResolvedValue([summary("2026-06-29", 1800, "100.1")]);
    await extractFieldQa({ start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" }, { write: true });
    expect(writeReport).toHaveBeenCalledOnce();
    expect(writeReport.mock.calls[0][0]).toBe("field-qa");
  });

  it("passes ALL field-qa messages (not just summary cards) to extractDroneReports and attaches the result", async () => {
    fetchMessages.mockResolvedValue([
      summary("2026-06-25", 600, "1000"),
      { channel: "field-qa", ts: "1001", text: "Андріан R&D - 1шт", files: [], permalink: "https://slack/p2" },
    ]);
    extractDroneReports.mockResolvedValue({
      byDate: new Map([["2026-06-25", [{ name: "Андріан", isPerson: true, count: 1 }]]]),
      failedDates: new Set(),
    });

    const { report } = await extractFieldQa({ start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" });

    expect(extractDroneReports).toHaveBeenCalledWith(
      [
        { ts: "1000", text: expect.stringContaining("Статистика") },
        { ts: "1001", text: "Андріан R&D - 1шт" },
      ],
      expect.any(Function), // the cache-wrapped classifier
    );
    expect(report.days.find((d) => d.date === "2026-06-25")?.droneReport).toEqual([
      { name: "Андріан", isPerson: true, count: 1 },
    ]);
  });

  it("emits explicit droneReport [] for classified days but NO key for a failed date", async () => {
    fetchMessages.mockResolvedValue([summary("2026-06-25", 600, "1000"), summary("2026-06-26", 900, "1001")]);
    extractDroneReports.mockResolvedValue({
      byDate: new Map(),
      failedDates: new Set(["2026-06-26"]),
    });

    const { report } = await extractFieldQa({ start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" });

    // 06-25: extraction ran, no report found → explicit [] (gate binds).
    expect(report.days.find((d) => d.date === "2026-06-25")?.droneReport).toEqual([]);
    // 06-26: classification failed → unknown → key omitted (gate skipped).
    expect(report.days.find((d) => d.date === "2026-06-26")).not.toHaveProperty("droneReport");
  });
});
