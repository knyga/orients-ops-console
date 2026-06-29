import { beforeEach, describe, expect, it, vi } from "vitest";

const { reserveSend, markSent, markFailed } = vi.hoisted(() => ({
  reserveSend: vi.fn(),
  markSent: vi.fn(),
  markFailed: vi.fn(),
}));
vi.mock("./outbound", () => ({ reserveSend, markSent, markFailed }));

import { sendTracked } from "./sendTracked";

const baseArgs = {
  channelId: "C1",
  text: "hi",
  kind: "post" as const,
  threadTs: null,
  ts: null,
  meta: { key: "verdict:2026-06:2026-06-01", feature: "verdict", channel: "field-qa" },
};

beforeEach(() => {
  reserveSend.mockReset();
  markSent.mockReset();
  markFailed.mockReset();
});

describe("sendTracked", () => {
  it("skips the send and returns the existing ts when reserve is lost", async () => {
    reserveSend.mockResolvedValue({ won: false, existingTs: "111.22" });
    const rawSend = vi.fn();
    const ts = await sendTracked(baseArgs, rawSend);
    expect(ts).toBe("111.22");
    expect(rawSend).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });

  it("sends, marks sent, and returns the new ts when reserve is won", async () => {
    reserveSend.mockResolvedValue({ won: true, existingTs: null });
    const rawSend = vi.fn().mockResolvedValue("999.88");
    const ts = await sendTracked(baseArgs, rawSend);
    expect(ts).toBe("999.88");
    expect(rawSend).toHaveBeenCalledOnce();
    expect(markSent).toHaveBeenCalledWith("verdict:2026-06:2026-06-01", "999.88", expect.any(String));
  });

  it("marks failed and rethrows when the send throws", async () => {
    reserveSend.mockResolvedValue({ won: true, existingTs: null });
    const rawSend = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(sendTracked(baseArgs, rawSend)).rejects.toThrow("boom");
    expect(markFailed).toHaveBeenCalledWith("verdict:2026-06:2026-06-01", "boom");
  });
});
