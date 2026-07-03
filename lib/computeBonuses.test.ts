import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchVideosInPeriod, readChannelMessages, classifyDroneCount, extractLoss, readAliases, readRosterCorrections, writeReport } = vi.hoisted(() => ({
  fetchVideosInPeriod: vi.fn(),
  readChannelMessages: vi.fn(),
  classifyDroneCount: vi.fn(),
  extractLoss: vi.fn(),
  readAliases: vi.fn(),
  readRosterCorrections: vi.fn(),
  writeReport: vi.fn(),
}));
vi.mock("./vimeo", () => ({ fetchVideosInPeriod }));
vi.mock("./slackMirror", () => ({ readChannelMessages }));
vi.mock("./droneCountReport", () => ({ classifyDroneCount }));
vi.mock("./lossExtract", () => ({ extractLoss }));
vi.mock("./rosterAliases", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, readAliases };
});
vi.mock("./rosterCorrections", () => ({ readRosterCorrections }));
vi.mock("./reports", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, writeReport };
});

import { computeBonusReport } from "./computeBonuses";

const PERIOD = { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" };

/** Epoch-seconds Slack ts for a Kyiv-local time (Kyiv is UTC+3 in June). */
const kyivTs = (y: number, mo: number, d: number, h: number) => String(Date.UTC(y, mo - 1, d, h - 3) / 1000);

const msg = (ts: string, text: string) => ({ ts, text, deleted: false, permalink: `https://slack/${ts}`, thread_ts: undefined });

beforeEach(() => {
  vi.clearAllMocks();
  readAliases.mockResolvedValue({});
  readRosterCorrections.mockResolvedValue([]);
  extractLoss.mockResolvedValue({ lost: false, found: false, note: "" });
  writeReport.mockResolvedValue({ key: "2026-06" });
});

describe("computeBonusReport drone-count gate", () => {
  it("credits a flight day whose drone-count report was posted the next day naming the date (forDate)", async () => {
    readChannelMessages.mockResolvedValue([
      // Звіт for 06-01, posted on 06-01: qualifying 3h40m window.
      msg(kyivTs(2026, 6, 1, 19), "Звіт 01.06.2026\nЛ+Т 14:20 - 18:00"),
      // Drone-count report posted the NEXT morning, explicitly for 01.06.
      msg(kyivTs(2026, 6, 2, 12), "Готові 01.06 :\nАндріан R&D - 2 шт ( 1 шт термокамера)"),
    ]);
    fetchVideosInPeriod.mockResolvedValue([{ name: "2026-06-01 flight", created_time: "2026-06-01T10:00:00Z", duration: 300 }]);
    classifyDroneCount.mockImplementation(async (dayText: string) =>
      dayText.includes("Готові 01.06")
        ? { present: true, entries: [{ name: "Андріан", isPerson: true, count: 2 }], forDate: "2026-06-01", note: "" }
        : { present: false, entries: [], forDate: null, note: "" },
    );

    const report = await computeBonusReport(PERIOD);

    const day = report.days.find((d) => d.date === "2026-06-01");
    expect(day?.counted).toBe(true);
    expect(day?.reason).toBe("counted");
    expect(report.voidedDays).toEqual([]);
    expect(report.flags.filter((f) => f.kind === "no_drone_count")).toEqual([]);
  });

  it("still credits a same-day drone-count report with no explicit date", async () => {
    readChannelMessages.mockResolvedValue([
      msg(kyivTs(2026, 6, 2, 19), "Звіт 02.06.2026\nЛ+Т 14:00 - 18:00"),
      msg(kyivTs(2026, 6, 2, 12), "Готові :\nАндріан R&D - 3 шт"),
    ]);
    fetchVideosInPeriod.mockResolvedValue([{ name: "2026-06-02 flight", created_time: "2026-06-02T10:00:00Z", duration: 300 }]);
    classifyDroneCount.mockImplementation(async (dayText: string) =>
      dayText.includes("Готові")
        ? { present: true, entries: [{ name: "Андріан", isPerson: true, count: 3 }], forDate: null, note: "" }
        : { present: false, entries: [], forDate: null, note: "" },
    );

    const report = await computeBonusReport(PERIOD);

    expect(report.days.find((d) => d.date === "2026-06-02")?.counted).toBe(true);
    expect(report.voidedDays).toEqual([]);
  });

  it("still voids an otherwise-counted day with no drone-count report anywhere", async () => {
    readChannelMessages.mockResolvedValue([msg(kyivTs(2026, 6, 3, 19), "Звіт 03.06.2026\nЛ+Т 14:00 - 18:00")]);
    fetchVideosInPeriod.mockResolvedValue([{ name: "2026-06-03 flight", created_time: "2026-06-03T10:00:00Z", duration: 300 }]);
    classifyDroneCount.mockResolvedValue({ present: false, entries: [], forDate: null, note: "" });

    const report = await computeBonusReport(PERIOD);

    const day = report.days.find((d) => d.date === "2026-06-03");
    expect(day?.counted).toBe(false);
    expect(day?.reason).toBe("no-drone-count");
    expect(report.voidedDays).toEqual([{ date: "2026-06-03", roster: ["Любомир", "Тарас"], reason: "no-drone-count" }]);
  });
});
