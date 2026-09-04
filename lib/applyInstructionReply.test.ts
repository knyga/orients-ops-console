import { describe, it, expect, vi, beforeEach } from "vitest";

const { postMessage, applyInstruction, createProposal, readActiveProposals, settleProposal, classifyInstruction, findPublishedByTs } =
  vi.hoisted(() => ({
    postMessage: vi.fn(),
    applyInstruction: vi.fn(),
    createProposal: vi.fn(),
    readActiveProposals: vi.fn(),
    settleProposal: vi.fn(),
    classifyInstruction: vi.fn(),
    findPublishedByTs: vi.fn(),
  }));
vi.mock("./published", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, findPublishedByTs };
});
vi.mock("./slack", () => ({ postMessage }));
vi.mock("./applyInstruction", () => ({ applyInstruction }));
vi.mock("./proposals", () => ({ createProposal, readActiveProposals, settleProposal }));
vi.mock("./instructionClassify", () => ({ classifyInstruction }));

import { applyInstructionReply, applyClassifiedInstruction } from "./applyInstructionReply";
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
  origin: "approver" as const,
  sourceReplyTs: "1781000100.000100",
  state: "PROPOSED" as const,
  createdAt: "2026-07-02T05:00:00.000Z",
  resolvedAt: null,
};

beforeEach(() => {
  postMessage.mockReset().mockResolvedValue("1782900000.000200");
  applyInstruction.mockReset().mockResolvedValue({ applied: true });
  createProposal.mockReset().mockResolvedValue({ created: true, proposal: activeProposal });
  readActiveProposals.mockReset().mockResolvedValue([]);
  settleProposal.mockReset().mockResolvedValue("CANCELLED");
  classifyInstruction.mockReset();
  findPublishedByTs.mockReset().mockResolvedValue(null);
});

describe("applyInstructionReply — report-scoped ack keys (second-report thread must not be swallowed)", () => {
  it("a proposal echo for a report-scoped entry (reportTs set) keys the post by date#reportTs, not the bare date", async () => {
    readActiveProposals.mockResolvedValue([]);
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
    readActiveProposals.mockResolvedValue([activeProposal]);
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
    readActiveProposals.mockResolvedValue([]);
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

describe("applyInstructionReply — per-reply outbound salt (flip-back must re-post)", () => {
  it("a confirm passes the proposal's source reply ts as the apply salt", async () => {
    readActiveProposals.mockResolvedValue([activeProposal]);
    classifyInstruction.mockResolvedValue({ intent: "confirm" });
    settleProposal.mockResolvedValue("CONFIRMED");

    await applyInstructionReply({
      entry: entry(null), period, replyText: "так", approverName: "Oleksandr K",
      replyPermalink: "https://slack/ok", replyTs: "1781000300.000100",
    });

    expect(applyInstruction).toHaveBeenCalledWith(expect.objectContaining({ salt: activeProposal.sourceReplyTs }));
  });

  it("a proposal echo is keyed by the instructing reply's ts, so an identical re-instruction echoes again", async () => {
    classifyInstruction.mockResolvedValue({ intent: "instruction", axis: "day", decision: "accepted_exception", reason: "x" });

    await applyInstructionReply({
      entry: entry(null), period, replyText: "прийняти", approverName: "Oleksandr K",
      replyPermalink: "https://slack/p", replyTs: "1788510237.178909",
    });

    expect(postMessage.mock.calls[0][2].key).toBe("instruction-ack:2026-07-01:propose:1788510237.178909");
  });

  it("a failed proposal echo CANCELS the unseen proposal and rethrows (no hidden confirmable proposal)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    postMessage.mockRejectedValue(new Error("slack down"));
    classifyInstruction.mockResolvedValue({ intent: "instruction", axis: "day", decision: "accepted_exception", reason: "x" });

    await expect(
      applyInstructionReply({
        entry: entry(null), period, replyText: "прийняти", approverName: "Oleksandr K",
        replyPermalink: "https://slack/p", replyTs: "1788510237.178909",
      }),
    ).rejects.toThrow("slack down");

    expect(settleProposal).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }), "cancel");
    spy.mockRestore();
  });

  it("a cancel note is keyed by the cancelling reply's ts", async () => {
    readActiveProposals.mockResolvedValue([activeProposal]);
    classifyInstruction.mockResolvedValue({ intent: "cancel" });
    settleProposal.mockResolvedValue("CANCELLED");

    await applyInstructionReply({
      entry: entry(null), period, replyText: "ні", approverName: "Oleksandr K",
      replyPermalink: "https://slack/no", replyTs: "1781000300.000200",
    });

    expect(postMessage.mock.calls[0][2].key).toBe("instruction-ack:2026-07-01:cancel:1781000300.000200");
  });
});

