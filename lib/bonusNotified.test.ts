import { describe, it, expect } from "vitest";
import { clearThread, isThreadNotified, isDmSent, recordThread, recordDm, isThreadNotifiedFor, isDmSentFor, type NotifiedLog } from "./bonusNotified";

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
  it("records per-report entries under date#ts without colliding, carrying date+reportTs", () => {
    let log: NotifiedLog = {};
    log = recordThread(log, "2026-07-01#1.0", "111.1");
    log = recordThread(log, "2026-07-01#2.0", "222.2");
    expect(Object.keys(log).sort()).toEqual(["2026-07-01#1.0", "2026-07-01#2.0"]);
    expect(log["2026-07-01#1.0"]).toMatchObject({ date: "2026-07-01", reportTs: "1.0" });
    expect(log["2026-07-01#2.0"]).toMatchObject({ date: "2026-07-01", reportTs: "2.0" });
  });
  it("isThreadNotifiedFor / isDmSentFor: exact key, legacy bare-date fallback only for single-report days", () => {
    const legacy: NotifiedLog = {
      "2026-06-29": { date: "2026-06-29", reportTs: null, threadTs: "9.9", dms: [{ slackId: "U1", ts: "1.1", amount: 700 }] },
    };
    expect(isThreadNotifiedFor(legacy, { date: "2026-06-29", reportTs: "9.0", reportCount: 1 })).toBe(true);
    expect(isDmSentFor(legacy, { date: "2026-06-29", reportTs: "9.0", reportCount: 1 }, "U1")).toBe(true);
    // A legacy day entry does NOT cover a multi-report day's individual reports.
    const conflicted: NotifiedLog = { "2026-07-01": { date: "2026-07-01", reportTs: null, threadTs: "9.9", dms: [] } };
    expect(isThreadNotifiedFor(conflicted, { date: "2026-07-01", reportTs: "1.0", reportCount: 2 })).toBe(false);
    expect(isDmSentFor(conflicted, { date: "2026-07-01", reportTs: "1.0", reportCount: 2 }, "U1")).toBe(false);
  });

  it("clearThread forgets a retracted thread post but keeps the DMs", () => {
    let log = recordThread({}, "2026-08-30#1.0", "9.9");
    log = recordDm(log, "2026-08-30#1.0", "U1", "2.2", 1200);
    const cleared = clearThread(log, "2026-08-30#1.0");
    expect(cleared["2026-08-30#1.0"].threadTs).toBeUndefined();
    expect(cleared["2026-08-30#1.0"].dms).toEqual([{ slackId: "U1", ts: "2.2", amount: 1200 }]);
    expect(isThreadNotified(cleared, "2026-08-30#1.0")).toBe(false);
    // no-op on an unknown key / a key without a thread
    expect(clearThread(cleared, "2026-08-30#1.0")).toBe(cleared);
    expect(clearThread(cleared, "nope")).toBe(cleared);
  });
});
