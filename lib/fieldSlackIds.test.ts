import { describe, it, expect } from "vitest";
import { matchSlackId } from "./fieldSlackIds";

const users = [
  { id: "U1", name: "Андріан" },
  { id: "U2", name: "Тарас Шевченко" },
  { id: "U3", name: "Андрій" },
];

describe("matchSlackId", () => {
  it("uses an override first", () => {
    expect(matchSlackId("Андріан", users, { "Андріан": "UX" })).toBe("UX");
  });
  it("matches an exact display/real name", () => {
    expect(matchSlackId("Андріан", users)).toBe("U1");
  });
  it("returns null when no exact match exists (avoid guessing)", () => {
    expect(matchSlackId("Максим", users)).toBeNull();
  });
  it("returns null on an ambiguous match", () => {
    const dup = [{ id: "U1", name: "Тарас" }, { id: "U2", name: "Тарас" }];
    expect(matchSlackId("Тарас", dup)).toBeNull();
  });
});