describe("applyInstructionReply — several pending proposals (different axes) in one thread", () => {
  const dayProposal = {
    ...activeProposal,
    id: "p-day",
    axis: "day" as const,
    payload: { intent: "instruction", axis: "day", decision: "accepted_exception", reason: "ok" },
    summaryUk: "прийняти день 2026-07-01 (виняток)",
    sourceReplyTs: "1781000100.000200",
    createdAt: "2026-07-02T05:00:00.000Z",
  };
  const crewProposal = {
    ...activeProposal,
    id: "p-crew",
    axis: "crew" as const,
    payload: { intent: "instruction", axis: "crew", crew: ["Влад", "Сергій"], reason: "ok" },
    summaryUk: "склад 2026-07-01: Влад, Сергій",
    sourceReplyTs: "1781000100.000300",
    createdAt: "2026-07-02T05:01:00.000Z",
  };

  it("«так» applies EVERY pending proposal, oldest first", async () => {
    readActiveProposals.mockResolvedValue([dayProposal, crewProposal]);
    classifyInstruction.mockResolvedValue({ intent: "confirm" });
    settleProposal.mockResolvedValue("CONFIRMED");

    const res = await applyInstructionReply({
      entry: entry(null), period, replyText: "так", approverName: "Oleksandr K",
      replyPermalink: "https://slack/ok", replyTs: "1781000300.000100",
    });

    expect(res.handled).toBe("confirmed");
    expect(settleProposal).toHaveBeenCalledTimes(2);
    expect(applyInstruction).toHaveBeenCalledTimes(2);
    expect(applyInstruction.mock.calls.map((c) => c[0].axis)).toEqual(["day", "crew"]);
  });

  it("«ні» cancels EVERY pending proposal and posts one note naming them all", async () => {
    readActiveProposals.mockResolvedValue([dayProposal, crewProposal]);
    classifyInstruction.mockResolvedValue({ intent: "cancel" });
    settleProposal.mockResolvedValue("CANCELLED");

    const res = await applyInstructionReply({
      entry: entry(null), period, replyText: "ні", approverName: "Oleksandr K",
      replyPermalink: "https://slack/no", replyTs: "1781000300.000200",
    });

    expect(res.handled).toBe("cancelled");
    expect(settleProposal).toHaveBeenCalledTimes(2);
    expect(applyInstruction).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [, text] = postMessage.mock.calls[0];
    expect(text).toContain(dayProposal.summaryUk);
    expect(text).toContain(crewProposal.summaryUk);
  });

  it("the classifier sees every pending echo, not just the newest", async () => {
    readActiveProposals.mockResolvedValue([dayProposal, crewProposal]);
    classifyInstruction.mockResolvedValue({ intent: "confirm" });
    settleProposal.mockResolvedValue("CONFIRMED");
    await applyInstructionReply({
      entry: entry(null), period, replyText: "так", approverName: "Oleksandr K",
      replyPermalink: "https://slack/ok", replyTs: "1781000300.000300",
    });
    const pendingEcho = classifyInstruction.mock.calls[0][2] as string;
    expect(pendingEcho).toContain(dayProposal.summaryUk);
    expect(pendingEcho).toContain(crewProposal.summaryUk);
  });

  it("a new instruction while another axis is pending echoes that both await one «так»", async () => {
    readActiveProposals.mockResolvedValue([dayProposal]);
    classifyInstruction.mockResolvedValue({ intent: "instruction", axis: "crew", crew: ["Влад", "Сергій"], reason: "x" });
    createProposal.mockResolvedValue({ created: true, proposal: crewProposal });

    const res = await applyInstructionReply({
      entry: entry(null), period, replyText: "склад: Влад, Сергій", approverName: "Oleksandr K",
      replyPermalink: "https://slack/crew", replyTs: "1781000300.000400",
    });

    expect(res.handled).toBe("proposed");
    const [, text] = postMessage.mock.calls[0];
    expect(text).toContain(dayProposal.summaryUk); // the still-pending accept is named in the echo
  });
});

