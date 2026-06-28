import { describe, it, expect } from "vitest";
import { resolveInitial } from "./fieldRoster";

describe("resolveInitial", () => {
  it("maps seed initials to full names", () => {
    expect(resolveInitial("А")).toEqual({ name: "Андріан" });
    expect(resolveInitial("Л")).toEqual({ name: "Любомир" });
    expect(resolveInitial("Серж")).toEqual({ name: "Сергій" });
    expect(resolveInitial("сер")).toEqual({ name: "Сергій" }); // case-insensitive prefix
  });
  it("trims surrounding whitespace", () => {
    expect(resolveInitial("  Д ")).toEqual({ name: "Данило" });
  });
  it("flags an unmapped initial", () => {
    expect(resolveInitial("М")).toEqual({ unknown: "М" });
  });
  it("lets a caller alias override an unknown", () => {
    expect(resolveInitial("М", { М: "Максим" })).toEqual({ name: "Максим" });
  });
});
