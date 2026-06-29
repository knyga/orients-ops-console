import { describe, expect, it } from "vitest";
import type { OutboundRow } from "./outbound";
import { summarizeSent, toSentView } from "./sentLog";

const row = (over: Partial<OutboundRow> & { key: string }): OutboundRow => ({
  sentAt: "2026-06-10T10:00:00.000Z",
  reservedAt: "2026-06-10T10:00:00.000Z",
  feature: "verdict",
  kind: "post",
  channel: "field-qa",
  channelId: "C123",
  status: "sent",
  origin: "local",
  trigger: "cli",
  text: "hello",
  ts: "1.1",
  threadTs: null,
  error: null,
  attempts: 1,
  ...over,
});

describe("toSentView", () => {
  it("sorts newest first by sentAt, falling back to reservedAt", () => {
    const rows = [
      row({ key: "a", sentAt: "2026-06-01T00:00:00.000Z" }),
      row({ key: "b", sentAt: "2026-06-20T00:00:00.000Z" }),
      row({ key: "c", sentAt: null, reservedAt: "2026-06-25T00:00:00.000Z" }),
    ];
    expect(toSentView(rows).map((r) => r.key)).toEqual(["c", "b", "a"]);
  });
});

describe("summarizeSent", () => {
  it("counts totals by status and feature", () => {
    const rows = [
      row({ key: "a", status: "sent", feature: "verdict" }),
      row({ key: "b", status: "failed", feature: "ask" }),
      row({ key: "c", status: "sent", feature: "ask" }),
    ];
    const views = toSentView(rows);
    expect(summarizeSent(views)).toEqual({
      total: 3,
      byStatus: { sent: 2, failed: 1 },
      byFeature: { verdict: 1, ask: 2 },
    });
  });
});
