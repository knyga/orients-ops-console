import { describe, it, expect, vi, beforeEach } from "vitest";

const { postMessage, updateMessage, writePublished, upsertResolution, readResolutions, upsertLossRecord } = vi.hoisted(() => ({
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  writePublished: vi.fn(),
  upsertResolution: vi.fn(),
  readResolutions: vi.fn(),
  upsertLossRecord: vi.fn(),
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
vi.mock("./lossStore", () => ({ upsertLossRecord }));

import { applyInstruction } from "./applyInstruction";
import type { PublishedEntry } from "./published";
import type { InstructionClassification } from "./instructionClassifyPrompt";
import { mentionize } from "./mention";

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
  upsertLossRecord.mockReset().mockResolvedValue(true);
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
    expect(newText).toContain(`⛔ Оновлено → відхилено, ${mentionize("Oleksandr K")}:`);
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

  it("mentionizes the approver in the dataset ack", async () => {
    await applyInstruction({
      entry: entry(),
      period,
      axis: "dataset",
      instruction: { ...datasetDecline, datasetStatus: "WAIVED" } as InstructionClassification,
      by: "Oleksandr K",
      evidence: "",
      trigger: "webhook",
    });
    const ackTexts = postMessage.mock.calls.map((c) => c[1] as string);
    expect(ackTexts.some((t) => t.includes(mentionize("Oleksandr K")))).toBe(true);
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
    expect(updateMessage.mock.calls[0][2]).toContain(`⛔ Оновлено → відхилено, ${mentionize("Oleksandr K")}: no-go`);
    expect(postMessage).toHaveBeenCalledTimes(1); // the generic ⛔ Зафіксовано ack
    expect(writePublished).toHaveBeenCalledTimes(1);
  });
});

describe("applyInstruction salt (flip-back re-posts)", () => {
  // 2026-09-04 #field-qa: a day went accept → reject → accept. The second accept's
  // edit + ack keys equalled the first's, so the chokepoint skipped both: the DB
  // flipped to accepted but Slack still showed «відхилено» and nobody was acked.
  // The salt (the instructing reply's ts) makes each instruction its own send.
  it("day axis: the edit + ack outbound keys carry the salt", async () => {
    await applyInstruction({
      entry: entry({ decision: "rejected", by: "Oleksandr K", ackedAt: "2026-09-04T08:23:27.000Z" }),
      period,
      axis: "day",
      instruction: { intent: "instruction", axis: "day", decision: "accepted_exception", reason: "ok" } as InstructionClassification,
      by: "Oleksandr K",
      evidence: "",
      trigger: "webhook",
      salt: "1788510237.178909",
    });
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage.mock.calls[0][3].key).toBe("approval-edit:2026-06-09:accepted_exception:1788510237.178909");
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][2].key).toBe("approval-ack:2026-06-09:accepted_exception:1788510237.178909");
  });

  it("ack-only axes: the ack key is the salt, not the (repeatable) text hash", async () => {
    await applyInstruction({
      entry: entry(),
      period,
      axis: "video",
      instruction: { intent: "instruction", axis: "video", videoWaive: true, reason: "ok" } as InstructionClassification,
      by: "Oleksandr K",
      evidence: "",
      trigger: "webhook",
      salt: "1788510237.178909",
    });
    expect(postMessage.mock.calls[0][2].key).toBe("instruction-ack:2026-06-09:video:1788510237.178909");
  });

  it("without a salt the keys keep the legacy shape", async () => {
    await applyInstruction({
      entry: entry(),
      period,
      axis: "day",
      instruction: { intent: "instruction", axis: "day", decision: "rejected", reason: "no-go" } as InstructionClassification,
      by: "Oleksandr K",
      evidence: "",
      trigger: "cli",
    });
    expect(updateMessage.mock.calls[0][3].key).toBe("approval-edit:2026-06-09:rejected");
  });
});

describe("applyInstruction loss axis", () => {
  it("writes an instruction ledger row for the report and acks in Ukrainian", async () => {
    const res = await applyInstruction({
      entry: { ...entry(), date: "2026-07-04", reportTs: "111.222" },
      period,
      axis: "loss",
      instruction: { intent: "instruction", axis: "loss", lossState: "found", reason: "борт знайшли" } as InstructionClassification,
      by: "Oleksandr K",
      evidence: "https://slack/permalink",
    });
    expect(res.applied).toBe(true);
    expect(upsertLossRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        date: "2026-07-04",
        reportTs: "111.222",
        lost: true,
        found: true,
        source: "instruction",
        updatedBy: "Oleksandr K",
      }),
    );
    const ack = postMessage.mock.calls.at(-1)?.[1] as string;
    expect(ack).toContain("знайдено");
  });

  it("with a null reportTs writes a day-wide row (reportTs '')", async () => {
    await applyInstruction({
      entry: { ...entry(), date: "2026-07-04", reportTs: null },
      period,
      axis: "loss",
      instruction: { intent: "instruction", axis: "loss", lossState: "lost", reason: "не знайшли" } as InstructionClassification,
      by: "Oleksandr K",
      evidence: "",
    });
    expect(upsertLossRecord).toHaveBeenCalledWith(expect.objectContaining({ reportTs: "", found: false }));
  });
});
