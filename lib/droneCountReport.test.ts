import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { classifyDroneCount } from "./droneCountReport";

function toolUse(input: unknown) {
  return { content: [{ type: "tool_use", name: "record_drone_count_report", input }] };
}

describe("classifyDroneCount", () => {
  beforeEach(() => {
    create.mockReset();
    process.env.ANTHROPIC_API_KEY = "test";
  });

  it("returns entries and derives present", async () => {
    create.mockResolvedValue(
      toolUse({
        entries: [
          { name: "Андріан", isPerson: true, count: 2 },
          { name: "15ка", isPerson: false, count: 1 },
        ],
        note: "Андріан R&D - 1шт вартовий+ 1 шт азимут",
      }),
    );
    const r = await classifyDroneCount("Андріан R&D - 1шт вартовий+ 1 шт азимут\n15ка - 1шт");
    expect(r.present).toBe(true);
    expect(r.entries).toEqual([
      { name: "Андріан", isPerson: true, count: 2 },
      { name: "15ка", isPerson: false, count: 1 },
    ]);
    expect(r.forDate).toBeNull();
  });

  it("passes postedOn into the prompt", async () => {
    create.mockResolvedValue(toolUse({ entries: [{ name: "X", isPerson: true, count: 1 }], note: "" }));
    await classifyDroneCount("Готові 01.06 : X - 1шт", "2026-06-02");
    const prompt = create.mock.calls[0][0].messages[0].content[0].text;
    expect(prompt).toContain("2026-06-02");
  });

  it("keeps a valid explicit forDate, rejects a malformed one", async () => {
    create.mockResolvedValue(toolUse({ entries: [{ name: "X", isPerson: true, count: 1 }], forDate: "2026-06-20", note: "" }));
    expect((await classifyDroneCount("x")).forDate).toBe("2026-06-20");
    create.mockResolvedValue(toolUse({ entries: [{ name: "X", isPerson: true, count: 1 }], forDate: "20 червня", note: "" }));
    expect((await classifyDroneCount("x")).forDate).toBeNull();
  });

  it("sanitizes bad entries (blank name, zero/negative/non-numeric count)", async () => {
    create.mockResolvedValue(
      toolUse({
        entries: [
          { name: "  ", isPerson: true, count: 3 },
          { name: "Y", isPerson: true, count: 0 },
          { name: "Z", isPerson: false, count: "2" },
          { name: "W", isPerson: true, count: -1 },
        ],
        note: "",
      }),
    );
    const r = await classifyDroneCount("x");
    expect(r.entries).toEqual([{ name: "Z", isPerson: false, count: 2 }]);
    expect(r.present).toBe(true);
  });

  it("short-circuits empty text without calling Claude", async () => {
    const r = await classifyDroneCount("   ");
    expect(create).not.toHaveBeenCalled();
    expect(r).toEqual({ present: false, entries: [], forDate: null, note: "" });
  });
});
