import { describe, it, expect } from "vitest";
import { mergeAliases } from "./rosterAliases";

describe("mergeAliases", () => {
  it("overrides win over seed", () => {
    expect(mergeAliases({ А: "Андріан" }, { М: "Максим" })).toEqual({ А: "Андріан", М: "Максим" });
  });
});
