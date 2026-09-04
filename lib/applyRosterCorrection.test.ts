import { describe, it, expect, vi, beforeEach } from "vitest";

const { postMessage, updateMessage, writePublished, upsertRosterCorrection, liveVerdictText } = vi.hoisted(() => ({
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  writePublished: vi.fn(),
  upsertRosterCorrection: vi.fn(),
  liveVerdictText: vi.fn(),
}));
vi.mock("./slack", () => ({ postMessage, updateMessage }));
vi.mock("./published", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, writePublished }; // keep the real recordPublished
});
vi.mock("./rosterCorrections", () => ({ upsertRosterCorrection }));
vi.mock("./liveText", () => ({ liveVerdictText }));

import { applyRosterDecision } from "./applyRosterCorrection";
import type { PublishedEntry } from "./published";
import type { RosterOutcome } from "../scripts/fieldRosterReport";

const period = { start: "2026-07-01", end: "2026-07-31" };

const entry = (over: Partial<PublishedEntry> = {}): PublishedEntry => ({
  date: "2026-07-02",
  reportTs: "100.1",
  channel: "field-qa",
  text: "✅ 02.07 — прийнято.",
  postedAt: "2026-07-03T04:00:00.000Z",
  ts: "1783.02",
  ...over,
});

const outcome = (over: Partial<RosterOutcome> = {}): RosterOutcome => ({
  roster: ["Alpha", "Bravo"],
  eligibility: {},
  note: "correction",
  by: "Oleksandr K",
  evidencePermalink: "https://slack/perma",
  ...over,
});

beforeEach(() => {
  postMessage.mockReset().mockResolvedValue("500.1");
  updateMessage.mockReset().mockResolvedValue("1783.02");
  writePublished.mockReset().mockResolvedValue(undefined);
  upsertRosterCorrection.mockReset().mockResolvedValue(undefined);
  liveVerdictText.mockReset();
});

describe("applyRosterDecision", () => {
  it("regression: on a NON-overridden entry, edits the live text (== pristine text here) and DOES write the new text back", async () => {
    const e = entry();
    liveVerdictText.mockResolvedValue(e.text); // no live edit — mirrors the pristine text
    const res = await applyRosterDecision({ entry: e, period, outcome: outcome() });
    expect(res.applied).toBe(true);
    const [, ts, updatedText] = updateMessage.mock.calls[0];
    expect(ts).toBe("1783.02");
    expect(updatedText).toBe("✅ 02.07 — прийнято.\n👥 У полі: Alpha, Bravo.");
    expect(writePublished).toHaveBeenCalledWith(
      period,
      expect.objectContaining({ "2026-07-02#100.1": expect.objectContaining({ text: updatedText }) }),
    );
  });

  it("on an OVERRIDDEN entry, edits the LIVE (struck) text preserving the strike + any existing 🔗 line, but does NOT write published.text back", async () => {
    const e = entry({ override: { decision: "rejected", by: "Oleksandr K", ackedAt: "2026-07-03T00:00:00.000Z" } });
    const struckLive = "~✅ 02.07 — прийнято.~\n⛔ Оновлено → відхилено, Oleksandr K: причина\n🔗 <https://slack/p1|Дрони>";
    liveVerdictText.mockResolvedValue(struckLive);
    const res = await applyRosterDecision({ entry: e, period, outcome: outcome() });
    expect(res.applied).toBe(true);
    const [, ts, updatedText] = updateMessage.mock.calls[0];
    expect(ts).toBe("1783.02");
    expect(updatedText).toBe(
      "~✅ 02.07 — прийнято.~\n⛔ Оновлено → відхилено, Oleksandr K: причина\n👥 У полі: Alpha, Bravo.\n🔗 <https://slack/p1|Дрони>",
    );
    expect(updatedText.startsWith("~✅ 02.07 — прийнято.~")).toBe(true); // strike survives
    expect(writePublished).not.toHaveBeenCalled(); // published.text stays pristine
  });

  it("skips the edit entirely when the roster suffix already matches the LIVE text (not the stale entry.text)", async () => {
    const e = entry({ text: "✅ 02.07 — прийнято." }); // stale/pristine text
    const alreadyCurrent = "✅ 02.07 — прийнято.\n👥 У полі: Alpha, Bravo.";
    liveVerdictText.mockResolvedValue(alreadyCurrent);
    const res = await applyRosterDecision({ entry: e, period, outcome: outcome() });
    expect(res.applied).toBe(false);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(writePublished).not.toHaveBeenCalled();
  });

  it("returns { applied: false } for an untracked channel without touching Slack or the DB", async () => {
    const e = entry({ channel: "retired-channel" });
    liveVerdictText.mockResolvedValue(e.text);
    const res = await applyRosterDecision({ entry: e, period, outcome: outcome() });
    expect(res.applied).toBe(false);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(writePublished).not.toHaveBeenCalled();
  });
});
