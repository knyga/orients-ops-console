// lib/peopleScaffold.test.ts
import { describe, it, expect } from "vitest";
import { proposeMatches, formatProposals, type Candidate } from "./peopleScaffold";

describe("proposeMatches", () => {
  it("groups candidates across sources by case-insensitive display name", () => {
    const cands: Candidate[] = [
      { source: "slack", externalId: "U2", displayName: "Bohdan Forostianyi" },
      { source: "github", externalId: "bohdanf", displayName: "bohdan forostianyi" },
      { source: "jira", externalId: "acc-x", displayName: "Someone Else" },
    ];
    const props = proposeMatches(cands);
    const bohdan = props.find((p) => p.name.toLowerCase() === "bohdan forostianyi")!;
    expect(bohdan.matches.map((m) => m.source).sort()).toEqual(["github", "slack"]);
    expect(bohdan.confidence).toBe("name");
    expect(props.some((p) => p.name === "Someone Else")).toBe(true);
  });
});

describe("formatProposals", () => {
  it("renders a reviewable block per proposal with the warning", () => {
    const out = formatProposals([
      { name: "Bohdan Forostianyi", confidence: "name", matches: [
        { source: "slack", externalId: "U2", displayName: "Bohdan Forostianyi" },
        { source: "github", externalId: "bohdanf", displayName: "Bohdan Forostianyi" },
      ] },
    ]);
    expect(out).toContain("Bohdan Forostianyi");
    expect(out).toContain("slack U2");
    expect(out).toContain("github bohdanf");
    expect(out.toLowerCase()).toContain("review");
  });
});
