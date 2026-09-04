import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  readPublished: vi.fn(),
  findPublishedByTs: vi.fn(),
  writePublished: vi.fn(),
  readNotified: vi.fn(),
  readOutboundByFeature: vi.fn(),
  findSentByKey: vi.fn(),
}));
vi.mock("./slack", () => ({
  postMessage: m.postMessage,
  updateMessage: m.updateMessage,
  permalinkFor: (c: string, ts: string) => `https://w/${c}/p${ts.replace(".", "")}`,
}));
vi.mock("./published", async (orig) => ({
  ...(await orig<typeof import("./published")>()),
  readPublished: m.readPublished,
  findPublishedByTs: m.findPublishedByTs,
  writePublished: m.writePublished,
}));
vi.mock("./bonusNotified", async (orig) => ({ ...(await orig<typeof import("./bonusNotified")>()), readNotified: m.readNotified }));
vi.mock("./outbound", () => ({ readOutboundByFeature: m.readOutboundByFeature, findSentByKey: m.findSentByKey }));

import { planRelinkForPeriod, relinkDays } from "./relinkDay";

const period = { start: "2026-09-01", end: "2026-09-30" };
const entry = { date: "2026-09-03", reportTs: "100.1", channel: "field-qa", text: "✅ v1", ts: "200.1", postedAt: "" };

beforeEach(() => {
  vi.resetAllMocks();
  m.readPublished.mockResolvedValue({ "2026-09-03#100.1": entry });
  m.readNotified.mockResolvedValue({});
  m.readOutboundByFeature.mockImplementation(async (feature: string) =>
    feature === "drone-reminder"
      ? [{ key: "drone-reminder:2026-09-03", feature, status: "sent", ts: "50.0", text: "🛸 …", channel: "field-qa" }]
      : []);
  m.findSentByKey.mockResolvedValue(null);
  m.findPublishedByTs.mockResolvedValue({ period, entry });
  m.updateMessage.mockImplementation(async (_c: string, ts: string) => ts);
  m.postMessage.mockResolvedValue("400.1");
});

