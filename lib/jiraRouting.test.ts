import { describe, it, expect } from "vitest";
import { routeIssue, type RoutingConfig } from "./jiraRouting";
import type { Person } from "./people";

const CFG: RoutingConfig = {
  defaultProject: "OPS",
  mrLabAccountId: "mrlab-acc-1",
  mrLabPeople: ["Liubomyr Zaiats", "Andrian Korchynskiy", "Taras Panasyuk"],
};

const p = (over: Partial<Person>): Person => ({ name: "X", role: "developer", ...over });

describe("routeIssue", () => {
  it("assigns an Mr-Lab person's ticket to the shared Mr Lab USER on the default project, real person in description", () => {
    const r = routeIssue(p({ name: "Taras Panasyuk", jiraAccount: "taras.panasyuk" }), CFG);
    expect(r).toEqual({ projectKey: "OPS", assignInDescription: true, jiraAccountId: "mrlab-acc-1" });
  });

  it("routes a non-Mr-Lab person with no accountId to the default project, in description", () => {
    const r = routeIssue(p({ name: "Denys Borysov", jiraAccount: "denys.borysov" }), CFG);
    expect(r).toEqual({ projectKey: "OPS", assignInDescription: true, jiraAccountId: null });
  });

  it("sets a real assignee for a non-Mr-Lab person who has an accountId", () => {
    const r = routeIssue(p({ name: "Denys Borysov", jiraAccountId: "acc-123" }), CFG);
    expect(r).toEqual({ projectKey: "OPS", assignInDescription: false, jiraAccountId: "acc-123" });
  });

  it("Mr Lab user wins over the person's own accountId (description carries the person)", () => {
    const r = routeIssue(p({ name: "Liubomyr Zaiats", jiraAccountId: "acc-9" }), CFG);
    expect(r).toEqual({ projectKey: "OPS", assignInDescription: true, jiraAccountId: "mrlab-acc-1" });
  });
});
