import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const {
  searchIssues,
  createIssue,
  addComment,
  updateIssue,
  transitionIssue,
  listTransitions,
  listSprints,
  createSprint,
  moveIssueToSprint,
} = vi.hoisted(() => ({
  searchIssues: vi.fn(),
  createIssue: vi.fn(),
  addComment: vi.fn(),
  updateIssue: vi.fn(),
  transitionIssue: vi.fn(),
  listTransitions: vi.fn(),
  listSprints: vi.fn(),
  createSprint: vi.fn(),
  moveIssueToSprint: vi.fn(),
}));

vi.mock("@/lib/jira", () => ({
  searchIssues,
  createIssue,
  addComment,
  updateIssue,
  transitionIssue,
  listTransitions,
  listSprints,
  createSprint,
  moveIssueToSprint,
  boardIdFromEnv: () => Number(process.env.JIRA_BOARD_ID ?? "1"),
}));
// lib/jiraRouting and lib/people are NOT mocked — they use real routing + registry to test integration

import { jiraTools, jiraCreateProposal } from "./jira";
import { findTool } from "./registry";

const ENV = {
  JIRA_BASE_URL: "https://ex.atlassian.net",
  JIRA_EMAIL: "bot@ex.com",
  JIRA_API_TOKEN: "tok",
  JIRA_PROJECT_KEYS: "ATP",
  JIRA_STORY_POINTS_FIELD: "customfield_10016",
  JIRA_MRLAB_ACCOUNT_ID: "mrlab-acc-1",
};
beforeEach(() => Object.assign(process.env, ENV));
afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, json: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(json), { status }));
}