describe("applyInstructionReply — partial failure across several pending proposals", () => {
  const dayProposal = { ...activeProposal, id: "p-day", axis: "day" as const, summaryUk: "прийняти день 2026-07-01 (виняток)", sourceReplyTs: "1781000100.000200" };
  const crewProposal = { ...activeProposal, id: "p-crew", axis: "crew" as const, summaryUk: "склад 2026-07-01: Влад, Сергій", sourceReplyTs: "1781000100.000300" };

  it("one failing apply does not block the others, and the failure is posted in the thread", async () => {
    readActiveProposals.mockResolvedValue([dayProposal, crewProposal]);
    classifyInstruction.mockResolvedValue({ intent: "confirm" });
    settleProposal.mockResolvedValue("CONFIRMED");
    applyInstruction.mockImplementation(async ({ axis }: { axis: string }) => {
      if (axis === "day") throw new Error("Jira exploded");
      return { applied: true };
    });

    const res = await applyInstructionReply({
      entry: entry(null), period, replyText: "так", approverName: "Oleksandr K",
      replyPermalink: "https://slack/ok", replyTs: "1781000300.000500",
    });

    expect(res.handled).toBe("confirmed");
    expect(res.applied).toBe(true); // the crew one went through
    expect(res.failed).toEqual([dayProposal.summaryUk]);
    expect(applyInstruction).toHaveBeenCalledTimes(2);
    const note = postMessage.mock.calls.map((c) => c[1] as string).find((t) => t.includes("Не вдалося"));
    expect(note).toBeDefined();
    expect(note).toContain(dayProposal.summaryUk);
    expect(note).toContain("Jira exploded");
  });
});

describe("applyInstructionReply — stacked applies see each other's effects", () => {
  const dayProposal = { ...activeProposal, id: "p-day", axis: "day" as const, summaryUk: "прийняти день 2026-07-01 (виняток)", sourceReplyTs: "1781000100.000200" };
  const crewProposal = { ...activeProposal, id: "p-crew", axis: "crew" as const, summaryUk: "склад 2026-07-01: Влад, Сергій", sourceReplyTs: "1781000100.000300" };

  it("reloads the published entry after each apply so the crew edit builds on the amended text, not the stale one", async () => {
    readActiveProposals.mockResolvedValue([dayProposal, crewProposal]);
    classifyInstruction.mockResolvedValue({ intent: "confirm" });
    settleProposal.mockResolvedValue("CONFIRMED");
    const amended = { ...entry(null), text: "~⚠️ 2026-07-01 — потрібна перевірка.~\n✅ Оновлено → прийнято (виняток)\n👥 У полі: Влад, Тарас." };
    findPublishedByTs.mockResolvedValue({ period, entry: amended });

    await applyInstructionReply({
      entry: entry(null), period, replyText: "так", approverName: "Oleksandr K",
      replyPermalink: "https://slack/ok", replyTs: "1781000300.000600",
    });

    expect(applyInstruction).toHaveBeenCalledTimes(2);
    expect(applyInstruction.mock.calls[0][0].entry.text).toBe(entry(null).text); // first apply: original
    expect(applyInstruction.mock.calls[1][0].entry.text).toBe(amended.text); // second apply: reloaded
    expect(findPublishedByTs).toHaveBeenCalledWith(entry(null).ts);
  });

  it("falls back to the last known entry when the reload finds nothing", async () => {
    readActiveProposals.mockResolvedValue([dayProposal, crewProposal]);
    classifyInstruction.mockResolvedValue({ intent: "confirm" });
    settleProposal.mockResolvedValue("CONFIRMED");
    findPublishedByTs.mockResolvedValue(null);
    await applyInstructionReply({
      entry: entry(null), period, replyText: "так", approverName: "Oleksandr K",
      replyPermalink: "https://slack/ok", replyTs: "1781000300.000700",
    });
    expect(applyInstruction.mock.calls[1][0].entry.text).toBe(entry(null).text);
  });
});

describe("applyClassifiedInstruction — pilot-origin proposals", () => {
  it("records the CONFIRMER as `by` when the pending proposal is pilot-origin", async () => {
    const pilotProposal = { ...activeProposal, origin: "pilot" as const, proposedBy: "Тарас", axis: "day" as const, payload: { intent: "instruction", axis: "day", decision: "accepted_exception", reason: "дощ" } };
    settleProposal.mockResolvedValue("CONFIRMED");
    const res = await applyClassifiedInstruction({
      entry: entry("2.0"), period, approverName: "Bohdan Forostianyi", replyPermalink: "p", replyTs: "1781000300.000100",
      classification: { intent: "confirm", reason: "" }, pending: [pilotProposal],
    });
    expect(res.handled).toBe("confirmed");
    expect(applyInstruction).toHaveBeenCalledWith(expect.objectContaining({ by: "Bohdan Forostianyi" }));
  });
  it("keeps the proposer as `by` for an approver-origin proposal", async () => {
    settleProposal.mockResolvedValue("CONFIRMED");
    await applyClassifiedInstruction({
      entry: entry("2.0"), period, approverName: "Bohdan Forostianyi", replyPermalink: "p", replyTs: "1781000300.000100",
      classification: { intent: "confirm", reason: "" }, pending: [{ ...activeProposal, origin: "approver" as const }],
    });
    expect(applyInstruction).toHaveBeenCalledWith(expect.objectContaining({ by: "Oleksandr K" }));
  });
});
