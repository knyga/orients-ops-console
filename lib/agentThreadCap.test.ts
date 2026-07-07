import { describe, it, expect } from "vitest";
import { capTranscript, shouldRecordDmBotTurn, type Turn } from "./agentThreadCap";

const turns = (n: number): Turn[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `t${i}` }) as Turn);

describe("capTranscript", () => {
  it("keeps only the last 10 turns", () => {
    const out = capTranscript(turns(14), 1000, 900);
    expect(out).toHaveLength(10);
    expect(out[0].text).toBe("t4");
  });
  it("drops everything when the thread is older than 24h", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(capTranscript(turns(4), day + 2000, 1000)).toEqual([]);
  });
  it("keeps a fresh short thread unchanged", () => {
    expect(capTranscript(turns(4), 5000, 4000)).toHaveLength(4);
  });
});

describe("shouldRecordDmBotTurn", () => {
  it("records a top-level DM send from a non-agent feature", () => {
    expect(shouldRecordDmBotTurn("D0AB12345", null, "loss-alert")).toBe(true);
    expect(shouldRecordDmBotTurn("D0AB12345", null, "nightly-failure")).toBe(true);
  });
  it("skips channel sends", () => {
    expect(shouldRecordDmBotTurn("C0CHANNEL1", null, "loss-alert")).toBe(false);
  });
  it("skips threaded DM replies", () => {
    expect(shouldRecordDmBotTurn("D0AB12345", "111.222", "loss-alert")).toBe(false);
  });
  it("skips agent-feature sends (already recorded by appendTurn)", () => {
    expect(shouldRecordDmBotTurn("D0AB12345", null, "agent")).toBe(false);
  });
});
