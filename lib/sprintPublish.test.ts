import { describe, expect, it } from "vitest";
import { findPlan, resolvePlan, upsertPlan, type PublishedPlan } from "./sprintPublish";

const plan = (over: Partial<PublishedPlan> = {}): PublishedPlan => ({
  kind: "completed",
  channel: "general",
  anchor: "anchor",
  details: ["d1", "d2"],
  plannedAt: "2026-08-24T20:00:00.000Z",
  ...over,
});

describe("findPlan", () => {
  it("matches on kind AND channel", () => {
    const plans = [plan(), plan({ kind: "committed", anchor: "c" })];
    expect(findPlan(plans, "completed", "general")?.anchor).toBe("anchor");
    expect(findPlan(plans, "committed", "general")?.anchor).toBe("c");
    expect(findPlan(plans, "completed", "test-channel")).toBeUndefined();
    expect(findPlan(undefined, "completed", "general")).toBeUndefined();
  });
});

describe("upsertPlan", () => {
  it("replaces only the same (kind, channel) and keeps the rest", () => {
    const existing = [plan(), plan({ kind: "committed" }), plan({ channel: "test-channel" })];
    const next = upsertPlan(existing, plan({ anchor: "fresh" }));
    expect(next).toHaveLength(3);
    expect(findPlan(next, "completed", "general")?.anchor).toBe("fresh");
    expect(findPlan(next, "committed", "general")?.anchor).toBe("anchor");
    expect(findPlan(next, "completed", "test-channel")?.anchor).toBe("anchor");
  });

  it("seeds an absent list", () => {
    expect(upsertPlan(undefined, plan())).toEqual([plan()]);
  });
});

describe("resolvePlan", () => {
  const fresh = { anchor: "new anchor", details: ["new d1", "new d2", "new d3"] };

  it("freezes the fresh post on a first publish", () => {
    const { plan: p, replayed } = resolvePlan(
      undefined,
      "completed",
      "general",
      fresh,
      "2026-08-24T20:00:00.000Z",
    );
    expect(replayed).toBe(false);
    expect(p).toEqual({
      ...fresh,
      kind: "completed",
      channel: "general",
      plannedAt: "2026-08-24T20:00:00.000Z",
    });
  });

  it("replays the frozen texts on a retry, ignoring a repacked fresh post", () => {
    // The drift this exists to prevent: a retry re-fetches Jira, statuses moved, so
    // the fresh post packs 3 messages where the first attempt packed 2. Positional
    // keys (`:t1`, `:t2`) would then dedup t1 to the OLD text and send t2 with
    // repacked content, losing (or duplicating) the issues on the boundary.
    const stored = plan({ anchor: "first anchor", details: ["frozen t1", "frozen t2"] });
    const { plan: p, replayed } = resolvePlan(
      [stored],
      "completed",
      "general",
      fresh,
      "2026-08-24T21:00:00.000Z",
    );
    expect(replayed).toBe(true);
    expect(p.anchor).toBe("first anchor");
    expect(p.details).toEqual(["frozen t1", "frozen t2"]);
    expect(p.plannedAt).toBe("2026-08-24T20:00:00.000Z");
  });

  it("treats another channel as its own publication", () => {
    const { plan: p, replayed } = resolvePlan(
      [plan()],
      "completed",
      "test-channel",
      fresh,
      "2026-08-24T21:00:00.000Z",
    );
    expect(replayed).toBe(false);
    expect(p.channel).toBe("test-channel");
    expect(p.details).toEqual(fresh.details);
  });
});
