import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateMessage, readPublished, writePublished, findPublishedByTs } = vi.hoisted(() => ({
  updateMessage: vi.fn(),
  readPublished: vi.fn(),
  writePublished: vi.fn(),
  findPublishedByTs: vi.fn(),
}));
vi.mock("./slack", () => ({ updateMessage }));
vi.mock("./published", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, readPublished, writePublished, findPublishedByTs }; // keep the real recordPublished
});

import { refreshPublishedDays } from "./refreshPublished";
import { formatDayMessage } from "./verdictPublish";
import type { DayVerdict } from "./fieldDayVerdict";
import type { PublishedEntry } from "./published";

const period = { start: "2026-07-01", end: "2026-07-31" };

// Minimal type-valid verdict; fields overridable per test.
const day = (date: string, over: Partial<DayVerdict> = {}): DayVerdict => ({
  date,
  reportTs: null,
  reportSeq: 1,
  reportCount: 1,
  status: "ACCEPTED",
  airborneMinutes: 20,
  videoMinutes: 40,
  ratio: 2,
  datasetStatus: "POSTED",
  withinGrace: false,
  reasons: [],
  roster: [],
  unknownInitials: [],
  airborneReported: true,
  ...over,
});

const entry = (date: string, text: string, over: Partial<PublishedEntry> = {}): PublishedEntry => ({
  date,
  reportTs: null,
  channel: "field-qa",
  text,
  postedAt: "2026-07-02T04:00:00.000Z",
  ts: `1783.${date.slice(-2)}`,
  ...over,
});

beforeEach(() => {
  updateMessage.mockReset().mockResolvedValue(undefined);
  readPublished.mockReset().mockResolvedValue({});
  writePublished.mockReset().mockResolvedValue(undefined);
  // Default: look up the fresh entry by ts from whatever log the test configured
  // via readPublished — i.e. "nothing changed since planning". Tests exercising
  // the TOCTOU guard override this per-test.
  findPublishedByTs.mockReset().mockImplementation(async (ts: string) => {
    const log = await readPublished(period);
    const found = Object.values(log as Record<string, PublishedEntry>).find((e) => e.ts === ts);
    return found ? { period, entry: found } : null;
  });
});

