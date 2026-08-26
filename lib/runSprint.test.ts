import { beforeEach, describe, expect, it, vi } from "vitest";

const { postMessage, listSprints, fetchSprintIssues, fetchIssuesByKeys, readSprint, writeSprint } =
  vi.hoisted(() => ({
    postMessage: vi.fn(),
    listSprints: vi.fn(),
    fetchSprintIssues: vi.fn(),
    fetchIssuesByKeys: vi.fn(),
    readSprint: vi.fn(),
    writeSprint: vi.fn(),
  }));
vi.mock("./slack", () => ({ postMessage }));
vi.mock("./jira", () => ({
  listSprints,
  fetchSprintIssues,
  fetchIssuesByKeys,
  boardIdFromEnv: () => 1,
}));
vi.mock("./sprintStore", () => ({ readSprint, writeSprint }));

import { runSprintCommit, runSprintReport } from "./runSprint";
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
