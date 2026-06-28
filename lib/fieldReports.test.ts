import { describe, it, expect } from "vitest";
import { parseZvit, parseMonth } from "./fieldReports";

const meta = { permalink: "http://x", threadTs: "1.1" };

describe("parseZvit", () => {
  it("parses the canonical shape", () => {
    const r = parseZvit("Звіт 27.06.2026\nА+Серж 14:40-17:40\nЗнімали датасети", meta);
    expect(r).toMatchObject({ flightDate: "2026-06-27", roster: ["Андріан", "Сергій"], start: "14:40", end: "17:40", deployMin: 180 });
    expect(r?.crashText).toContain("датасети");
  });
  it("accepts a bare date with no 'Звіт' keyword", () => {
    expect(parseZvit("31.05.2026\nА+Д 9:00-12:00", meta)?.flightDate).toBe("2026-05-31");
  });
  it("accepts reversed time-then-roster order", () => {
    const r = parseZvit("30.05.2026\n15:00-20:00 А+Д", meta);
    expect(r).toMatchObject({ roster: ["Андріан", "Данило"], start: "15:00", end: "20:00", deployMin: 300 });
  });
  it("accepts dot time separators and en-dash", () => {
    const r = parseZvit("Звіт 09.06.2026\nЛ+Н 14.00 – 18.45", meta);
    expect(r).toMatchObject({ start: "14:00", end: "18:45", deployMin: 285 });
  });
  it("collects unknown initials without dropping the report", () => {
    const r = parseZvit("27.05.2026\nА+М 12:00-16:20", meta);
    expect(r?.roster).toEqual(["Андріан"]);
    expect(r?.unknownInitials).toEqual(["М"]);
  });
  it("returns null when no date header is present", () => {
    expect(parseZvit("just a chat message", meta)).toBeNull();
  });
  it("returns a report with null window when no time range is found", () => {
    const r = parseZvit("Звіт 01.06.2026\nбез часу", meta);
    expect(r).toMatchObject({ flightDate: "2026-06-01", start: null, deployMin: null });
  });
});

describe("parseMonth", () => {
  it("dedupes by flightDate keeping the later edit (by ts)", () => {
    const msgs = [
      { text: "Звіт 01.06.2026\nА+Д 14:00-17:00", permalink: "a", ts: "100" },
      { text: "Звіт 01.06.2026\nА+Д 14:00-18:00", permalink: "b", ts: "200" },
    ];
    const out = parseMonth(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].deployMin).toBe(240); // the ts=200 edit wins
  });
});
