import { describe, it, expect } from "vitest";
import { routeIssue, describeAssignee, routingConfigFromEnv, type RoutingConfig } from "./jiraRouting";
import { PEOPLE, personByQuery, type Person } from "./people";

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

// Regression for ATP-1743 (2026-07-08): «створи задачу на Богдана» created an
// unassigned ticket because no PEOPLE entry carried a jiraAccountId — the
// routing silently fell to the in-description fallback for the whole roster.
describe("real registry routes active Jira users to a real assignee", () => {
  const realAssignee = (query: string) => {
    const res = personByQuery(query);
    if (!("person" in res)) throw new Error(`unresolved: ${query}`);
    return routeIssue(res.person, routingConfigFromEnv());
  };

  it("Bohdan Forostianyi gets a real Jira assignee, not the description fallback", () => {
    const r = realAssignee("Богдан Форостяний");
    expect(r.assignInDescription).toBe(false);
    expect(r.jiraAccountId).toMatch(/^712020:/);
  });

  it("every roster jiraAccountId belongs to a person with a confirmed jiraAccount join", () => {
    for (const person of PEOPLE.filter((p) => p.jiraAccountId)) {
      expect(person.jiraAccount, `${person.name} has an accountId but no confirmed jiraAccount`).toBeTruthy();
    }
  });
});

describe("describeAssignee (human label, never a raw accountId)", () => {
  it("labels an Mr-Lab routing as Mr Lab with the real person, no accountId", () => {
    const person = p({ name: "Taras Panasyuk" });
    const label = describeAssignee(person, routeIssue(person, CFG));
    expect(label).toContain("Mr Lab");
    expect(label).toContain("Taras Panasyuk");
    expect(label).not.toContain("mrlab-acc-1");
  });

  it("labels a real assignee by name, not accountId", () => {
    const person = p({ name: "Denys Borysov", jiraAccountId: "acc-123" });
    const label = describeAssignee(person, routeIssue(person, CFG));
    expect(label).toBe("Denys Borysov");
    expect(label).not.toContain("acc-123");
  });

  it("labels an unassigned (in-description) routing", () => {
    const person = p({ name: "Denys Borysov" });
    const label = describeAssignee(person, routeIssue(person, CFG));
    expect(label).toContain("не призначено");
    expect(label).toContain("Denys Borysov");
  });
});
