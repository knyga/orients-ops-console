import { describe, it, expect } from "vitest";
import { parseZvit, parseMonth } from "./fieldReports";

const meta = { permalink: "http://x", threadTs: "1.1", reportTs: "1783000000.000001" }; // posted 2026-07-02 Kyiv
const postedAt = (ts: string) => ({ ...meta, reportTs: ts, threadTs: ts });

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
  it("parses a window on its own line below the roster (real 2026-06-16 shape)", () => {
    const r = parseZvit(
      "16.06.2026\nА+Н\n13:00-20:00\n\nОблітали військовий азимут\nПофіксили баг з ребусом",
      meta,
    );
    expect(r).toMatchObject({
      flightDate: "2026-06-16",
      roster: ["Андріан", "Надія"],
      start: "13:00",
      end: "20:00",
      deployMin: 420,
    });
    expect(r?.crashText).toContain("військовий азимут");
    expect(r?.crashText).not.toContain("13:00-20:00");
  });

  describe("date header variants (real August 2026 shapes the strict DD.MM.YYYY regex dropped)", () => {
    it("accepts a two-digit year (Звіт 08.08.26)", () => {
      const r = parseZvit("Звіт 08.08.26\nВладислав+Сергій 13:20-16:30", postedAt("1786201213.992859"));
      expect(r).toMatchObject({ flightDate: "2026-08-08", start: "13:20", end: "16:30" });
    });
    it("infers the year from the posting time when the header has none (Звіт 13.08)", () => {
      const r = parseZvit("Звіт 13.08\nАндріан + Влад 12:00-17:00", postedAt("1786631738.996829"));
      expect(r).toMatchObject({ flightDate: "2026-08-13", roster: ["Андріан", "Влад"] });
    });
    it("tolerates a trailing colon after a yearless date (Звіт 24.08:)", () => {
      const r = parseZvit("Звіт 24.08:\nЛюбомир+Владислав 15:00-18:40:", postedAt("1787648453.239609"));
      expect(r?.flightDate).toBe("2026-08-24");
    });
    it("accepts a reversed YYYY.MM.DD header (Звіт 2026.08.26)", () => {
      const r = parseZvit("Звіт 2026.08.26\nАндріан + Влад 12:20- 16:20", postedAt("1787751822.198019"));
      expect(r).toMatchObject({ flightDate: "2026-08-26", start: "12:20", end: "16:20" });
    });
    it("clamps a two-digit future-year typo too (Звіт 28.08.28 posted 2026-08-28)", () => {
      const r = parseZvit("Звіт 28.08.28\nАндріан + Влад 13:20-18:50", postedAt("1787933632.727969"));
      expect(r?.flightDate).toBe("2026-08-28");
    });
    it("clamps a future-year typo to the posting year (Звіт 28.08.2028 posted 2026-08-28)", () => {
      const r = parseZvit("Звіт 28.08.2028\nАндріан + Влад 13:20-18:50", postedAt("1787933632.727969"));
      expect(r?.flightDate).toBe("2026-08-28");
    });
    it("a yearless header posted in early January belongs to the previous December", () => {
      // 2027-01-01 10:00 Kyiv
      const r = parseZvit("Звіт 31.12\nА+В 12:00-16:00", postedAt("1798797600.000001"));
      expect(r?.flightDate).toBe("2026-12-31");
    });
    it("ignores the bot's own drone-count reminder («🛸 Звіт по дронах за 18.08 …») — a yearless date must BE the header", () => {
      expect(parseZvit("🛸 Звіт по дронах за 18.08 <@U1>, <@U2> — будь ласка, вкажіть кількість", postedAt("1787034000.000001"))).toBeNull();
    });
    it("ignores chatter that merely mentions a short date («зустріч 19.08 о 12:00»)", () => {
      expect(parseZvit("зустріч 19.08 о 12:00\nА+В 12:00-16:00", postedAt("1787034000.000001"))).toBeNull();
    });
    it("still returns null for a header with no date at all", () => {
      expect(parseZvit("Звіт\nА+В 12:00-16:00", postedAt("1786631738.996829"))).toBeNull();
    });
  });
});

describe("parseMonth", () => {
  it("keeps both same-day reports from different crews, each with its own reportTs", () => {
    const msgs = [
      { text: "Звіт 01.07.2026\nА+Н 12:30-16:10", permalink: "p1", ts: "1782912665.697519" },
      { text: "Звіт 01.07.2026\nВ+Н 18:20-20:10", permalink: "p2", ts: "1782927922.936129" },
    ];
    const out = parseMonth(msgs);
    expect(out).toHaveLength(2);
    expect(out[0].reportTs).toBe("1782912665.697519");
    expect(out[0].deployMin).toBe(220);
    expect(out[1].reportTs).toBe("1782927922.936129");
    expect(out[1].deployMin).toBe(110);
  });

  it("sorts by flightDate then ts across dates", () => {
    const msgs = [
      { text: "Звіт 02.07.2026\nА+Б 10:00-14:00", permalink: "p3", ts: "3.0" },
      { text: "Звіт 01.07.2026\nВ+Г 09:00-13:00", permalink: "p4", ts: "2.0" },
    ];
    expect(parseMonth(msgs).map((r) => r.flightDate)).toEqual(["2026-07-01", "2026-07-02"]);
  });
});
