import { describe, it, expect, vi, beforeEach } from "vitest";

const { postMessage, updateMessage, writePublished, upsertResolution, readResolutions } = vi.hoisted(() => ({
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  writePublished: vi.fn(),
  upsertResolution: vi.fn(),
  readResolutions: vi.fn(),
}));
vi.mock("./slack", () => ({ postMessage, updateMessage }));
vi.mock("./published", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, writePublished };
});
vi.mock("./resolutions", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, upsertResolution, readResolutions };
});

import { applyInstruction } from "./applyInstruction";
import type { PublishedEntry } from "./published";
import type { InstructionClassification } from "./instructionClassifyPrompt";

const period = { start: "2026-06-01", end: "2026-06-30" };

const entry = (override?: PublishedEntry["override"]): PublishedEntry => ({
  date: "2026-06-09",
  reportTs: null,
  channel: "field-qa",
  text:
    "⚠️ 2026-06-09 (вівторок) — потрібна перевірка: відео 0 хв — лише 0% від 104 хв у повітрі (< 50%); немає повідомлення про датасет за цей день (відео 0 хв / 104 хв у повітрі, без датасету).\n" +
    "👥 У полі: Любомир, Надія.\n" +
    "🛸 Дрони: Андріан 2, Любомир 3, інші 8 (усього 13)",
  postedAt: "2026-06-10T05:00:00.000Z",
  ts: "1781000000.000100",
  ...(override ? { override } : {}),
});

const datasetDecline: InstructionClassification = {
  intent: "instruction",
  axis: "dataset",
  datasetStatus: "DECLINED",
  reason: "no dataset submitted, reason not accepted",
} as InstructionClassification;

beforeEach(() => {
  postMessage.mockReset().mockResolvedValue("1782900000.000200");
  updateMessage.mockReset().mockResolvedValue(undefined);
  writePublished.mockReset().mockResolvedValue(undefined);
  upsertResolution.mockReset().mockResolvedValue(undefined);
  readResolutions.mockReset().mockResolvedValue([]);
});

describe("applyInstruction dataset axis", () => {
  it("a dataset DECLINE amends the published verdict message (machine auto-REJECT)", async () => {
    const e = entry();
    const res = await applyInstruction({
      entry: e,
      period,
      axis: "dataset",
      instruction: datasetDecline,
      by: "Oleksandr K",
      evidence: "https://slack/permalink",
      trigger: "webhook",
    });

    expect(res.applied).toBe(true);
    expect(upsertResolution).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-06-09", axis: "dataset", decision: "rejected" }),
    );
    // The main message is edited: body struck through + amendment, 👥/🛸 preserved.
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const [channelId, ts, newText] = updateMessage.mock.calls[0];
    expect(channelId).toBe("C08GY2NKF9D");
    expect(ts).toBe(e.ts);
    expect(newText).toContain("~⚠️ 2026-06-09");
    expect(newText).toContain("⛔ Оновлено → відхилено, Oleksandr K:");
    expect(newText).toContain("👥 У полі: Любомир, Надія.");
    expect(newText).toContain("🛸 Дрони: Андріан 2, Любомир 3, інші 8 (усього 13)");
    // The override stamp is persisted so redeliveries / later day-axis replies dedupe.
    expect(writePublished).toHaveBeenCalledWith(
      period,
      expect.objectContaining({
        "2026-06-09": expect.objectContaining({
          override: expect.objectContaining({ decision: "rejected", by: "Oleksandr K" }),
        }),
      }),
    );
    // The dataset-specific threaded ack still posts.
    const ackTexts = postMessage.mock.calls.map((c) => c[1] as string);
    expect(ackTexts.some((t) => t.includes("датасет ⛔ причину відхилено"))).toBe(true);
  });

  it("does not amend when a day/video exception rescues the machine reject", async () => {
    readResolutions.mockResolvedValue([
      {
        date: "2026-06-09",
        axis: "day",
        decision: "accepted_exception",
        note: "force majeure",
        source: "slack",
        recordedAt: "2026-06-12T00:00:00.000Z",
        by: "Bohdan Forostianyi",
      },
    ]);
    await applyInstruction({
      entry: entry(),
      period,
      axis: "dataset",
      instruction: datasetDecline,
      by: "Oleksandr K",
      evidence: "",
      trigger: "webhook",
    });
    expect(upsertResolution).toHaveBeenCalled(); // the decline is still recorded
    expect(updateMessage).not.toHaveBeenCalled(); // but the day stays rescued
  });

  it("a dataset WAIVE records + acks without amending (final status needs a recompute)", async () => {
    await applyInstruction({
      entry: entry(),
      period,
      axis: "dataset",
      instruction: { ...datasetDecline, datasetStatus: "WAIVED" } as InstructionClassification,
      by: "Oleksandr K",
      evidence: "",
      trigger: "webhook",
    });
    expect(upsertResolution).toHaveBeenCalledWith(
      expect.objectContaining({ axis: "dataset", decision: "accepted_exception" }),
    );
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it("is idempotent: an already-rejected override skips the edit on redelivery", async () => {
    await applyInstruction({
      entry: entry({ decision: "rejected", by: "Oleksandr K", ackedAt: "2026-07-03T19:23:00.000Z" }),
      period,
      axis: "dataset",
      instruction: datasetDecline,
      by: "Oleksandr K",
      evidence: "",
      trigger: "webhook",
    });
    expect(updateMessage).not.toHaveBeenCalled();
    expect(writePublished).not.toHaveBeenCalled();
  });
});

describe("applyInstruction day axis (refactor regression)", () => {
  it("a day rejection still strikes the body, acks, and stamps the override", async () => {
    const res = await applyInstruction({
      entry: entry(),
      period,
      axis: "day",
      instruction: { intent: "instruction", axis: "day", decision: "rejected", reason: "no-go" } as InstructionClassification,
      by: "Oleksandr K",
      evidence: "",
      trigger: "cli",
    });
    expect(res.applied).toBe(true);
    expect(upsertResolution).toHaveBeenCalledWith(
      expect.objectContaining({ axis: "day", decision: "rejected" }),
    );
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage.mock.calls[0][2]).toContain("⛔ Оновлено → відхилено, Oleksandr K: no-go");
    expect(postMessage).toHaveBeenCalledTimes(1); // the generic ⛔ Зафіксовано ack
    expect(writePublished).toHaveBeenCalledTimes(1);
  });
});
