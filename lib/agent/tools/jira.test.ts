import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { searchIssues, createIssue, addComment, updateIssue, transitionIssue } = vi.hoisted(() => ({
  searchIssues: vi.fn(),
  createIssue: vi.fn(),
  addComment: vi.fn(),
  updateIssue: vi.fn(),
  transitionIssue: vi.fn(),
}));

vi.mock("@/lib/jira", () => ({ searchIssues, createIssue, addComment, updateIssue, transitionIssue }));
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

  it("still rejects an ambiguous person", async () => {
    // "Андрій" substring-hits Yefimov / Svidnytskyi / Gresyk via their Cyrillic aliases
    await expect(jiraCreateProposal({ person: "Андрій", summary: "S", description: "" })).rejects.toThrow(
      /Ambiguous/,
    );
  });
});

describe("jira write tools", () => {
  it("registers create/comment/transition/update as write tools with propose()", () => {
    for (const name of ["jira_create", "jira_comment", "jira_transition", "jira_update"]) {
      const t = findTool(jiraTools, name)!;
      expect(t.kind).toBe("write");
      expect(typeof t.propose).toBe("function");
    }
  });
});