describe("jira_search tool", () => {
  it("is a read tool and returns rows as text", async () => {
    const tool = findTool(jiraTools, "jira_search")!;
    expect(tool.kind).toBe("read");
    searchIssues.mockResolvedValue([{ key: "ATP-7", status: "Done", summary: "Fix" }]);
    const res = await tool.run!({ jql: "resolved >= startOfDay()" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("ATP-7");
    expect(res.content).toContain("Fix");
  });
});

describe("jiraCreateProposal (Mr-Lab routing)", () => {
  it("routes Тарас to the Mr Lab user on the default project, person named in the echo", async () => {
    const p = await jiraCreateProposal({ person: "Taras", summary: "Fix export", description: "broken CSV" });
    expect(p.kind).toBe("jira_create");
    expect(p.echoUk).toContain("ATP");
    expect(p.echoUk).toContain("Taras Panasyuk");
  });

  it("echoes a human assignee label, never the raw accountId", async () => {
    const p = await jiraCreateProposal({ person: "Taras", summary: "S", description: "" });
    expect(p.echoUk).toContain("Mr Lab");
    expect(p.echoUk).not.toContain("mrlab-acc-1");
    // the raw id still goes to Jira in params
    expect(p.params.assigneeAccountId).toBe("mrlab-acc-1");
  });

  it("apply() POSTs and returns the created key + url", async () => {
    createIssue.mockResolvedValue({ key: "ATP-3", url: "https://ex.atlassian.net/browse/ATP-3" });

    const p = await jiraCreateProposal({ person: "Taras", summary: "S", description: "" });
    const out = await p.apply();
    expect(out).toContain("ATP-3");
    expect(createIssue).toHaveBeenCalledWith({
      projectKey: "ATP",
      summary: "S",
      description: "Виконавець: Taras Panasyuk",
      assigneeAccountId: "mrlab-acc-1",
    });
  });

  it("sets params to the exact Mr-Lab create input", async () => {
    const p = await jiraCreateProposal({ person: "Taras", summary: "Fix export", description: "broken CSV" });
    expect(p.params).toEqual({
      projectKey: "ATP",
      summary: "Fix export",
      description: "Виконавець: Taras Panasyuk\n\nbroken CSV",
      assigneeAccountId: "mrlab-acc-1",
    });
  });

  it("proposes an unassigned ticket for an unknown person, name kept in the description", async () => {
    const p = await jiraCreateProposal({ person: "Nobody McGhost", summary: "S", description: "details" });
    expect(p.kind).toBe("jira_create");
    expect(p.params).toEqual({
      projectKey: "ATP",
      summary: "S",
      description: "Виконавець: Nobody McGhost (не знайдено в реєстрі)\n\ndetails",
      assigneeAccountId: null,
    });
    expect(p.echoUk).toContain("не призначено");
    expect(p.echoUk).toContain("Nobody McGhost");
  });

  it("appends the source Slack thread link to the description when the turn carries one", async () => {
    const p = await jiraCreateProposal(
      { person: "Taras", summary: "S", description: "details" },
      { sourceUrl: "https://orientsai.slack.com/archives/C1/p1700000000000001" },
    );
    expect(p.params.description).toBe(
      "Виконавець: Taras Panasyuk\n\ndetails\n\nSlack: https://orientsai.slack.com/archives/C1/p1700000000000001",
    );
    expect(p.echoUk).toContain("Slack: https://orientsai.slack.com/archives/C1/p1700000000000001");
  });

  it("appends the source link on the unknown-person path too", async () => {
    const p = await jiraCreateProposal(
      { person: "Nobody McGhost", summary: "S", description: "" },
      { sourceUrl: "https://orientsai.slack.com/archives/C1/p1700000000000001" },
    );
    expect(p.params.description).toContain("Slack: https://orientsai.slack.com/archives/C1/p1700000000000001");
  });

  it("addToNextSprint resolves the sprint into the SAME proposal (single confirmation)", async () => {
    listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "active"
        ? [{ id: 1223, name: "ATP 41", state: "active" }]
        : [{ id: 1256, name: "ATP 42", state: "future" }],
    );
    const p = await jiraCreateProposal({ person: "Taras", summary: "S", description: "d", addToNextSprint: true });
    expect(p.kind).toBe("jira_create");
    expect(p.params.nextSprint).toEqual({ boardId: 1, sprintId: 1256, sprintName: "ATP 42" });
    expect(p.echoUk).toContain("ATP 42");
    expect(p.echoUk).toContain("спринт");
  });

  it("addToNextSprint plans a sprint create when the next sprint is missing", async () => {
    listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "active" ? [{ id: 1223, name: "ATP 41", state: "active" }] : [],
    );
    const p = await jiraCreateProposal({ person: "Taras", summary: "S", addToNextSprint: true });
    expect(p.params.nextSprint).toEqual({ boardId: 1, sprintId: null, sprintName: "ATP 42" });
    expect(p.echoUk).toContain("створю");
  });

  it("no addToNextSprint → no nextSprint in params and no sprint fetches", async () => {
    listSprints.mockClear();
    const p = await jiraCreateProposal({ person: "Taras", summary: "S", description: "" });
    expect(p.params.nextSprint).toBeUndefined();
    expect(listSprints).not.toHaveBeenCalled();
  });

  it("strips the model's own leading «Виконавець:» line so it is not doubled", async () => {
    const p = await jiraCreateProposal({
      person: "Taras",
      summary: "S",
      description: "Виконавець: Taras Panasyuk\n\nreal details",
    });
    expect(p.params.description).toBe("Виконавець: Taras Panasyuk\n\nreal details");
  });

  it("still rejects an ambiguous person", async () => {
    // "Андрій" substring-hits Yefimov / Svidnytskyi / Gresyk via their Cyrillic aliases
    await expect(jiraCreateProposal({ person: "Андрій", summary: "S", description: "" })).rejects.toThrow(
      /Ambiguous/,
    );
  });
});

describe("jira write tools", () => {
  it("registers create/comment/transition/update/next-sprint as write tools with propose()", () => {
    for (const name of ["jira_create", "jira_comment", "jira_transition", "jira_update", "jira_add_to_next_sprint"]) {
      const t = findTool(jiraTools, name)!;
      expect(t.kind).toBe("write");
      expect(typeof t.propose).toBe("function");
    }
  });
});

/**
 * The model must NEVER supply a raw transition id — ids are per-workflow and
 * the model guesses (bit us 2026-09-01: hallucinated id 31 for ATP-1891,
 * Jira 400 "Transition id '31' is not valid for this issue"). The tool takes
 * the TARGET STATUS NAME and resolves the id live from the issue's own
 * transitions at propose time, erroring with the valid options on no match.
 */
