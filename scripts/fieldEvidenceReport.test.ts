import { describe, it, expect } from "vitest";
import { parseArgs, resolveActor } from "./fieldEvidenceReport";

describe("field-evidence args", () => {
  it("parses thread/reply/as/write", () => {
    expect(parseArgs(["--thread", "C1:1.1", "--reply", "залив", "--as", "U08G4EC244X", "--write"])).toMatchObject({ thread: "C1:1.1", reply: "залив", as: "U08G4EC244X", write: true, list: false });
  });
  it("parses --list with a window", () => {
    expect(parseArgs(["--list", "--start", "2026-09-01", "--end", "2026-09-30"])).toMatchObject({ list: true, start: "2026-09-01", end: "2026-09-30" });
  });
});

describe("resolveActor", () => {
  it("an approver user id → approver role + name", () => {
    expect(resolveActor("U08G4EC244X")).toEqual({ userId: "U08G4EC244X", userName: "Oleksandr K", role: "approver" });
  });
  it("a roster name → pilot with that name", () => {
    expect(resolveActor("Тарас Панасюк").role).toBe("pilot");
  });
  it("absent → a pilot stub", () => {
    expect(resolveActor(undefined)).toMatchObject({ role: "pilot" });
  });
});
