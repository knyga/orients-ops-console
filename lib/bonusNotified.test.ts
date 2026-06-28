import { describe, it, expect } from "vitest";
import { isThreadNotified, isDmSent, recordThread, recordDm, type NotifiedLog } from "./bonusNotified";

describe("bonusNotified pure helpers", () => {
  it("records + detects a thread note", () => {
    const log = recordThread({}, "2026-06-19", "111.1");
    expect(isThreadNotified(log, "2026-06-19")).toBe(true);
    expect(isThreadNotified(log, "2026-06-20")).toBe(false);
  });
  it("records + detects a per-person DM", () => {
    let log: NotifiedLog = recordThread({}, "2026-06-19", "111.1");
    log = recordDm(log, "2026-06-19", "U1", "222.2", 900);
    expect(isDmSent(log, "2026-06-19", "U1")).toBe(true);
    expect(isDmSent(log, "2026-06-19", "U2")).toBe(false);
  });
  it("does not mutate the input", () => {
    const a: NotifiedLog = {};
    expect(recordThread(a, "2026-06-19", "1.1")).not.toBe(a);
    expect(a).toEqual({});
  });
});
