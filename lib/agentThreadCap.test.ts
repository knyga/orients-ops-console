import { describe, it, expect } from "vitest";
import { capTranscript, type Turn } from "./agentThreadCap";

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
