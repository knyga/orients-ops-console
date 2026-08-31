import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  postMessage,
  updateMessage,
  claimSentKey,
  listSprints,
  fetchSprintIssues,
  fetchIssuesByKeys,
  fetchResolvedIssues,
  readSprint,
  writeSprint,
} = vi.hoisted(() => ({
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  claimSentKey: vi.fn(),
  listSprints: vi.fn(),
  fetchSprintIssues: vi.fn(),
  fetchIssuesByKeys: vi.fn(),
  fetchResolvedIssues: vi.fn(),
  readSprint: vi.fn(),
  writeSprint: vi.fn(),
}));
vi.mock("./slack", () => ({ postMessage, updateMessage }));
vi.mock("./outbound", () => ({ claimSentKey }));
vi.mock("./jira", () => ({
  listSprints,
  fetchSprintIssues,
  fetchIssuesByKeys,
  fetchResolvedIssues,
  boardIdFromEnv: () => 1,
}));
vi.mock("./sprintStore", () => ({ readSprint, writeSprint }));

import { fillSprintPlan, runSprintCommit, runSprintReport } from "./runSprint";
import type { SprintIssue, SprintSnapshot } from "./sprintReport";
import type { PublishedPlan } from "./sprintPublish";

const GENERAL = "C08GX9DE54P"; // #general channel id from lib/slackChannels.ts
const SPRINT = { id: 7, name: "ATP 42", state: "active" };

/** Enough issues (long Cyrillic summaries) to force more than one detail message. */
function manyIssues(count: number): SprintIssue[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `ATP-${i + 1}`,
    summary: "Дуже довгий опис задачі, який займає багато байтів у кодуванні UTF-8",
    assignee: { accountId: `acc-${i % 5}`, displayName: `Виконавець ${i % 5}` },
    statusName: "To Do",
    statusCategory: "To Do",
    sprintCount: 1,
  }));
}

function snapshot(issues: SprintIssue[]): SprintSnapshot {
  return {
    sprintId: SPRINT.id,
    sprintName: SPRINT.name,
    slug: "ATP-42",
    capturedAt: "2026-08-25T06:00:00.000Z",
    issues,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listSprints.mockResolvedValue([SPRINT]);
  readSprint.mockResolvedValue(null);
  writeSprint.mockResolvedValue(undefined);
  // Distinct ts per send, so a reply threaded under the wrong message is visible.
  let n = 0;
  postMessage.mockImplementation(async () => `1787515233.00000${++n}`);
});

