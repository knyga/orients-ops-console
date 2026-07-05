import { describe, expect, it } from "vitest";
import { buildManualInstruction, filterEntriesToWindow, parseArgs, resolveManualEntry } from "./fieldInstructionsReport";
import type { PublishedEntry } from "../lib/published";

describe("filterEntriesToWindow", () => {
  const entries = [
    { date: "2026-06-19" },
    { date: "2026-06-25" },
    { date: "2026-06-30" },
  ];
  it("keeps only entries whose date is within [start, end]", () => {
    expect(filterEntriesToWindow(entries, "2026-06-25", "2026-06-25").map((e) => e.date)).toEqual(["2026-06-25"]);
  });
  it("is inclusive on both bounds", () => {
    expect(filterEntriesToWindow(entries, "2026-06-19", "2026-06-30").map((e) => e.date)).toEqual([
      "2026-06-19",
      "2026-06-25",
      "2026-06-30",
    ]);
  });
});

describe("buildManualInstruction", () => {
  it("--set-crew → crew set_roster", () => {
    const r = buildManualInstruction({ setCrew: ["Влад", "Тарас"], reason: "" });
    expect(r?.axis).toBe("crew");
    expect(r?.instruction.roster).toEqual(["Влад", "Тарас"]);
  });
  it("--add-crew → crew add", () => {
    expect(buildManualInstruction({ addCrew: ["Тарас"], reason: "" })?.instruction.add).toEqual(["Тарас"]);
  });
  it("--airborne → airborne minutes", () => {
    const r = buildManualInstruction({ airborne: 0, reason: "" });
    expect(r?.axis).toBe("airborne");
    expect(r?.instruction.airborneMinutes).toBe(0);
  });
  it("--reject → day rejected", () => {
    const r = buildManualInstruction({ reject: true, reason: "" });
    expect(r?.axis).toBe("day");
    expect(r?.instruction.decision).toBe("rejected");
  });
  it("--accept → day accepted_exception", () => {
    expect(buildManualInstruction({ accept: true, reason: "" })?.instruction.decision).toBe("accepted_exception");
  });
  it("nothing actionable → null", () => {
    expect(buildManualInstruction({ reason: "" })).toBeNull();
  });
});

describe("parseArgs", () => {
  it("parses a manual crew set with comma-split names", () => {
    const a = parseArgs(["--date", "2026-06-25", "--set-crew", "Влад,Тарас", "--by", "Oleksandr K", "--write"]);
    expect(a.date).toBe("2026-06-25");
    expect(a.setCrew).toEqual(["Влад", "Тарас"]);
    expect(a.by).toBe("Oleksandr K");
    expect(a.write).toBe(true);
  });
  it("defaults to dry-run sweep", () => {
    const a = parseArgs([]);
    expect(a.write).toBe(false);
    expect(a.date).toBeUndefined();
  });
  it("parses --report to disambiguate a multi-report --date", () => {
    const a = parseArgs(["--date", "2026-07-01", "--report", "111.1", "--accept"]);
    expect(a.report).toBe("111.1");
  });
});

describe("resolveManualEntry", () => {
  const entry = (over: Partial<PublishedEntry>): PublishedEntry => ({
    date: "2026-07-01",
    reportTs: null,
    channel: "field-qa",
    text: "✅ 2026-07-01 — прийнято (…).\n👥 У полі: Влад, Тарас.",
    postedAt: "2026-07-01T20:00:00.000Z",
    ts: "1.1",
    ...over,
  });

  it("resolves a single-report date unambiguously, without needing --report", () => {
    const res = resolveManualEntry([entry({})], "2026-07-01");
    expect(res.error).toBeUndefined();
    expect(res.entry?.ts).toBe("1.1");
  });

  it("errors with no published verdict at all for the date", () => {
    const res = resolveManualEntry([], "2026-07-01");
    expect(res.error).toMatch(/no published verdict/);
  });

  it("refuses a multi-report date with no --report, listing each report's ts + crew", () => {
    const e1 = entry({ reportTs: "111.1", ts: "1.1", text: "✅ виїзд 1/2 (12:30–16:10).\n👥 У полі: Влад." });
    const e2 = entry({ reportTs: "222.2", ts: "2.2", text: "⚠️ виїзд 2/2 (18:20–20:10).\n👥 У полі: Тарас." });
    const res = resolveManualEntry([e1, e2], "2026-07-01");
    expect(res.entry).toBeUndefined();
    expect(res.error).toMatch(/2 published reports/);
    expect(res.error).toContain("111.1");
    expect(res.error).toContain("222.2");
    expect(res.error).toContain("Влад");
    expect(res.error).toContain("Тарас");
  });

  it("targets the exact report when --report matches one of several", () => {
    const e1 = entry({ reportTs: "111.1", ts: "1.1" });
    const e2 = entry({ reportTs: "222.2", ts: "2.2" });
    const res = resolveManualEntry([e1, e2], "2026-07-01", "222.2");
    expect(res.error).toBeUndefined();
    expect(res.entry?.ts).toBe("2.2");
  });

  it("errors when --report matches none of the date's published reports", () => {
    const e1 = entry({ reportTs: "111.1", ts: "1.1" });
    const e2 = entry({ reportTs: "222.2", ts: "2.2" });
    const res = resolveManualEntry([e1, e2], "2026-07-01", "999.9");
    expect(res.entry).toBeUndefined();
    expect(res.error).toMatch(/no published report with ts 999\.9/);
  });
});
