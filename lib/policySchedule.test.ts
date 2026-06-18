import { describe, expect, it } from "vitest";
import type { Obligation } from "./policyRegistry";
import {
  addWorkingDays,
  buildSchedule,
  isWorkingDay,
  type SlackMessage,
} from "./policySchedule";

const msg = (over: Partial<SlackMessage>): SlackMessage => ({
  channel: "budgets",
  authorId: "U1",
  author: "Maryna",
  ts: "1700000000.000100",
  isoTime: "2026-05-04T09:00:00.000Z",
  text: "Weekly budget status for last week",
  permalink: "https://x.slack.com/archives/C/p1",
  ...over,
});

const weekly: Obligation = {
  id: "weekly-budget-status",
  title: "Weekly budget status report",
  description: "",
  channel: "budgets",
  responsible: ["Maryna"],
  cadence: { type: "weekly", weekday: 1 }, // Monday
  gracePeriodWorkingDays: 1,
  effectiveFrom: "2026-01-01",
};

describe("working-day helpers", () => {
  it("isWorkingDay treats Sat/Sun as non-working", () => {
    expect(isWorkingDay("2026-05-04")).toBe(true); // Monday
    expect(isWorkingDay("2026-05-09")).toBe(false); // Saturday
    expect(isWorkingDay("2026-05-10")).toBe(false); // Sunday
  });

  it("addWorkingDays skips the weekend", () => {
    expect(addWorkingDays("2026-05-08", 1)).toBe("2026-05-11"); // Fri +1wd → Mon
    expect(addWorkingDays("2026-05-04", 0)).toBe("2026-05-04");
  });
});

describe("buildSchedule", () => {
  it("marks a Monday occurrence NEEDS_REVIEW when a candidate exists in the window", () => {
    const schedule = buildSchedule(
      [weekly],
      [msg({ isoTime: "2026-05-04T09:00:00.000Z" })], // Monday 2026-05-04
      { start: "2026-05-04", end: "2026-05-08" },
      "2026-06-16",
    );
    const occ = schedule.occurrences.find((o) => o.dueDate === "2026-05-04");
    expect(occ?.status).toBe("NEEDS_REVIEW");
    expect(occ?.candidates).toHaveLength(1);
    expect(occ?.id).toBe("weekly-budget-status:2026-05-04");
  });

  it("marks a past-due occurrence with no candidate MISSING", () => {
    const schedule = buildSchedule(
      [weekly],
      [],
      { start: "2026-05-04", end: "2026-05-08" },
      "2026-06-16",
    );
    const occ = schedule.occurrences.find((o) => o.dueDate === "2026-05-04");
    expect(occ?.status).toBe("MISSING");
  });

  it("marks a not-yet-due occurrence with no candidate PENDING", () => {
    const schedule = buildSchedule(
      [weekly],
      [],
      { start: "2026-05-04", end: "2026-05-08" },
      "2026-05-04", // today == due date, still within grace
    );
    const occ = schedule.occurrences.find((o) => o.dueDate === "2026-05-04");
    expect(occ?.status).toBe("PENDING");
  });

  it("ignores messages in a different channel", () => {
    const schedule = buildSchedule(
      [weekly],
      [msg({ channel: "stats" })],
      { start: "2026-05-04", end: "2026-05-08" },
      "2026-06-16",
    );
    const occ = schedule.occurrences.find((o) => o.dueDate === "2026-05-04");
    expect(occ?.status).toBe("MISSING");
  });

  it("skips per-event obligations with a logged reason", () => {
    const perEvent: Obligation = { ...weekly, id: "pe", cadence: { type: "per-event" } };
    const schedule = buildSchedule([perEvent], [], { start: "2026-05-01", end: "2026-05-31" }, "2026-06-16");
    expect(schedule.occurrences).toHaveLength(0);
    expect(schedule.skipped).toEqual([
      { obligationId: "pe", reason: "per-event cadence not scheduled in v1" },
    ]);
  });

  it("enumerates a monthly occurrence on its due day", () => {
    const monthly: Obligation = { ...weekly, id: "m", cadence: { type: "monthly", dueDay: 5 } };
    const schedule = buildSchedule([monthly], [], { start: "2026-05-01", end: "2026-05-31" }, "2026-06-16");
    expect(schedule.occurrences.map((o) => o.dueDate)).toEqual(["2026-05-05"]);
    expect(schedule.occurrences[0].windowStart).toBe("2026-05-01");
  });

  it("clamps a monthly dueDay beyond the month length to the last day", () => {
    const monthly: Obligation = { ...weekly, id: "m", cadence: { type: "monthly", dueDay: 31 } };
    const schedule = buildSchedule([monthly], [], { start: "2026-02-01", end: "2026-02-28" }, "2026-06-16");
    expect(schedule.occurrences.map((o) => o.dueDate)).toEqual(["2026-02-28"]);
  });

  it("does not count a message posted before effectiveFrom as evidence", () => {
    const monthly: Obligation = {
      ...weekly,
      id: "m",
      cadence: { type: "monthly", dueDay: 15 },
      effectiveFrom: "2026-05-10",
    };
    const schedule = buildSchedule(
      [monthly],
      [msg({ isoTime: "2026-05-03T09:00:00.000Z" })], // before effectiveFrom
      { start: "2026-05-01", end: "2026-05-31" },
      "2026-06-16",
    );
    const occ = schedule.occurrences.find((o) => o.dueDate === "2026-05-15");
    expect(occ?.windowStart).toBe("2026-05-10");
    expect(occ?.candidates).toHaveLength(0);
    expect(occ?.status).toBe("MISSING");
  });
});
