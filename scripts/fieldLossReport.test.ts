import { describe, expect, it } from "vitest";
import { buildLossReport, parseArgs, renderTable } from "./fieldLossReport";
import type { LossRow } from "../lib/lossLedger";

const row: LossRow = {
  date: "2026-07-04", reportTs: "111.222", lost: true, found: false, note: "втрата борта",
  source: "extracted", crashTextHash: "h", updatedAt: "t", updatedBy: null,
};
const JULY = { start: "2026-07-01", end: "2026-07-31" };

describe("field-loss report", () => {
  it("parses --start/--end/--format", () => {
    expect(parseArgs(["--start", "2026-07-01", "--end", "2026-07-31", "--format", "table"]))
      .toEqual({ start: "2026-07-01", end: "2026-07-31", format: "table" });
  });
  it("builds counter + teamZeroed from the ledger", () => {
    const r = buildLossReport([row, { ...row, date: "2026-07-05", reportTs: "3.4" }], JULY, []);
    expect(r.unrecovered).toBe(2);
    expect(r.cutoff).toBe(3);
    expect(r.teamZeroed).toBe(false);
    expect(buildLossReport(
      ["2026-07-04", "2026-07-05", "2026-07-08", "2026-07-09"].map((date, i) => ({ ...row, date, reportTs: String(i) })),
      JULY, [],
    ).teamZeroed).toBe(true);
  });
  it("renders a table with the margin line", () => {
    const t = renderTable(buildLossReport([row], JULY, []));
    expect(t).toContain("2026-07-04");
    expect(t).toContain("unrecovered: 1 / 3");
  });
});
