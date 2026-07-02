import { describe, it, expect, vi, beforeEach } from "vitest";

const rows = vi.hoisted(() => ({ select: [] as unknown[] }));
vi.mock("@/lib/db", () => {
  const chain = () => ({
    where: () => Promise.resolve(rows.select),
    from: () => chain(),
  });
  return { db: { select: () => chain() }, schema: { agentThreads: { channelId: "channel_id" } } };
});

import { agentThreadExists } from "./agentThread";

beforeEach(() => {
  rows.select = [];
});

describe("agentThreadExists", () => {
  it("is false when no row", async () => {
    rows.select = [];
    expect(await agentThreadExists("111.222")).toBe(false);
  });
  it("is true when a row exists", async () => {
    rows.select = [{ channelId: "111.222", updatedAt: new Date().toISOString(), transcript: [] }];
    expect(await agentThreadExists("111.222")).toBe(true);
  });
});
