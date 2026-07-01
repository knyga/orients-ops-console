import { describe, it, expect } from "vitest";
import { routeIssue, type RoutingConfig } from "./jiraRouting";
import type { Person } from "./people";

const CFG: RoutingConfig = {
  defaultProject: "OPS",
  mrLabProject: "MRLAB",
  mrLabPeople: ["Liubomyr Zaiats", "Andrian Korchynskiy", "Taras Panasyuk"],
};

const p = (over: Partial<Person>): Person => ({ name: "X", role: "developer", ...over });

describe("routeIssue", () => {
  it("routes an Mr-Lab person to the Mr-Lab project, assignee in description", () => {
    const r = routeIssue(p({ name: "Taras Panasyuk", jiraAccount: "taras.panasyuk" }), CFG);
    expect(r).toEqual({ projectKey: "MRLAB", assignInDescription: true, jiraAccountId: null });
  });

  it("routes a non-Mr-Lab person with no accountId to the default project, in description", () => {
    const r = routeIssue(p({ name: "Denys Borysov", jiraAccount: "denys.borysov" }), CFG);
    expect(r).toEqual({ projectKey: "OPS", assignInDescription: true, jiraAccountId: null });
  });

  it("sets a real assignee for a non-Mr-Lab person who has an accountId", () => {
    const r = routeIssue(p({ name: "Denys Borysov", jiraAccountId: "acc-123" }), CFG);
    expect(r).toEqual({ projectKey: "OPS", assignInDescription: false, jiraAccountId: "acc-123" });
  });

  it("keeps an Mr-Lab person in the description even if they have an accountId", () => {
    const r = routeIssue(p({ name: "Liubomyr Zaiats", jiraAccountId: "acc-9" }), CFG);
    expect(r).toEqual({ projectKey: "MRLAB", assignInDescription: true, jiraAccountId: null });
  });
});
