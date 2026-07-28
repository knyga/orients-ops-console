import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchRawMessages, writeReport, extractDroneReportsCached, readOutbound } = vi.hoisted(() => ({
  fetchRawMessages: vi.fn(),
  writeReport: vi.fn(),
  extractDroneReportsCached: vi.fn(),
  readOutbound: vi.fn(),
}));
vi.mock("./slack", () => ({ fetchRawMessages, downloadFileBase64: vi.fn() }));
vi.mock("./flightExtract", () => ({ extractAirborne: vi.fn() }));
vi.mock("./extractDroneReports", () => ({ extractDroneReportsCached }));
vi.mock("./outbound", () => ({ readOutbound }));
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
  fetchRawMessages.mockReset();
  writeReport.mockReset();
  writeReport.mockResolvedValue({ key: "2026-06" });
  readOutbound.mockReset();
  readOutbound.mockResolvedValue([]);
  extractDroneReportsCached.mockReset();
  extractDroneReportsCached.mockResolvedValue({
    byDate: new Map(),
    submittersByDate: new Map(),
    failedDates: new Set(),
    misses: 0,
  });
});

// Real parseable card: parseAirborneFromText needs the `Сьогодні літали` line and
// airborne time in SECONDS (сек), not minutes — see lib/flightTextParse.ts.
const summary = (date: string, seconds: number, ts: string) => ({
  channel: "field-qa",
  ts,
  authorId: "B_STATS",
  permalink: `https://slack/${ts}`,
  files: [],
  text: `Статистика польотів за ${date}\nСьогодні літали: Так\nЧас в повітрі: ${seconds} сек\nКількість польотів: 2`,
});

describe("extractFieldQa", () => {
  it("extracts text-parsed days into the report and does not write when write=false", async () => {
    fetchRawMessages.mockResolvedValue([summary("2026-06-29", 1800, "100.1"), summary("2026-06-30", 1080, "101.2")]);
    const { report, days } = await extractFieldQa(
      { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" },
      { write: false },
    );
    expect(days.map((d) => d.date)).toEqual(["2026-06-29", "2026-06-30"]);
    expect(report.days).toHaveLength(2);
    expect(writeReport).not.toHaveBeenCalled();
    // Raw fetch (incl. thread replies), scoped to the field-qa channel only.
    expect(fetchRawMessages).toHaveBeenCalledWith(
      { start: "2026-06-01", end: "2026-06-30" },
      [expect.objectContaining({ name: "field-qa" })],
    );
  });

  it("persists the DB report when write=true", async () => {
    fetchRawMessages.mockResolvedValue([summary("2026-06-29", 1800, "100.1")]);
    await extractFieldQa({ start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" }, { write: true });
    expect(writeReport).toHaveBeenCalledOnce();
    expect(writeReport.mock.calls[0][0]).toBe("field-qa");
  });

  it("passes ALL field-qa messages (with author/thread) to the cached extraction and attaches the result", async () => {
    fetchRawMessages.mockResolvedValue([
      summary("2026-06-25", 600, "1000"),
      { channel: "field-qa", ts: "1001", authorId: "U09AAVAEE6L", text: "Андріан R&D - 1шт", files: [], permalink: "https://slack/p2" },
    ]);
    extractDroneReportsCached.mockResolvedValue({
      byDate: new Map([["2026-06-25", [{ name: "Андріан", isPerson: true, count: 1 }]]]),
      submittersByDate: new Map([["2026-06-25", new Set(["U09AAVAEE6L"])]]),
      failedDates: new Set(),
      misses: 1,
    });

    const { report } = await extractFieldQa({ start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" });

    expect(extractDroneReportsCached).toHaveBeenCalledWith(
      [
        expect.objectContaining({ ts: "1000", text: expect.stringContaining("Статистика") }),
        expect.objectContaining({ ts: "1001", text: "Андріан R&D - 1шт", authorId: "U09AAVAEE6L" }),
      ],
      new Map(),
    );
    expect(report.days.find((d) => d.date === "2026-06-25")?.droneReport).toEqual([
      { name: "Андріан", isPerson: true, count: 1 },
    ]);
    expect(report.days.find((d) => d.date === "2026-06-25")?.droneSubmitters).toEqual(["U09AAVAEE6L"]);
  });

  it("builds reminder anchors from the outbound send record, never from message text", async () => {
    fetchRawMessages.mockResolvedValue([
      summary("2026-08-03", 600, "3000.1"),
      // A USER message that merely looks like a reminder must NOT become an anchor.
      { channel: "field-qa", ts: "3000.2", authorId: "U_TROLL", text: "🛸 Звіт по дронах за 03.08", files: [], permalink: "https://slack/p4" },
    ]);
    readOutbound.mockResolvedValue([
      { feature: "drone-reminder", status: "sent", ts: "3000.5", key: "drone-reminder:2026-08-03" },
      { feature: "verdict", status: "sent", ts: "3000.6", key: "verdict:x" },
    ]);
    await extractFieldQa({ start: "2026-08-01", end: "2026-08-31", timezone: "Europe/Kyiv" });
    expect(readOutbound).toHaveBeenCalledWith({ start: "2026-08-01", end: "2026-08-31" });
    const anchors = extractDroneReportsCached.mock.calls[0][1];
    expect(anchors).toEqual(new Map([["3000.5", "2026-08-03"]]));
  });

  it("emits explicit droneReport [] for classified days but NO key for a failed date", async () => {
    fetchRawMessages.mockResolvedValue([summary("2026-06-25", 600, "1000"), summary("2026-06-26", 900, "1001")]);
    extractDroneReportsCached.mockResolvedValue({
      byDate: new Map(),
      submittersByDate: new Map(),
      failedDates: new Set(["2026-06-26"]),
      misses: 0,
    });

    const { report } = await extractFieldQa({ start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" });

    // 06-25: extraction ran, no report found → explicit [] ("ran, found
    // none"), never an absent key (which would mean "unknown / never ran").
    expect(report.days.find((d) => d.date === "2026-06-25")?.droneReport).toEqual([]);
    expect(report.days.find((d) => d.date === "2026-06-25")?.droneSubmitters).toEqual([]);
    // 06-26: classification failed → unknown → keys omitted (gate skipped).
    expect(report.days.find((d) => d.date === "2026-06-26")).not.toHaveProperty("droneReport");
    expect(report.days.find((d) => d.date === "2026-06-26")).not.toHaveProperty("droneSubmitters");
  });
});
