import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchMessages, writeReport } = vi.hoisted(() => ({
  fetchMessages: vi.fn(),
  writeReport: vi.fn(),
}));
vi.mock("./slack", () => ({ fetchMessages, downloadFileBase64: vi.fn() }));
vi.mock("./flightExtract", () => ({ extractAirborne: vi.fn() }));
vi.mock("./reports", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, writeReport };
});

import { extractFieldQa } from "./fieldQaExtract";

beforeEach(() => {
  fetchMessages.mockReset();
  writeReport.mockReset();
  writeReport.mockResolvedValue({ key: "2026-06" });
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
});
