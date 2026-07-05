import { describe, expect, it } from "vitest";
import { mergeCorrections } from "./instructionsView";

describe("mergeCorrections", () => {
  const rosters = [{ date: "2026-06-25", roster: ["Влад", "Тарас"], by: "Oleksandr K", source: "manual", recordedAt: "2026-07-01T10:00:00.000Z", note: "n" }];
  const resolutions = [{ date: "2026-06-21", axis: "day" as const, decision: "accepted_exception" as const, by: "Bohdan", source: "slack", recordedAt: "2026-06-30T00:00:00.000Z", note: "n" }];
  const airbornes = [{ date: "2026-06-27", minutes: 0, by: "Oleksandr K", source: "manual", recordedAt: "2026-07-01T00:00:00.000Z", note: "n" }];

  it("merges the three correction sources within the window, sorted by date", () => {
    const rows = mergeCorrections(rosters, resolutions, airbornes, "2026-06-01", "2026-06-30");
    expect(rows.map((r) => `${r.date}:${r.axis}`)).toEqual(["2026-06-21:day", "2026-06-25:crew", "2026-06-27:airborne"]);
  });

  it("excludes corrections outside the window", () => {
    const rows = mergeCorrections(rosters, resolutions, airbornes, "2026-06-25", "2026-06-25");
    expect(rows.map((r) => r.date)).toEqual(["2026-06-25"]);
  });

  it("labels eligibility-only roster corrections as the eligibility axis", () => {
    const elig = [{ date: "2026-06-10", eligibility: { Данило: "not_counted" as const }, by: "x", source: "slack", recordedAt: "2026-06-10T00:00:00.000Z", note: "n" }];
    const rows = mergeCorrections(elig, [], [], "2026-06-01", "2026-06-30");
    expect(rows[0].axis).toBe("eligibility");
  });

  it("surfaces reportTs on a report-scoped roster correction, and omits it on a day-wide one", () => {
    const scoped = [{ date: "2026-07-01", reportTs: "222.2", roster: ["Влад"], by: "x", source: "slack", recordedAt: "2026-07-01T00:00:00.000Z", note: "n" }];
    const dayWide = [{ date: "2026-07-02", roster: ["Тарас"], by: "x", source: "slack", recordedAt: "2026-07-02T00:00:00.000Z", note: "n" }];
    const rows = mergeCorrections([...scoped, ...dayWide], [], [], "2026-07-01", "2026-07-31");
    expect(rows.find((r) => r.date === "2026-07-01")?.reportTs).toBe("222.2");
    expect(rows.find((r) => r.date === "2026-07-02")?.reportTs).toBeUndefined();
  });

  it("surfaces reportTs on a report-scoped resolution", () => {
    const scoped = [{ date: "2026-07-01", reportTs: "222.2", axis: "video" as const, decision: "accepted_exception" as const, by: "x", source: "slack", recordedAt: "2026-07-01T00:00:00.000Z", note: "n" }];
    const rows = mergeCorrections([], scoped, [], "2026-07-01", "2026-07-31");
    expect(rows[0].reportTs).toBe("222.2");
  });

  it("never surfaces reportTs on an airborne override (day-shared by design)", () => {
    const airbornes = [{ date: "2026-06-27", minutes: 0, by: "x", source: "manual", recordedAt: "2026-07-01T00:00:00.000Z", note: "n" }];
    const rows = mergeCorrections([], [], airbornes, "2026-06-01", "2026-06-30");
    expect(rows[0].reportTs).toBeUndefined();
  });
});
