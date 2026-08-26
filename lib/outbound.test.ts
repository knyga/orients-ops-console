import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The DB layer is exercised against a mocked drizzle chain — these tests pin the
 * claim/read CONTRACTS (what row shapes go in and come out), not SQL.
 */
const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  returning: vi.fn(),
  selectWhere: vi.fn(),
}));
vi.mock("./db", () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => {
        mocks.insertValues(v);
        return { onConflictDoNothing: () => ({ returning: mocks.returning }) };
      },
    }),
    select: () => ({ from: () => ({ where: mocks.selectWhere }) }),
  },
  schema: { outboundMessages: { ts: {}, key: {} } },
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
  desc: (x: unknown) => x,
  sql: () => ({}),
}));

import { claimSentKey, findSentByTs } from "./outbound";

const META = {
  feature: "sprint",
  kind: "post",
  channel: "general",
  channelId: "C08GX9DE54P",
  text: "anchor text",
  trigger: "webhook",
};

beforeEach(() => vi.clearAllMocks());

describe("claimSentKey", () => {
  it("inserts a SENT row pointing at the existing ts, with zero send attempts", async () => {
    mocks.returning.mockResolvedValue([{ key: "k" }]);
    const won = await claimSentKey("sprint-committed:v2:general:ATP-49", "111.222", META);
    expect(won).toBe(true);
    const row = mocks.insertValues.mock.calls[0][0];
    expect(row).toMatchObject({
      key: "sprint-committed:v2:general:ATP-49",
      ts: "111.222",
      status: "sent",
      attempts: 0, // nothing was sent under this key — it claims an existing message
      threadTs: null,
      ...META,
    });
    expect(row.sentAt).toBeTruthy();
    expect(row.reservedAt).toBeTruthy();
  });

  it("is idempotent: a held key loses the insert and reports false (never clobbers)", async () => {
    mocks.returning.mockResolvedValue([]); // ON CONFLICT DO NOTHING → no row back
    const won = await claimSentKey("sprint-committed:v2:general:ATP-49", "111.222", META);
    expect(won).toBe(false);
  });
});

describe("findSentByTs", () => {
  it("returns EVERY row sharing the ts — the post plus later edit/claim rows", async () => {
    const rows = [
      { key: "sprint-plan-pending:general:2026-08-25", kind: "post", ts: "111.222" },
      { key: "sprint-plan-filled:general:ATP-49", kind: "edit", ts: "111.222" },
    ];
    mocks.selectWhere.mockResolvedValue(rows);
    expect(await findSentByTs("111.222")).toEqual(rows);
  });

  it("returns an empty array for an unknown ts", async () => {
    mocks.selectWhere.mockResolvedValue([]);
    expect(await findSentByTs("999.999")).toEqual([]);
  });
});
