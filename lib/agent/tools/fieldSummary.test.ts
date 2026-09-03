import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assembleSummaryDays: vi.fn(),
  applyProposal: vi.fn(),
}));
vi.mock("@/lib/fieldSummaryPost", () => ({ assembleSummaryDays: mocks.assembleSummaryDays }));
vi.mock("@/lib/proposalExecutor", () => ({ applyProposal: mocks.applyProposal }));

import { fieldSummaryTools } from "./fieldSummary";

const tool = fieldSummaryTools.find((t) => t.name === "field_summary_post")!;
const day = (date: string, status: string) => ({ date, status });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assembleSummaryDays.mockResolvedValue([
    day("2026-08-19", "ACCEPTED"),
    day("2026-08-20", "ACCEPTED_EXCEPTION"),
    day("2026-08-13", "NEEDS_REVIEW"),
    day("2026-08-05", "REJECTED"),
    day("2026-08-31", "PENDING"),
  ]);
});

describe("field_summary_post", () => {
  it("is a confirm-first write tool", () => {
    expect(tool.kind).toBe("write");
    expect(tool.propose).toBeDefined();
    expect(tool.run).toBeUndefined();
  });

  it("from a channel mention: proposes a new anchor + thread in that channel, echo names month + live counts", async () => {
    // A top-level @mention: Slack hands the loop threadTs === the mention's own ts, inThread false.
    const p = await tool.propose!({ start: "2026-08-01", end: "2026-08-31" }, { channelId: "C08GY2NKF9D", threadTs: "1788390000.000001", inThread: false });
    expect(p.kind).toBe("field_summary_post");
    expect(p.params).toEqual({ channelId: "C08GY2NKF9D", threadTs: null, start: "2026-08-01", end: "2026-08-31" });
    expect(p.echoUk).toContain("серпень 2026");
    expect(p.echoUk).toContain("✅ 2");
    expect(p.echoUk).toContain("⚠️ 1");
    expect(p.echoUk).toContain("⛔ 1");
    expect(p.echoUk).toContain("⏳ 1");
    expect(p.echoUk).toContain("так/ні");
    expect(mocks.assembleSummaryDays).toHaveBeenCalledWith({ start: "2026-08-01", end: "2026-08-31" });
  });

  it("from inside a thread: posts into THAT thread (params carry threadTs) and the echo says so", async () => {
    const p = await tool.propose!(
      { start: "2026-08-01", end: "2026-08-31" },
      { channelId: "C08GY2NKF9D", threadTs: "1788400000.000100", inThread: true },
    );
    expect(p.params.threadTs).toBe("1788400000.000100");
    expect(p.echoUk).toContain("у цьому треді");
  });

  it("refuses outside Slack (no channel in context) in Ukrainian", async () => {
    await expect(tool.propose!({ start: "2026-08-01", end: "2026-08-31" }, {})).rejects.toThrow(/лише у Slack/);
  });

  it("rejects a malformed or inverted period", async () => {
    await expect(tool.propose!({ start: "серпень", end: "2026-08-31" }, { channelId: "C1" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(tool.propose!({ start: "2026-08-31", end: "2026-08-01" }, { channelId: "C1" })).rejects.toThrow();
  });

  it("apply() routes through the deterministic executor with the same params", async () => {
    mocks.applyProposal.mockResolvedValue("ok");
    const p = await tool.propose!({ start: "2026-08-01", end: "2026-08-31" }, { channelId: "C1" });
    await p.apply();
    expect(mocks.applyProposal).toHaveBeenCalledWith("field_summary_post", p.params);
  });
});
