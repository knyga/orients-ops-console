import { describe, it, expect, vi, beforeEach } from "vitest";

const rows = vi.hoisted(() => ({ update: [] as unknown[], select: [] as unknown[] }));
vi.mock("@/lib/db", () => {
  const chain = (kind: "update" | "select") => ({
    set: () => chain(kind),
    values: () => Promise.resolve(),
    from: () => chain(kind),
    where: () => (kind === "select" ? Promise.resolve(rows.select) : chain(kind)),
    returning: () => Promise.resolve(rows.update),
  });
  return { db: { update: () => chain("update"), insert: () => chain("update"), select: () => chain("select") }, schema: { agentProposals: {} } };
});
import { claimApply, readPendingProposal } from "./agentProposals";

beforeEach(() => { rows.update = []; rows.select = []; });

describe("claimApply", () => {
  it("true when a row flips, false when none", async () => {
    rows.update = [{ id: "p1" }];
    expect(await claimApply("p1")).toBe(true);
    rows.update = [];
    expect(await claimApply("p1")).toBe(false);
  });
});

describe("readPendingProposal", () => {
  it("null when no PENDING row", async () => {
    rows.select = [];
    expect(await readPendingProposal("C1")).toBeNull();
  });
});
