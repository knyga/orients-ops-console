import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  boardIdFromEnv: vi.fn(),
  listSprints: vi.fn(),
  fetchSprintIssues: vi.fn(),
  applyProposal: vi.fn(),
}));
vi.mock("@/lib/jira", () => ({
  boardIdFromEnv: mocks.boardIdFromEnv,
  listSprints: mocks.listSprints,
  fetchSprintIssues: mocks.fetchSprintIssues,
}));
vi.mock("@/lib/proposalExecutor", () => ({ applyProposal: mocks.applyProposal }));

import { sprintTools } from "./sprint";

const tool = sprintTools.find((t) => t.name === "sprint_plan_build")!;
const ctx = { channelId: "C08GX9DE54P", threadTs: "1782899951.295969" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.boardIdFromEnv.mockReturnValue(1);
  mocks.fetchSprintIssues.mockResolvedValue([{ key: "ATP-1" }, { key: "ATP-2" }, { key: "ATP-3" }]);
});

describe("sprint_plan_build", () => {
  it("is a confirm-first write tool", () => {
    expect(tool.kind).toBe("write");
    expect(tool.propose).toBeDefined();
    expect(tool.run).toBeUndefined();
  });

  it("proposes against the board's active sprint with a live issue count", async () => {
    mocks.listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "active" ? [{ id: 1487, name: "ATP 49", state: "active" }] : [],
    );
    const p = await tool.propose!({}, ctx);
    expect(p.kind).toBe("sprint_plan_build");
    expect(p.params).toEqual({
      channelId: "C08GX9DE54P",
      anchorTs: "1782899951.295969",
      sprintId: 1487,
      sprintName: "ATP 49",
    });
    expect(p.echoUk).toContain("ATP 49");
    expect(p.echoUk).toContain("3 задач");
    expect(p.echoUk).toContain("так/ні");
    expect(mocks.fetchSprintIssues).toHaveBeenCalledWith(1487);
  });

  it("resolves an explicit sprint override by name or id, among active+future", async () => {
    mocks.listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "active"
        ? [{ id: 1487, name: "ATP 49", state: "active" }]
        : [{ id: 1490, name: "ATP 50", state: "future" }],
    );
    const byName = await tool.propose!({ sprint: "atp 50" }, ctx);
    expect(byName.params.sprintId).toBe(1490);
    expect(byName.params.sprintName).toBe("ATP 50");
    const byId = await tool.propose!({ sprint: "1487" }, ctx);
    expect(byId.params.sprintId).toBe(1487);
  });

  it("throws in Ukrainian when the board has no active sprint", async () => {
    mocks.listSprints.mockResolvedValue([]);
    await expect(tool.propose!({}, ctx)).rejects.toThrow(/немає активного спринту/);
  });

  it("throws when the conversation has no thread anchor (e.g. a DM)", async () => {
    mocks.listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "active" ? [{ id: 1487, name: "ATP 49", state: "active" }] : [],
    );
    await expect(tool.propose!({}, { channelId: "D123" })).rejects.toThrow();
    await expect(tool.propose!({}, {})).rejects.toThrow();
    await expect(tool.propose!({})).rejects.toThrow();
  });

  it("produces JSON-serializable params (the proposal survives the Slack round-trip)", async () => {
    mocks.listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "active" ? [{ id: 1487, name: "ATP 49", state: "active" }] : [],
    );
    const p = await tool.propose!({}, ctx);
    expect(JSON.parse(JSON.stringify(p.params))).toEqual(p.params);
  });

  it("delegates apply() to the deterministic executor", async () => {
    mocks.listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "active" ? [{ id: 1487, name: "ATP 49", state: "active" }] : [],
    );
    mocks.applyProposal.mockResolvedValue("✅");
    const p = await tool.propose!({}, ctx);
    await p.apply();
    expect(mocks.applyProposal).toHaveBeenCalledWith("sprint_plan_build", p.params);
  });
});