describe("jira_transition tool", () => {
  const propose = (args: Record<string, unknown>) => findTool(jiraTools, "jira_transition")!.propose!(args);
  const TRANSITIONS = [
    { id: "21", name: "In Progress", toStatus: "In Progress" },
    { id: "41", name: "Done", toStatus: "Готово" },
  ];

  it("takes a status name (not an id) in its schema", () => {
    const t = findTool(jiraTools, "jira_transition")!;
    expect(t.inputSchema.required).toEqual(["key", "status"]);
    expect((t.inputSchema.properties as Record<string, unknown>).transitionId).toBeUndefined();
  });

  it("resolves the target status to the issue's live transition id, case-insensitively", async () => {
    listTransitions.mockResolvedValue(TRANSITIONS);
    const p = await propose({ key: "ATP-1891", status: "done" });
    expect(p.kind).toBe("jira_transition");
    expect(p.params).toEqual({ key: "ATP-1891", transitionId: "41" });
    expect(p.echoUk).toContain("ATP-1891");
    expect(p.echoUk).toContain("Готово");
    expect(listTransitions).toHaveBeenCalledWith("ATP-1891");
  });

  it("matches on the target status name too (localized workflows)", async () => {
    listTransitions.mockResolvedValue(TRANSITIONS);
    const p = await propose({ key: "ATP-1891", status: "готово" });
    expect(p.params).toEqual({ key: "ATP-1891", transitionId: "41" });
  });

  it("throws with the valid targets when the status has no transition", async () => {
    listTransitions.mockResolvedValue(TRANSITIONS);
    const err = await propose({ key: "ATP-1891", status: "Closed" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("Closed");
    expect(String(err)).toContain("Готово");
    expect(String(err)).toContain("In Progress");
  });

  it("apply() transitions with the resolved id", async () => {
    listTransitions.mockResolvedValue(TRANSITIONS);
    transitionIssue.mockResolvedValue(undefined);
    const p = await propose({ key: "ATP-1891", status: "Done" });
    await p.apply();
    expect(transitionIssue).toHaveBeenCalledWith("ATP-1891", "41");
  });
});

describe("jira_add_to_next_sprint tool", () => {
  const propose = (args: Record<string, unknown>) => findTool(jiraTools, "jira_add_to_next_sprint")!.propose!(args);

  it("resolves active+1 to an existing future sprint", async () => {
    listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "active"
        ? [{ id: 1190, name: "ATP 40", state: "active" }]
        : [{ id: 1223, name: "ATP 41", state: "future" }],
    );
    const p = await propose({ key: "ATP-1714" });
    expect(p.kind).toBe("jira_move_to_sprint");
    expect(p.params).toEqual({ key: "ATP-1714", boardId: 1, sprintId: 1223, sprintName: "ATP 41" });
    expect(p.echoUk).toContain("ATP-1714");
    expect(p.echoUk).toContain("ATP 41");
    expect(p.echoUk).not.toContain("створю");
  });

  it("plans a create when the next sprint does not exist yet, and says so in the echo", async () => {
    listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "active" ? [{ id: 1190, name: "ATP 40", state: "active" }] : [],
    );
    const p = await propose({ key: "ATP-1714" });
    expect(p.params).toEqual({ key: "ATP-1714", boardId: 1, sprintId: null, sprintName: "ATP 41" });
    expect(p.echoUk).toContain("створю");
    expect(p.echoUk).toContain("ATP 41");
  });

  it("anchors on the last closed sprint when the board is between sprints (no active)", async () => {
    listSprints.mockImplementation(async (_board: number, state: string) => {
      if (state === "active") return [];
      if (state === "closed")
        return [
          { id: 1157, name: "ATP 39", state: "closed" },
          { id: 1190, name: "ATP 40", state: "closed" },
        ];
      return [
        { id: 1223, name: "ATP 41", state: "future" },
        { id: 1256, name: "ATP 42", state: "future" },
      ];
    });
    const p = await propose({ key: "ATP-1714" });
    expect(p.params).toEqual({ key: "ATP-1714", boardId: 1, sprintId: 1223, sprintName: "ATP 41" });
    expect(p.echoUk).toContain("ATP 41");
    expect(p.echoUk).toContain("завершений");
  });

  it("throws when the board has neither an active nor a closed numbered sprint", async () => {
    listSprints.mockResolvedValue([]);
    await expect(propose({ key: "ATP-1714" })).rejects.toThrow(/sprint/i);
  });

  it("throws when the active sprint name has no number to increment", async () => {
    listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "active" ? [{ id: 5, name: "Kanban", state: "active" }] : [],
    );
    await expect(propose({ key: "ATP-1714" })).rejects.toThrow(/Kanban/);
  });
});
