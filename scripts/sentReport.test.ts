import { describe, expect, it } from "vitest";
import { parseArgs, resolvePeriod } from "./sentReport";

describe("parseArgs", () => {
  it("defaults to json format and reads flags", () => {
    expect(parseArgs([]).format).toBe("json");
    expect(parseArgs(["--format", "table"]).format).toBe("table");
    const a = parseArgs(["--start", "2026-06-01", "--end", "2026-06-20"]);
    expect(a.start).toBe("2026-06-01");
    expect(a.end).toBe("2026-06-20");
  });
});

describe("resolvePeriod", () => {
  it("defaults to the current month start through today", () => {
    expect(resolvePeriod(parseArgs([]), "2026-06-20")).toEqual({
      start: "2026-06-01",
      end: "2026-06-20",
    });
  });
  it("honors explicit bounds", () => {
    expect(resolvePeriod(parseArgs(["--start", "2026-05-01", "--end", "2026-05-31"]), "2026-06-20")).toEqual(
      { start: "2026-05-01", end: "2026-05-31" },
    );
  });
});
