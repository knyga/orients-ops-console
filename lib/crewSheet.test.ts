import { describe, expect, it } from "vitest";
import { crewByDate, parseCsv } from "./crewSheet";

describe("parseCsv", () => {
  it("handles quoted fields with embedded commas and newlines", () => {
    const text = 'a,b\n"Андріан\n",+\n"x,y",z';
    expect(parseCsv(text)).toEqual([
      ["a", "b"],
      ["Андріан\n", "+"],
      ["x,y", "z"],
    ]);
  });
  it("handles escaped double-quotes and CRLF", () => {
    expect(parseCsv('"he said ""hi""",1\r\n2,3')).toEqual([['he said "hi"', "1"], ["2", "3"]]);
  });
});

describe("crewByDate", () => {
  const rows = [
    ["", "", "2026-06-24", "2026-06-25"],
    ["Льотна пара 1", "", "", ""],
    ["Час в полі (годин) →", "", "3:00", "2:00"], // metric row — ignored
    ["Тарас Панасюк", "", "", "+"], // block 1
    ["Владислав Ляшко", "", "+", "+"],
    ["Тарас Панасюк", "", "+", ""], // block 2 duplicate label
    ["Невідомий Хтось", "", "+", "+"], // unmapped row — ignored, never guessed
  ];

  it("unions mapped crew per date across blocks, deduped and sorted", () => {
    const m = crewByDate(rows);
    expect(m.get("2026-06-24")).toEqual(["Влад", "Тарас"]);
    expect(m.get("2026-06-25")).toEqual(["Влад", "Тарас"]);
  });

  it("maps sheet labels to canonical short roster names", () => {
    // Владислав Ляшко → Влад (not the literal label)
    expect(crewByDate(rows).get("2026-06-24")).toContain("Влад");
  });

  it("ignores rows whose label is not in the explicit map", () => {
    // "Невідомий Хтось" is marked both days but must never appear.
    for (const crew of crewByDate(rows).values()) expect(crew).not.toContain("Невідомий Хтось");
  });

  it("treats '+ - ?' style marks as present", () => {
    const m = crewByDate([
      ["", "", "2026-06-01"],
      ["Любомир Заяць", "", "+ - ?"],
    ]);
    expect(m.get("2026-06-01")).toEqual(["Любомир"]);
  });

  it("omits dates with no marked crew", () => {
    const m = crewByDate([
      ["", "", "2026-06-02"],
      ["Тарас Панасюк", "", ""],
    ]);
    expect(m.has("2026-06-02")).toBe(false);
  });
});
