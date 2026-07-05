import { describe, it, expect, vi, beforeEach } from "vitest";

const { postMessage, applyInstruction, createProposal, readActiveProposal, settleProposal, classifyInstruction } =
  vi.hoisted(() => ({
    postMessage: vi.fn(),
    applyInstruction: vi.fn(),
    createProposal: vi.fn(),
    readActiveProposal: vi.fn(),
    settleProposal: vi.fn(),
    classifyInstruction: vi.fn(),
  }));
vi.mock("./slack", () => ({ postMessage }));
vi.mock("./applyInstruction", () => ({ applyInstruction }));
vi.mock("./proposals", () => ({ createProposal, readActiveProposal, settleProposal }));
vi.mock("./instructionClassify", () => ({ classifyInstruction }));

import { applyInstructionReply } from "./applyInstructionReply";
import type { PublishedEntry } from "./published";

const period = { start: "2026-07-01", end: "2026-07-31" };

const entry = (reportTs: string | null): PublishedEntry => ({
  date: "2026-07-01",
  reportTs,
  channel: "field-qa",
  text: "⚠️ 2026-07-01 (середа) — потрібна перевірка.\n👥 У полі: Влад, Тарас.",
  postedAt: "2026-07-02T05:00:00.000Z",
  ts: "1781000000.000100",
});

const activeProposal = {
  id: "p1",
  threadTs: "1781000000.000100",
  channel: "field-qa",
  date: "2026-07-01",
  axis: "dataset" as const,
  payload: { intent: "instruction", axis: "dataset", datasetStatus: "DECLINED", reason: "x" },
  summaryUk: "датасет ⛔ причину відхилено",
  proposedBy: "Oleksandr K",
  sourceReplyTs: "1781000100.000100",
  state: "PROPOSED" as const,
  createdAt: "2026-07-02T05:00:00.000Z",
  resolvedAt: null,
};

beforeEach(() => {
  postMessage.mockReset().mockResolvedValue("1782900000.000200");
  applyInstruction.mockReset().mockResolvedValue({ applied: true });
  createProposal.mockReset().mockResolvedValue({ created: true, proposal: activeProposal });
  readActiveProposal.mockReset().mockResolvedValue(null);
  settleProposal.mockReset().mockResolvedValue("CANCELLED");
  classifyInstruction.mockReset();
});

describe("applyInstructionReply — report-scoped ack keys (second-report thread must not be swallowed)", () => {
  it("a proposal echo for a report-scoped entry (reportTs set) keys the post by date#reportTs, not the bare date", async () => {
    readActiveProposal.mockResolvedValue(null);
    classifyInstruction.mockResolvedValue({
      intent: "instruction",
      axis: "dataset",
      datasetStatus: "DECLINED",
      reason: "x",
    });

    const res = await applyInstructionReply({
      entry: entry("2.0"),
      period,
      replyText: "датасет відхилено",
      approverName: "Oleksandr K",
      replyPermalink: "https://slack/permalink",
      replyTs: "1781000200.000100",
    });

    expect(res.handled).toBe("proposed");
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [, , opts] = postMessage.mock.calls[0];
    expect(opts.key).toContain("2026-07-01#2.0");
    expect(opts.key).not.toBe(`instruction-ack:2026-07-01:propose:${opts.key.split(":").pop()}`);
  });

  it("a cancel note for a report-scoped entry (reportTs set) keys the post by date#reportTs, not the bare date", async () => {
    readActiveProposal.mockResolvedValue(activeProposal);
    classifyInstruction.mockResolvedValue({ intent: "cancel" });
    settleProposal.mockResolvedValue("CANCELLED");

    const res = await applyInstructionReply({
      entry: entry("2.0"),
      period,
      replyText: "ні",
      approverName: "Oleksandr K",
      replyPermalink: "https://slack/permalink",
      replyTs: "1781000200.000100",
    });

    expect(res.handled).toBe("cancelled");
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [, , opts] = postMessage.mock.calls[0];
    expect(opts.key).toContain("2026-07-01#2.0");
  });

  it("a legacy no-report entry (reportTs null) still keys by the bare date", async () => {
    readActiveProposal.mockResolvedValue(null);
    classifyInstruction.mockResolvedValue({
      intent: "instruction",
      axis: "dataset",
      datasetStatus: "DECLINED",
      reason: "x",
    });

    await applyInstructionReply({
      entry: entry(null),
      period,
      replyText: "датасет відхилено",
      approverName: "Oleksandr K",
      replyPermalink: "https://slack/permalink",
      replyTs: "1781000200.000100",
    });

    const [, , opts] = postMessage.mock.calls[0];
    expect(opts.key).toBe(`instruction-ack:2026-07-01:propose:${opts.key.split(":").pop()}`);
  });
});
