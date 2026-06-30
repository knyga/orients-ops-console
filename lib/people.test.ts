import { describe, it, expect } from "vitest";
import {
  personByQuery,
  personForSlackId,
  personForGithubLogin,
  personForJiraAccount,
  personForInitial,
  type Person,
} from "./people";

const FIX: Person[] = [
  { name: "Oleksandr K", role: "CEO/CTO", slackId: "U1", jiraAccount: "acc-o", githubLogin: "oknyga", rosterInitial: "О" },
  { name: "Bohdan Forostianyi", role: "Head of Engineering", slackId: "U2", githubLogin: "bohdanf" },
  { name: "Bohdana Petrenko", role: "developer", slackId: "U3" },
];

describe("personByQuery", () => {
  it("matches an exact name case-insensitively", () => {
    expect(personByQuery("oleksandr k", FIX)).toEqual({ person: FIX[0] });
  });
  it("matches a unique substring", () => {
    expect(personByQuery("oleks", FIX)).toEqual({ person: FIX[0] });
  });
  it("returns ambiguous when a substring hits more than one", () => {
    const r = personByQuery("bohdan", FIX);
    expect(r).toEqual({ ambiguous: [FIX[1], FIX[2]] });
  });
  it("prefers an exact name over a substring superset", () => {
    // "Bohdana Petrenko" contains no exact tie; exact wins when present
    expect(personByQuery("Bohdana Petrenko", FIX)).toEqual({ person: FIX[2] });
  });
  it("returns unknown when nothing matches", () => {
    expect(personByQuery("zzz", FIX)).toEqual({ unknown: "zzz" });
  });
});

describe("reverse lookups", () => {
  it("finds by slack id", () => {
    expect(personForSlackId("U2", FIX)).toBe(FIX[1]);
  });
  it("finds by github login", () => {
    expect(personForGithubLogin("oknyga", FIX)).toBe(FIX[0]);
  });
  it("finds by jira account", () => {
    expect(personForJiraAccount("acc-o", FIX)).toBe(FIX[0]);
  });
  it("finds by roster initial", () => {
    expect(personForInitial("О", FIX)).toBe(FIX[0]);
  });
  it("returns undefined when no person carries that identity", () => {
    expect(personForSlackId("U9", FIX)).toBeUndefined();
    expect(personForJiraAccount("none", FIX)).toBeUndefined();
  });
});
