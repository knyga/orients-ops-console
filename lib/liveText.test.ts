import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findSentByTs: vi.fn() }));
vi.mock("./outbound", () => ({ findSentByTs: m.findSentByTs }));

import { liveVerdictText } from "./liveText";
import type { PublishedEntry } from "./published";

const entry: PublishedEntry = {
  date: "2026-08-30",
  reportTs: "100.1",
  channel: "field-qa",
  text: "✅ pristine",
  ts: "200.1",
  postedAt: "",
};

const row = (o: Partial<{ key: string; feature: string; status: string; ts: string | null; text: string; channel: string; sentAt: string | null }>) => ({
  key: "x", feature: "verdict", status: "sent", ts: "200.1", text: "x", channel: "field-qa", sentAt: null, ...o,
});

describe("liveVerdictText", () => {
  it("falls back to the pristine published text when no outbound row shares the ts", async () => {
    m.findSentByTs.mockResolvedValue([]);
    expect(await liveVerdictText(entry)).toBe("✅ pristine");
  });

  it("returns the newest SENT row's text sharing the verdict ts — a later approval-override edit wins over the original post", async () => {
    m.findSentByTs.mockResolvedValue([
      row({ text: "✅ pristine", sentAt: "2026-08-30T06:30:00Z" }),
      row({ key: "approval-edit:...", feature: "approval", text: "~✅ pristine~\n⛔ Оновлено → відхилено", sentAt: "2026-08-30T10:00:00Z" }),
    ]);
    expect(await liveVerdictText(entry)).toBe("~✅ pristine~\n⛔ Оновлено → відхилено");
  });

  it("ignores non-sent rows and rows for a different ts", async () => {
    m.findSentByTs.mockResolvedValue([
      row({ key: "pending-edit", status: "pending", text: "should be ignored", sentAt: null }),
      row({ key: "other-ts", ts: "999.9", text: "different message", sentAt: "2026-08-30T11:00:00Z" }),
    ]);
    expect(await liveVerdictText(entry)).toBe("✅ pristine");
  });
});
