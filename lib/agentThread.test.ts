import { describe, it, expect, vi, beforeEach } from "vitest";

const rows = vi.hoisted(() => ({ select: [] as unknown[], insertCalls: [] as unknown[] }));
vi.mock("@/lib/db", () => {
  const chain = () => ({
    where: () => Promise.resolve(rows.select),
    from: () => chain(),
  });
  return {
    db: {
      select: () => chain(),
      insert: () => ({
        values: (values: unknown) => ({
          onConflictDoUpdate: (opts: { target: unknown; set: unknown }) => {
            rows.insertCalls.push({ values, target: opts.target, set: opts.set });
            return Promise.resolve();
          },
        }),
      }),
    },
    schema: { agentThreads: { channelId: "channel_id" } },
  };
});

import { agentThreadExists, appendBotTurn } from "./agentThread";

beforeEach(() => {
  rows.select = [];
  rows.insertCalls = [];
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

describe("appendBotTurn", () => {
  it("appends a single assistant turn and upserts under the cap", async () => {
    const priorTurns = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ];
    rows.select = [{ channelId: "D0AB12345", updatedAt: new Date().toISOString(), transcript: priorTurns }];

    await appendBotTurn("D0AB12345", "🛸 Втрати бортів за 2026-07: 2 (було 0).");

    expect(rows.insertCalls).toHaveLength(1);
    const call = rows.insertCalls[0] as { values: { channelId: string; updatedAt: string; transcript: unknown }; target: unknown; set: unknown };
    expect(call.values.channelId).toBe("D0AB12345");
    expect(call.values.transcript).toEqual([
      ...priorTurns,
      { role: "assistant", text: "🛸 Втрати бортів за 2026-07: 2 (було 0)." },
    ]);
    expect(call.values.updatedAt).toBeTruthy();
    expect(call.set).toEqual({ updatedAt: call.values.updatedAt, transcript: call.values.transcript });
  });
});
