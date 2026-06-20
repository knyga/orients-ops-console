import { describe, expect, it } from "vitest";
import { isAsked, recordAsk, setAskState, type AskLog, type AskRecord } from "./asks";

const rec = (over: Partial<AskRecord>): AskRecord => ({
  gapType: "no_dataset",
  date: "2026-06-13",
  channel: "datasets",
  question: "За 2026-06-13 не бачу датасету…",
  state: "ASKED",
  askedTs: "1716200000.000100",
  askedAt: "2026-06-20T00:00:00.000Z",
  ...over,
});

describe("pure log ops", () => {
  it("recordAsk adds without mutating; isAsked detects the key", () => {
    const log: AskLog = {};
    const next = recordAsk(log, "no_dataset:2026-06-13", rec({}));
    expect(isAsked(log, "no_dataset:2026-06-13")).toBe(false);
    expect(isAsked(next, "no_dataset:2026-06-13")).toBe(true);
  });

  it("setAskState transitions an existing record + note; no-op if absent", () => {
    const log = recordAsk({}, "no_dataset:2026-06-13", rec({}));
    const next = setAskState(log, "no_dataset:2026-06-13", "RESOLVED", "dataset provided");
    expect(next["no_dataset:2026-06-13"].state).toBe("RESOLVED");
    expect(next["no_dataset:2026-06-13"].note).toBe("dataset provided");
    expect(setAskState(log, "missing:key", "RESOLVED")).toBe(log); // no-op returns same ref
  });
});