describe("runSprintCommit publishing", () => {
  it("posts one anchor then every detail as a reply in the anchor's thread", async () => {
    fetchSprintIssues.mockResolvedValue(manyIssues(90));

    const result = await runSprintCommit({ publish: true, channelName: "general", trigger: "cron" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.details.length).toBeGreaterThan(1);
    expect(postMessage).toHaveBeenCalledTimes(1 + result.details.length);

    // Anchor: top-level (no thread_ts), versioned+channel-scoped key.
    const [anchorChannel, anchorText, anchorMeta, anchorThread] = postMessage.mock.calls[0];
    expect(anchorChannel).toBe(GENERAL);
    expect(anchorText).toBe(result.anchor);
    expect(anchorMeta.key).toBe("sprint-committed:v2:general:ATP-42");
    expect(anchorThread).toBeUndefined();

    // Replies: threaded under the ANCHOR's ts, keyed 1-based in order.
    const anchorTs = await postMessage.mock.results[0].value;
    postMessage.mock.calls.slice(1).forEach(([channelId, text, meta, threadTs], i) => {
      expect(channelId).toBe(GENERAL);
      expect(text).toBe(result.details[i]);
      expect(meta.key).toBe(`sprint-committed:v2:general:ATP-42:t${i + 1}`);
      expect(threadTs).toBe(anchorTs);
    });
  });

  it("dry-run computes the post and sends nothing", async () => {
    fetchSprintIssues.mockResolvedValue(manyIssues(10));
    const result = await runSprintCommit({ publish: false });
    expect(postMessage).not.toHaveBeenCalled();
    expect(result.status === "ok" && result.posted).toBe(false);
  });

  it("throws instead of silently dropping a reply the chokepoint skipped", async () => {
    fetchSprintIssues.mockResolvedValue(manyIssues(90));
    // A stuck `pending` row returns an empty ts (lib/sendTracked.ts) — that chunk
    // never reaches Slack, so the run must fail loudly, not report success.
    postMessage.mockImplementationOnce(async () => "1787515233.000001").mockImplementationOnce(async () => "");

    await expect(
      runSprintCommit({ publish: true, channelName: "general", trigger: "cron" }),
    ).rejects.toThrow(/detail reply 1\//);
  });

  it("throws when the anchor comes back with no ts", async () => {
    fetchSprintIssues.mockResolvedValue(manyIssues(10));
    postMessage.mockImplementation(async () => "");
    await expect(
      runSprintCommit({ publish: true, channelName: "general", trigger: "cron" }),
    ).rejects.toThrow(/anchor post/);
  });
});

describe("runSprintReport publishing", () => {
  const frozen = manyIssues(90);

  beforeEach(() => {
    readSprint.mockResolvedValue({ committed: snapshot(frozen) });
    fetchIssuesByKeys.mockResolvedValue(frozen);
  });

  it("threads the completed detail under its own anchor with completed keys", async () => {
    const result = await runSprintReport({ publish: true, channelName: "general", trigger: "cron" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const anchorTs = await postMessage.mock.results[0].value;
    expect(postMessage.mock.calls[0][2].key).toBe("sprint-completed:v2:general:ATP-42");
    for (const [, , meta, threadTs] of postMessage.mock.calls.slice(1)) {
      expect(meta.key).toMatch(/^sprint-completed:v2:general:ATP-42:t\d+$/);
      expect(threadTs).toBe(anchorTs);
    }
  });

  it("freezes the published texts in the sprint record on the first publish", async () => {
    const result = await runSprintReport({ publish: true, channelName: "general", trigger: "cron" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const stored = writeSprint.mock.calls.at(-1)?.[1];
    const plans: PublishedPlan[] = stored.published;
    expect(plans).toHaveLength(1);
    expect(plans[0].kind).toBe("completed");
    expect(plans[0].channel).toBe("general");
    expect(plans[0].anchor).toBe(result.anchor);
    expect(plans[0].details).toEqual(result.details);
  });

  it("replays the frozen texts on a retry, even when live Jira has moved on", async () => {
    const plans: PublishedPlan[] = [
      {
        kind: "completed",
        channel: "general",
        anchor: "✅ frozen anchor",
        details: ["frozen t1", "frozen t2"],
        plannedAt: "2026-08-24T20:00:00.000Z",
      },
    ];
    readSprint.mockResolvedValue({ committed: snapshot(frozen), published: plans });

    const result = await runSprintReport({ publish: true, channelName: "general", trigger: "cron" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // Sent the frozen plan verbatim (3 sends), not the freshly packed post.
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(postMessage.mock.calls[0][1]).toBe("✅ frozen anchor");
    expect(postMessage.mock.calls[1][1]).toBe("frozen t1");
    expect(postMessage.mock.calls[2][1]).toBe("frozen t2");
    expect(result.anchor).toBe("✅ frozen anchor");
    expect(result.details).toEqual(["frozen t1", "frozen t2"]);
  });

  it("keeps another channel's plan when publishing to a second channel", async () => {
    const plans: PublishedPlan[] = [
      {
        kind: "completed",
        channel: "test-bot",
        anchor: "test anchor",
        details: ["test t1"],
        plannedAt: "2026-08-24T20:00:00.000Z",
      },
    ];
    readSprint.mockResolvedValue({ committed: snapshot(frozen), published: plans });

    await runSprintReport({ publish: true, channelName: "general", trigger: "cli" });
    // Fresh plan for #general, the test channel's plan untouched.
    const stored = writeSprint.mock.calls.at(-1)?.[1];
    expect(stored.published).toHaveLength(2);
    expect(postMessage.mock.calls[0][2].key).toBe("sprint-completed:v2:general:ATP-42");
    expect(postMessage.mock.calls[0][1]).not.toBe("test anchor");
  });

  it("skips when no frozen baseline exists", async () => {
    readSprint.mockResolvedValue(null);
    const result = await runSprintReport({ publish: true, channelName: "general" });
    expect(result.status).toBe("no-baseline");
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("runSprintReport scope changes", () => {
  const DATES = {
    startDate: "2026-08-25T06:00:00.000Z",
    endDate: "2026-08-31T18:00:00.000Z",
  };
  const frozen = manyIssues(10);
  const hotfix = { key: "ATP-500", summary: "Hotfix", assignee: null, storyPoints: null, histories: [] };

  beforeEach(() => {
    readSprint.mockResolvedValue({ committed: snapshot(frozen) });
    fetchIssuesByKeys.mockResolvedValue(frozen);
    fetchResolvedIssues.mockResolvedValue([hotfix]);
  });

  it("reports added/removed/unplanned for an OPEN sprint", async () => {
    listSprints.mockResolvedValue([{ ...SPRINT, ...DATES }]);
    // Live membership: ATP-10 left the sprint, ATP-99 joined and is done.
    fetchSprintIssues.mockResolvedValue([
      ...frozen.slice(0, 9),
      { ...frozen[0], key: "ATP-99", statusName: "Done", statusCategory: "Done" },
    ]);

    const result = await runSprintReport({ publish: false });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.anchor).toContain("➕ Додано після коміту: 1 (виконано 1)");
    expect(result.anchor).toContain("➖ Знято зі спринту: 1");
    expect(result.anchor).toContain("🔧 Виконано поза спринтом: 1");
    expect(result.details.join("\n")).toContain("• ATP-500 — Hotfix");
    // The scope diff is persisted alongside the completion result.
    expect(writeSprint.mock.calls.at(-1)?.[1].completed.scope.removed[0].key).toBe("ATP-10");
  });

  it("keeps only the unplanned axis for a CLOSED sprint (membership diff would lie)", async () => {
    listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "closed" ? [{ ...SPRINT, ...DATES, state: "closed", completeDate: DATES.endDate }] : [],
    );

    const result = await runSprintReport({ publish: false, sprintId: SPRINT.id });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(fetchSprintIssues).not.toHaveBeenCalled();
    expect(result.anchor).not.toContain("➕");
    expect(result.anchor).not.toContain("➖");
    expect(result.anchor).toContain("🔧 Виконано поза спринтом: 1");
  });

  it("still posts when the scope stage fails (soft-fail)", async () => {
    listSprints.mockResolvedValue([{ ...SPRINT, ...DATES }]);
    fetchSprintIssues.mockRejectedValue(new Error("jira down"));

    const result = await runSprintReport({ publish: false });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.anchor).toContain("виконано");
    expect(result.anchor).not.toContain("🔧");
  });
});

describe("runSprintCommit — no active sprint (fallback anchor)", () => {
  beforeEach(() => {
    listSprints.mockResolvedValue([]);
  });

  it("with publish posts exactly ONE fallback anchor (no details) under the pending key", async () => {
    const r = await runSprintCommit({ publish: true, channelName: "general", trigger: "cron" });
    expect(r.status).toBe("no-active-sprint");
    if (r.status !== "no-active-sprint") return;
    expect(r.posted).toBe(true);
    expect(r.anchor).toContain("План спринту не складено");

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [channelId, text, meta, threadTs] = postMessage.mock.calls[0];
    expect(channelId).toBe(GENERAL);
    expect(text).toBe(r.anchor);
    expect(meta.key).toMatch(/^sprint-plan-pending:general:\d{4}-\d{2}-\d{2}$/);
    expect(meta.feature).toBe("sprint");
    expect(threadTs).toBeUndefined(); // a top-level anchor, never a reply

    // No baseline exists to freeze — the store must not be touched.
    expect(writeSprint).not.toHaveBeenCalled();
  });

  it("dry-run returns the exact anchor text and posts nothing", async () => {
    const r = await runSprintCommit({ publish: false });
    expect(r.status).toBe("no-active-sprint");
    if (r.status !== "no-active-sprint") return;
    expect(r.posted).toBe(false);
    expect(r.anchor).toContain("згадайте мене");
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("runSprintCommit — fallback anchor send skipped (stuck pending row)", () => {
  it("throws loudly instead of reporting posted: true", async () => {
    listSprints.mockResolvedValue([]);
    postMessage.mockResolvedValue(""); // chokepoint skip → empty ts
    await expect(
      runSprintCommit({ publish: true, channelName: "general", trigger: "cron" }),
    ).rejects.toThrow(/fallback anchor .*stuck pending row/);
  });
});

describe("fillSprintPlan", () => {
  const ANCHOR_TS = "1782899951.295969";

  beforeEach(() => {
    // resolveSprint(sprintId) matches among active + future.
    listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "active" ? [SPRINT] : [],
    );
    fetchSprintIssues.mockResolvedValue(manyIssues(90));
    updateMessage.mockImplementation(async (_channel: string, ts: string) => ts);
    claimSentKey.mockResolvedValue(true);
  });

  it("edits the fallback anchor in place, claims the anchor key, threads the details", async () => {
    const r = await fillSprintPlan({
      channelId: GENERAL,
      anchorTs: ANCHOR_TS,
      sprintId: SPRINT.id,
      trigger: "webhook",
    });
    expect(r).toEqual({ slug: "ATP-42", sprintName: "ATP 42", count: 90 });

    // Baseline frozen + the publish plan frozen (published carried on the record).
    expect(writeSprint).toHaveBeenCalled();
    const lastRecord = writeSprint.mock.calls.at(-1)![1];
    expect(lastRecord.published?.[0]).toMatchObject({ kind: "committed", channel: "general" });

    // The anchor is an EDIT of the existing message, never a new post…
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const [editChannel, editTs, editText, editMeta] = updateMessage.mock.calls[0];
    expect(editChannel).toBe(GENERAL);
    expect(editTs).toBe(ANCHOR_TS);
    expect(editText).toBe(lastRecord.published[0].anchor);
    expect(editMeta.key).toBe("sprint-plan-filled:general:ATP-42");

    // …and the committed anchor key is CLAIMED against it, so the next cron
    // re-fire dedups to this message instead of posting an orphan duplicate.
    expect(claimSentKey).toHaveBeenCalledWith(
      "sprint-committed:v2:general:ATP-42",
      ANCHOR_TS,
      expect.objectContaining({ kind: "post", channel: "general", channelId: GENERAL }),
    );

    // Details: replies under the ANCHOR ts, same positional keys as the cron path.
    const details: string[] = lastRecord.published[0].details;
    expect(details.length).toBeGreaterThan(1);
    expect(postMessage).toHaveBeenCalledTimes(details.length);
    postMessage.mock.calls.forEach(([channelId, text, meta, threadTs], i) => {
      expect(channelId).toBe(GENERAL);
      expect(text).toBe(details[i]);
      expect(meta.key).toBe(`sprint-committed:v2:general:ATP-42:t${i + 1}`);
      expect(threadTs).toBe(ANCHOR_TS);
    });
  });

  it("a retry replays the FROZEN plan byte-identically, not a fresh Jira repack", async () => {
    readSprint.mockResolvedValue({
      committed: snapshot(manyIssues(5)),
      published: [
        {
          kind: "committed",
          channel: "general",
          anchor: "FROZEN ANCHOR",
          details: ["FROZEN DETAIL 1"],
          plannedAt: "2026-08-26T07:00:00.000Z",
        },
      ],
    });
    fetchSprintIssues.mockResolvedValue(manyIssues(90)); // scope changed since the freeze

    await fillSprintPlan({ channelId: GENERAL, anchorTs: ANCHOR_TS, sprintId: SPRINT.id });

    expect(updateMessage.mock.calls[0][2]).toBe("FROZEN ANCHOR");
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][1]).toBe("FROZEN DETAIL 1");
  });

  it("throws in Ukrainian when the sprint vanished between propose and confirm", async () => {
    listSprints.mockResolvedValue([]);
    await expect(
      fillSprintPlan({ channelId: GENERAL, anchorTs: ANCHOR_TS, sprintId: 404 }),
    ).rejects.toThrow(/зник/);
  });

  it("refuses an untracked channel id before touching anything", async () => {
    await expect(
      fillSprintPlan({ channelId: "C_UNKNOWN", anchorTs: ANCHOR_TS, sprintId: SPRINT.id }),
    ).rejects.toThrow(/not a tracked channel/);
    expect(writeSprint).not.toHaveBeenCalled();
  });
});

describe("fillSprintPlan — the anchor edit is skipped (stuck pending row)", () => {
  it("throws loudly and neither claims the anchor key nor threads details", async () => {
    listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "active" ? [SPRINT] : [],
    );
    fetchSprintIssues.mockResolvedValue(manyIssues(10));
    updateMessage.mockResolvedValue(""); // chokepoint skip → empty ts
    claimSentKey.mockResolvedValue(true);

    await expect(
      fillSprintPlan({ channelId: GENERAL, anchorTs: "1.2", sprintId: SPRINT.id }),
    ).rejects.toThrow(/fill-in edit was skipped .*stuck pending row/);
    // The anchor in Slack still shows the fallback text: claiming the anchor
    // key would suppress the recovering cron, and details would orphan.
    expect(claimSentKey).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("runSprintCommit — explicit --sprint id that resolves to nothing", () => {
  it("throws naming the id instead of posting the fallback (board HAS an active sprint)", async () => {
    listSprints.mockImplementation(async (_board: number, state: string) =>
      state === "active" ? [SPRINT] : [],
    );
    await expect(
      runSprintCommit({ publish: true, channelName: "general", sprintId: 999, trigger: "cli" }),
    ).rejects.toThrow(/sprint id 999 not found/);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("throws even when the board has no active sprint — an explicit id never falls back", async () => {
    listSprints.mockResolvedValue([]);
    await expect(runSprintCommit({ publish: false, sprintId: 999 })).rejects.toThrow(
      /sprint id 999 not found/,
    );
  });
});