describe("relinkDays", () => {
  it("dry-run plans but sends nothing", async () => {
    const r = await relinkDays(period, ["2026-09-03"], { publish: false, trigger: "cli", zvitReply: true });
    expect(r.days[0].planned.map((e) => e.target.kind)).toEqual(["reminder", "verdict", "zvit"]);
    expect(m.updateMessage).not.toHaveBeenCalled();
    expect(m.postMessage).not.toHaveBeenCalled();
    expect(m.writePublished).not.toHaveBeenCalled();
  });

  it("publish edits the reminder + verdict, posts the Звіт reply, and writes the verdict text back", async () => {
    const r = await relinkDays(period, ["2026-09-03"], { publish: true, trigger: "cron", zvitReply: true });
    expect(r.sent).toBe(3);
    expect(m.updateMessage).toHaveBeenCalledWith("C08GY2NKF9D", "50.0", expect.stringContaining("🔗 "), expect.objectContaining({ feature: "links", key: expect.stringMatching(/^links-edit:reminder:2026-09-03:/) }));
    expect(m.updateMessage).toHaveBeenCalledWith("C08GY2NKF9D", "200.1", expect.stringContaining("🔗 "), expect.objectContaining({ key: expect.stringMatching(/^links-edit:verdict:2026-09-03#100\.1:/) }));
    expect(m.postMessage).toHaveBeenCalledWith("C08GY2NKF9D", expect.stringMatching(/^🔗 </), expect.objectContaining({ key: "links-zvit:100.1" }), "100.1");
    expect(m.writePublished).toHaveBeenCalledWith(period, { "2026-09-03#100.1": expect.objectContaining({ ts: "200.1", text: expect.stringContaining("🔗 ") }) });
  });

  it("a failing edit is recorded and the loop continues", async () => {
    m.updateMessage.mockImplementation(async (_c: string, ts: string) => { if (ts === "50.0") throw new Error("boom"); return ts; });
    const r = await relinkDays(period, ["2026-09-03"], { publish: true, trigger: "cron", zvitReply: true });
    expect(r.failed).toBe(1);
    expect(r.days[0].failed[0]).toMatchObject({ error: "boom" });
    expect(r.sent).toBe(2);
  });

  it("an empty ts from the chokepoint counts as skipped, not sent, and skips the write-back", async () => {
    m.updateMessage.mockResolvedValue("");
    m.postMessage.mockResolvedValue("");
    const r = await relinkDays(period, ["2026-09-03"], { publish: true, trigger: "cron", zvitReply: true });
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(3);
    expect(m.writePublished).not.toHaveBeenCalled();
  });

  it("TOCTOU: a verdict whose stored text moved since planning is skipped", async () => {
    m.findPublishedByTs.mockResolvedValue({ period, entry: { ...entry, text: "✅ v1 (edited meanwhile)" } });
    const r = await relinkDays(period, ["2026-09-03"], { publish: true, trigger: "cron", zvitReply: false });
    expect(m.updateMessage).not.toHaveBeenCalledWith("C08GY2NKF9D", "200.1", expect.anything(), expect.anything());
    expect(r.skipped).toBe(1);
  });

  it("refuses an untracked channel", async () => {
    await expect(relinkDays(period, ["2026-09-03"], { publish: false, trigger: "cli", zvitReply: false, channel: "nope" })).rejects.toThrow(/не відстежується/);
  });

  it("reads outbound rows for the links feature too, so an edit row's current text is visible to the planner", async () => {
    await relinkDays(period, ["2026-09-03"], { publish: false, trigger: "cli", zvitReply: true });
    expect(m.readOutboundByFeature).toHaveBeenCalledWith("links");
  });

  it("a dedup hit at the chokepoint (findSentByKey already has a sent row for the planned key) counts as skipped, not sent, skips the Slack call and the write-back", async () => {
    m.findSentByKey.mockImplementation(async (key: string) =>
      key.startsWith("links-edit:verdict:")
        ? { key, feature: "links", status: "sent", ts: "200.1", text: "existing", channel: "field-qa", sentAt: "2026-09-03T09:00:00Z" }
        : null);
    const r = await relinkDays(period, ["2026-09-03"], { publish: true, trigger: "cron", zvitReply: true });
    expect(m.updateMessage).not.toHaveBeenCalledWith("C08GY2NKF9D", "200.1", expect.anything(), expect.anything());
    expect(m.writePublished).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
    expect(r.sent).toBe(2); // reminder edit + zvit post still go through
  });

  it("a cross-month period reads published/notified per covered month and plans both days", async () => {
    const augustEntry = { date: "2026-08-25", reportTs: "300.1", channel: "field-qa", text: "✅ aug", ts: "300.2", postedAt: "" };
    const septEntry = { date: "2026-09-03", reportTs: "100.1", channel: "field-qa", text: "✅ v1", ts: "200.1", postedAt: "" };
    m.readPublished.mockImplementation(async (p: { start: string; end: string }) =>
      p.start === "2026-08-01" ? { "2026-08-25#300.1": augustEntry } : { "2026-09-03#100.1": septEntry });
    m.readOutboundByFeature.mockResolvedValue([]);
    const crossPeriod = { start: "2026-08-20", end: "2026-09-04" };
    const r = await planRelinkForPeriod(crossPeriod, null, "field-qa", true);
    expect(r.days.map((d) => d.date)).toEqual(["2026-08-25", "2026-09-03"]);
    expect(m.readPublished).toHaveBeenCalledTimes(2);
    expect(m.readPublished).toHaveBeenCalledWith({ start: "2026-08-01", end: "2026-08-31" });
    expect(m.readPublished).toHaveBeenCalledWith({ start: "2026-09-01", end: "2026-09-30" });
    expect(m.readNotified).toHaveBeenCalledTimes(2);
    expect(m.readNotified).toHaveBeenCalledWith({ start: "2026-08-01", end: "2026-08-31" });
    expect(m.readNotified).toHaveBeenCalledWith({ start: "2026-09-01", end: "2026-09-30" });
  });
});
