import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readReportJson: vi.fn(),
  readPublished: vi.fn(),
  postMessage: vi.fn(),
}));
vi.mock("./reports", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, readReportJson: mocks.readReportJson };
});
vi.mock("./published", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, readPublished: mocks.readPublished };
});
vi.mock("./slack", () => ({
  postMessage: mocks.postMessage,
  permalinkFor: (c: string, ts: string) => `https://slack/${c}/p${ts.replace(".", "")}`,
}));

import { assembleSummaryDays, postFieldSummary } from "./fieldSummaryPost";

const period = { start: "2026-08-01", end: "2026-08-31" };
const verdictDay = (over: Record<string, unknown>) => ({
  date: "2026-08-25",
  reportTs: "1787677696.151879",
  reportSeq: 1,
  reportCount: 1,
  status: "ACCEPTED",
  airborneMinutes: 94,
  videoMinutes: 73,
  ratio: 0.78,
  datasetStatus: "POSTED",
  withinGrace: false,
  reasons: [],
  roster: ["Андріан", "Влад"],
  unknownInitials: [],
  airborneReported: true,
  deployWindow: { start: "16:00", end: "19:35" },
  deployMin: 215,
  droneReportPresent: false,
  hasZvit: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readReportJson.mockImplementation(async (feature: string) => {
    if (feature === "field-verdict") {
      return {
        days: [
          // gate: the verdict already names the owners without their own count, INCLUDING approver eligibility
          verdictDay({ droneMissingSubmitters: ["Андріан"] }),
          verdictDay({
            date: "2026-08-04",
            reportTs: "1785858985.200759",
            status: "ACCEPTED_EXCEPTION",
            roster: ["Андріан"],
            reasons: ["drones did not fly (0 flights, 0 min airborne)", "exception (Bohdan Forostianyi): Approver accepted."],
            // no droneMissingSubmitters key at all → nobody named
          }),
          verdictDay({ date: "2026-08-07", reportTs: null, status: "REJECTED", roster: [], deployWindow: null, deployMin: null, hasZvit: false, reasons: ["rejected (Oleksandr K): no crew."] }),
        ],
      };
    }
    if (feature === "field-qa") return { days: [{ date: "2026-08-25", droneReport: [{ name: "Влад", isPerson: true, count: 4 }], droneSubmitters: ["U091JDN2U5B"] }] };
    return null; // no field-bonus committed
  });
  mocks.readPublished.mockResolvedValue({
    "2026-08-25#1787677696.151879": { ts: "1787725893.483389" },
    "2026-08-07": { ts: "1786602644280.149" },
  });
  mocks.postMessage.mockResolvedValue("1788400000.000100");
});

describe("assembleSummaryDays", () => {
  it("takes gate exclusions from the verdict's droneMissingSubmitters (same predicate + eligibility as the pay gate), never re-derives them", async () => {
    const days = await assembleSummaryDays(period);
    const d25 = days.find((d) => d.date === "2026-08-25")!;
    expect(d25.gateExcluded).toEqual(["Андріан"]);
    const d04 = days.find((d) => d.date === "2026-08-04")!;
    expect(d04.gateExcluded).toEqual([]); // attribution unknown → nobody publicly named
  });

  it("parses the approver out of exception/rejected reasons and links verdict by date#reportTs or bare date", async () => {
    const days = await assembleSummaryDays(period);
    const d04 = days.find((d) => d.date === "2026-08-04")!;
    expect(d04.approver).toBe("Bohdan Forostianyi");
    const d25 = days.find((d) => d.date === "2026-08-25")!;
    expect(d25.verdictUrl).toBe("https://slack/C08GY2NKF9D/p1787725893483389");
    expect(d25.zvitUrl).toBe("https://slack/C08GY2NKF9D/p1787677696151879");
    const d07 = days.find((d) => d.date === "2026-08-07")!;
    expect(d07.approver).toBe("Oleksandr K");
    expect(d07.verdictUrl).toContain("p1786602644280149");
    expect(d07.zvitUrl).toBeNull();
  });

  it("with a committed bonus report: accepted-day crew left out of paidRoster for OTHER reasons (eligibility, 0-airborne gate) is listed as notCounted, never mislabelled as a drone-gate miss", async () => {
    mocks.readReportJson.mockImplementation(async (feature: string) => {
      if (feature === "field-verdict") return { days: [verdictDay({ roster: ["Андріан", "Влад", "Данило"], droneMissingSubmitters: ["Андріан"] })] };
      if (feature === "field-bonus") return { days: [{ date: "2026-08-25", reportTs: "1787677696.151879", roster: ["Андріан", "Влад", "Данило"], paidRoster: ["Влад"] }] };
      return null;
    });
    const [d] = await assembleSummaryDays(period);
    expect(d.gateExcluded).toEqual(["Андріан"]);
    expect(d.notCounted).toEqual(["Данило"]); // unpaid, but not because of the drone gate
  });

  it("without a bonus report notCounted is empty (nothing to claim)", async () => {
    const days = await assembleSummaryDays(period);
    for (const d of days) expect(d.notCounted).toEqual([]);
  });

  it("derives early (≤12:30 start) and weekend from the verdict itself, without a bonus report", async () => {
    mocks.readReportJson.mockImplementation(async (feature: string) =>
      feature === "field-verdict"
        ? { days: [verdictDay({ date: "2026-08-22", deployWindow: { start: "12:30", end: "18:00" } })] }
        : null,
    );
    const [d] = await assembleSummaryDays(period);
    expect(d.early).toBe(true);
    expect(d.weekend).toBe(true);
  });

  it("carries the report position for multi-report days", async () => {
    mocks.readReportJson.mockImplementation(async (feature: string) =>
      feature === "field-verdict" ? { days: [verdictDay({ reportSeq: 2, reportCount: 2 })] } : null,
    );
    const [d] = await assembleSummaryDays(period);
    expect(d.reportSeq).toBe(2);
    expect(d.reportCount).toBe(2);
  });
});

describe("postFieldSummary", () => {
  it("channel-scopes every outbound key so a test-channel publish cannot dedup the #field-qa one", async () => {
    await postFieldSummary({ channelId: "C08GY2NKF9D", period, today: "2026-09-03", trigger: "cli" });
    const keys = mocks.postMessage.mock.calls.map((c) => c[2].key as string);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const k of keys) expect(k).toContain(":field-qa:");
    expect(keys[0]).toMatch(/:anchor$/);
    expect(keys[1]).toMatch(/:t1$/);
  });

  it("thread mode: anchor is a reply in the given thread, day lines hang under the same root, keys carry the thread", async () => {
    await postFieldSummary({ channelId: "C08GY2NKF9D", period, today: "2026-09-03", threadTs: "1788300000.000001", trigger: "webhook" });
    for (const call of mocks.postMessage.mock.calls) {
      expect(call[3]).toBe("1788300000.000001");
      expect(call[2].key).toContain("1788300000.000001");
    }
  });

  it("throws instead of scattering day lines top-level when the anchor send was skipped (stuck pending reservation → empty ts)", async () => {
    mocks.postMessage.mockResolvedValueOnce("");
    await expect(postFieldSummary({ channelId: "C08GY2NKF9D", period, today: "2026-09-03", trigger: "cli" })).rejects.toThrow();
    expect(mocks.postMessage).toHaveBeenCalledTimes(1);
  });

  it("refuses an untracked channel before reading anything", async () => {
    await expect(postFieldSummary({ channelId: "C_NOPE", period, today: "2026-09-03", trigger: "cli" })).rejects.toThrow(/не відстежується/);
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });
});
