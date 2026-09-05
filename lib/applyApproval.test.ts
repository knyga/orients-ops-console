import { describe, it, expect, vi, beforeEach } from "vitest";

const { postMessage, updateMessage, writePublished, liveVerdictText } = vi.hoisted(() => ({
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  writePublished: vi.fn(),
  liveVerdictText: vi.fn(),
}));
vi.mock("./slack", () => ({ postMessage, updateMessage }));
vi.mock("./published", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, writePublished }; // keep the real recordPublished
});
vi.mock("./liveText", () => ({ liveVerdictText }));

import { amendPublishedVerdict } from "./applyApproval";
import type { PublishedEntry } from "./published";

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

beforeEach(() => {
  postMessage.mockReset().mockResolvedValue("500.1");
  updateMessage.mockReset().mockResolvedValue("1783.02");
  writePublished.mockReset().mockResolvedValue(undefined);
  liveVerdictText.mockReset();
});

describe("amendPublishedVerdict", () => {
  it("strikes the BODY from entry.text (pristine), but pulls the roster/drone/links tail from the LIVE text so a crew edit / 🔗 line already on the message survives", async () => {
    const e = entry(); // pristine, no tail yet
    const liveText = "✅ 02.07 — прийнято.\n👥 У полі: A, B.\n🔗 <https://slack/p1|Дрони>";
    liveVerdictText.mockResolvedValue(liveText);
    const res = await amendPublishedVerdict({
      entry: e, period, decision: "rejected", by: "Oleksandr K", reason: "причина", trigger: "webhook", postAck: false,
    });
    expect(res.applied).toBe(true);
    const [, ts, updatedText] = updateMessage.mock.calls[0];
    expect(ts).toBe("1783.02");
    expect(updatedText).toBe(
      "~✅ 02.07 — прийнято.~\n⛔ Оновлено → відхилено, <@U08G4EC244X>: причина\n👥 У полі: A, B.\n🔗 <https://slack/p1|Дрони>",
    );
    // entry.text (the double-strike guard's input) is untouched by the write-back.
    expect(writePublished).toHaveBeenCalledWith(
      period,
      expect.objectContaining({ "2026-07-02#100.1": expect.objectContaining({ text: e.text }) }),
    );
  });

  it("a RE-amend (decision flip) still strikes the ORIGINAL entry.text exactly once, even though the live text is already struck once, while carrying forward tail regions added after the first strike", async () => {
    const e = entry(); // pristine — entry.text never carries the strike, by design
    // The live message already reflects a FIRST override strike, plus a roster
    // correction and a links edit that both landed AFTER that first override
    // (and so, per the new override write-back rule, never touched entry.text).
    const liveText =
      "~✅ 02.07 — прийнято.~\n⛔ Оновлено → відхилено, X: перша причина\n👥 У полі: A, B.\n🔗 <https://slack/p1|Дрони>";
    liveVerdictText.mockResolvedValue(liveText);
    const res = await amendPublishedVerdict({
      entry: e, period, decision: "accepted_exception", by: "Oleksandr K", reason: "друга причина", trigger: "webhook", postAck: false,
    });
    expect(res.applied).toBe(true);
    const [, , updatedText] = updateMessage.mock.calls[0];
    // Struck exactly once (from the ORIGINAL pristine body), never double-struck.
    expect(updatedText).toBe(
      "~✅ 02.07 — прийнято.~\n✅ Оновлено → прийнято (виняток), <@U08G4EC244X>: друга причина\n👥 У полі: A, B.\n🔗 <https://slack/p1|Дрони>",
    );
  });

  it("is a no-op when the same decision is already acked AND the live message shows it", async () => {
    const e = entry({ override: { decision: "rejected", by: "X", ackedAt: "2026-07-03T00:00:00.000Z" } });
    liveVerdictText.mockResolvedValue("~✅ 02.07 — прийнято.~\n⛔ Оновлено → відхилено, <@U1>: причина");
    const res = await amendPublishedVerdict({
      entry: e, period, decision: "rejected", by: "Oleksandr K", reason: "причина", trigger: "webhook", postAck: false,
    });
    expect(res).toEqual({ applied: false, alreadyAcked: true });
    expect(updateMessage).not.toHaveBeenCalled();
  });

  // Regression 2026-08-30: the DB stamp said accepted_exception (the flip-back's
  // resolution landed) while the deduped edit never reached Slack — the message
  // kept «відхилено» and every re-apply short-circuited on the stamp.
  it("re-amends when the stamp says this decision but the live message still shows the previous one", async () => {
    const e = entry({ override: { decision: "accepted_exception", by: "X", ackedAt: "2026-07-03T00:00:00.000Z" } });
    liveVerdictText.mockResolvedValue("~✅ 02.07 — прийнято.~\n⛔ Оновлено → відхилено, <@U1>: стара причина\n🔗 <u|Звіт>");
    const res = await amendPublishedVerdict({
      entry: e, period, decision: "accepted_exception", by: "Oleksandr K", reason: "нова причина", trigger: "cli", postAck: true, salt: "manual:2026-09-05",
    });
    expect(res).toEqual({ applied: true, alreadyAcked: false });
    const text = updateMessage.mock.calls[0][2] as string;
    expect(text).toContain("Оновлено → прийнято (виняток)");
    expect(text).not.toContain("відхилено");
    expect(text.endsWith("🔗 <u|Звіт>")).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
