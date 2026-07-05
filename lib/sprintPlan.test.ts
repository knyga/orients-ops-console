import { describe, it, expect } from "vitest";
import { nextSprintNumber, planNextSprint } from "./sprintPlan";

describe("nextSprintNumber", () => {
  it("reads the trailing number of the active sprint name", () => {
    expect(nextSprintNumber("ATP 40")).toBe(41);
  });

  it("uses the last number when the name has several", () => {
    expect(nextSprintNumber("Q3 Sprint 9")).toBe(10);
  });

  it("returns null when the name carries no number", () => {
    expect(nextSprintNumber("Backlog grooming")).toBeNull();
  });
});

describe("planNextSprint", () => {
  const future = [
    { id: 1223, name: "ATP 41" },
    { id: 1224, name: "ATP 42" },
  ];

  it("uses the existing future sprint whose number is active+1", () => {
    expect(planNextSprint("ATP 40", future)).toEqual({ sprintId: 1223, sprintName: "ATP 41", create: false });
  });

  it("matches by number even when the future name's spacing differs", () => {
    expect(planNextSprint("ATP 40", [{ id: 9, name: "ATP41" }])).toEqual({
      sprintId: 9,
      sprintName: "ATP41",
      create: false,
    });
  });

  it("plans a create (same prefix, incremented number) when no future sprint matches", () => {
    expect(planNextSprint("ATP 40", [{ id: 1224, name: "ATP 42" }])).toEqual({
      sprintId: null,
      sprintName: "ATP 41",
      create: true,
    });
  });

  it("returns null when the active sprint name has no number to increment", () => {
    expect(planNextSprint("Kanban", future)).toBeNull();
  });
});