describe("refreshPublishedDays", () => {
  it("edits a stale published entry and rewrites its stored text", async () => {
    const d = day("2026-07-02");
    readPublished.mockResolvedValue({ "2026-07-02": entry("2026-07-02", "старий текст") });
    const res = await refreshPublishedDays([d], period, { runDate: "2026-07-10" });

    expect(res.refreshed).toEqual(["2026-07-02"]);
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const [channelId, ts, newText, meta] = updateMessage.mock.calls[0];
    expect(channelId).toBe("C08GY2NKF9D"); // #field-qa
    expect(ts).toBe("1783.02");
    expect(newText).toBe(formatDayMessage(d));
    expect(meta).toMatchObject({ feature: "verdict", channel: "field-qa", trigger: "cron" });
    expect(meta.key).toMatch(/^backfill-edit:2026-07-02:[0-9a-z]+:2026-07-10$/); // content-rev'd + date-salted
    // Stored text rewritten (single-entry upsert) so a re-run is a no-op.
    expect(writePublished).toHaveBeenCalledWith(
      period,
      expect.objectContaining({
        "2026-07-02": expect.objectContaining({ text: formatDayMessage(d) }),
      }),
    );
  });

  it("targets the exact report row on a multi-report day (verdictKey, never bare date)", async () => {
    const d1 = day("2026-07-02", { reportTs: "111.1", reportSeq: 1, reportCount: 2 });
    const d2 = day("2026-07-02", { reportTs: "222.2", reportSeq: 2, reportCount: 2 });
    readPublished.mockResolvedValue({
      "2026-07-02#111.1": entry("2026-07-02", "старий 1/2", { reportTs: "111.1", ts: "1783.911" }),
      "2026-07-02#222.2": entry("2026-07-02", formatDayMessage(d2), { reportTs: "222.2", ts: "1783.922" }),
    });
    const res = await refreshPublishedDays([d1, d2], period, { runDate: "2026-07-10" });

    expect(res.refreshed).toEqual(["2026-07-02#111.1"]);
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const [, ts, newText, meta] = updateMessage.mock.calls[0];
    expect(ts).toBe("1783.911"); // report 1's own message
    expect(newText).toBe(formatDayMessage(d1));
    expect(meta.key).toMatch(/^backfill-edit:2026-07-02#111\.1:[0-9a-z]+:2026-07-10$/);
    expect(writePublished).toHaveBeenCalledWith(
      period,
      expect.objectContaining({
        "2026-07-02#111.1": expect.objectContaining({ text: formatDayMessage(d1) }),
      }),
    );
  });

  it("persists after EACH edit (mid-run failure loses nothing)", async () => {
    readPublished.mockResolvedValue({
      "2026-07-02": entry("2026-07-02", "старий 02"),
      "2026-07-03": entry("2026-07-03", "старий 03"),
    });
    await refreshPublishedDays([day("2026-07-02"), day("2026-07-03")], period);
    expect(updateMessage).toHaveBeenCalledTimes(2);
    expect(writePublished).toHaveBeenCalledTimes(2);
  });

  it("skips overridden entries — the approver strike owns the message", async () => {
    readPublished.mockResolvedValue({
      "2026-07-02": entry("2026-07-02", "~struck~", {
        override: { decision: "rejected", by: "Oleksandr K", ackedAt: "2026-07-03T00:00:00.000Z" },
      }),
    });
    const res = await refreshPublishedDays([day("2026-07-02")], period);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(res.refreshed).toEqual([]);
    expect(res.skipped).toEqual([{ key: "2026-07-02", reason: "overridden" }]);
  });

  it("skips already-current and no-verdict entries", async () => {
    const d = day("2026-07-02");
    readPublished.mockResolvedValue({
      "2026-07-02": entry("2026-07-02", formatDayMessage(d)), // current
      "2026-07-03": entry("2026-07-03", "текст без вердикту"), // no verdict in report
    });
    const res = await refreshPublishedDays([d], period);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(res.skipped).toEqual(
      expect.arrayContaining([
        { key: "2026-07-02", reason: "already-current" },
        { key: "2026-07-03", reason: "no-verdict" },
      ]),
    );
  });

  it("never rewrites a settled message to a non-publishable (PENDING) render", async () => {
    readPublished.mockResolvedValue({ "2026-07-02": entry("2026-07-02", "старий текст") });
    const res = await refreshPublishedDays(
      [day("2026-07-02", { status: "PENDING", withinGrace: true })],
      period,
    );
    expect(updateMessage).not.toHaveBeenCalled();
    expect(res.skipped).toEqual([{ key: "2026-07-02", reason: "not-publishable" }]);
  });

  it("skips entries whose channel is not tracked", async () => {
    readPublished.mockResolvedValue({
      "2026-07-02": entry("2026-07-02", "старий текст", { channel: "retired-channel" }),
    });
    const res = await refreshPublishedDays([day("2026-07-02")], period);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(res.skipped).toEqual([{ key: "2026-07-02", reason: "untracked-channel" }]);
  });

  it("skips (changed-since-plan) when the fresh entry has an override acquired since planning", async () => {
    const plannedEntry = entry("2026-07-02", "старий текст");
    readPublished.mockResolvedValue({ "2026-07-02": plannedEntry });
    findPublishedByTs.mockResolvedValue({
      period,
      entry: { ...plannedEntry, override: { decision: "rejected", by: "Oleksandr K", ackedAt: "2026-07-03T00:00:00.000Z" } },
    });

    const res = await refreshPublishedDays([day("2026-07-02")], period);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(writePublished).not.toHaveBeenCalled();
    expect(res.skipped).toEqual([{ key: "2026-07-02", reason: "changed-since-plan" }]);
  });

  it("skips (changed-since-plan) when the fresh text differs from what was planned against", async () => {
    const plannedEntry = entry("2026-07-02", "старий текст");
    readPublished.mockResolvedValue({ "2026-07-02": plannedEntry });
    findPublishedByTs.mockResolvedValue({
      period,
      entry: { ...plannedEntry, text: "хтось інший вже відредагував" },
    });

    const res = await refreshPublishedDays([day("2026-07-02")], period);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(writePublished).not.toHaveBeenCalled();
    expect(res.skipped).toEqual([{ key: "2026-07-02", reason: "changed-since-plan" }]);
  });

  it("salts the edit key with the run date so identical content across nights gets separate edit keys", async () => {
    const d = day("2026-07-02");
    readPublished.mockResolvedValue({ "2026-07-02": entry("2026-07-02", "старий текст") });

    await refreshPublishedDays([d], period, { runDate: "2026-07-10" });
    const key1 = updateMessage.mock.calls[0][3].key;

    updateMessage.mockClear();
    await refreshPublishedDays([d], period, { runDate: "2026-07-11" });
    const key2 = updateMessage.mock.calls[0][3].key;

    expect(key1).toMatch(/^backfill-edit:2026-07-02:[0-9a-z]+:2026-07-10$/);
    expect(key2).toMatch(/^backfill-edit:2026-07-02:[0-9a-z]+:2026-07-11$/);
    expect(key1).not.toBe(key2); // cross-night flip-flop gets a fresh key, never silently skipped
  });

  it("dry-run: reports would-edit entries but writes nothing", async () => {
    readPublished.mockResolvedValue({ "2026-07-02": entry("2026-07-02", "старий текст") });
    const res = await refreshPublishedDays([day("2026-07-02")], period, { dryRun: true });
    expect(res.refreshed).toEqual(["2026-07-02"]);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(writePublished).not.toHaveBeenCalled();
  });
});
