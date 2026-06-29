import { describe, expect, it } from "vitest";
import { computeBackfillPlan } from "./backfillPublished";
import { formatDayMessage } from "./verdictPublish";
import type { DayVerdict } from "./fieldDayVerdict";
import type { PublishedEntry, PublishedLog } from "./published";

const verdict = (over: Partial<DayVerdict>): DayVerdict => ({
  date: "2026-06-18",
  status: "ACCEPTED",
  airborneMinutes: 18,
  videoMinutes: 206,
  ratio: 206 / 18,
  datasetPosted: true,
  withinGrace: false,
  reasons: [],
  ...over,
});

const entry = (over: Partial<PublishedEntry>): PublishedEntry => ({
  date: "2026-06-18",
  channel: "field-qa",
  text: "✅ 2026-06-18 — accepted (video 206m is 1144% of 18m airborne; dataset ✓).",
  postedAt: "2026-06-20T00:00:00Z",
  ts: "1.1",
  ...over,
});

const logOf = (...es: PublishedEntry[]): PublishedLog =>
  Object.fromEntries(es.map((e) => [e.date, e]));

describe("computeBackfillPlan", () => {
  it("marks an English post needing the Ukrainian re-render as update", () => {
    const v = verdict({});
    const plan = computeBackfillPlan(logOf(entry({})), { "2026-06-18": v });
    expect(plan).toHaveLength(1);
    expect(plan[0].action).toBe("update");
    expect(plan[0].reason).toBe("needs-update");
    expect(plan[0].newText).toBe(formatDayMessage(v));
    expect(plan[0].oldText).toContain("accepted");
    expect(plan[0].ts).toBe("1.1");
  });

  it("skips a post already in the current format (idempotent re-run)", () => {
    const v = verdict({});
    const plan = computeBackfillPlan(logOf(entry({ text: formatDayMessage(v) })), { "2026-06-18": v });
    expect(plan[0].action).toBe("skip");
    expect(plan[0].reason).toBe("already-current");
  });

  it("skips an overridden post so its struck amendment is never clobbered", () => {
    const v = verdict({ status: "NEEDS_REVIEW", videoMinutes: 0, ratio: 0, datasetPosted: false });
    const plan = computeBackfillPlan(
      logOf(entry({ override: { decision: "accepted_exception", by: "Oleksandr K", ackedAt: "x" } })),
      { "2026-06-18": v },
    );
    expect(plan[0].action).toBe("skip");
    expect(plan[0].reason).toBe("overridden");
    expect(plan[0].overridden).toBe(true);
  });

  it("skips a post with no matching verdict in the report", () => {
    const plan = computeBackfillPlan(logOf(entry({})), {});
    expect(plan[0].action).toBe("skip");
    expect(plan[0].reason).toBe("no-verdict");
  });

  it("returns items sorted by date", () => {
    const plan = computeBackfillPlan(
      logOf(entry({ date: "2026-06-18" }), entry({ date: "2026-06-01" }), entry({ date: "2026-06-09" })),
      {},
    );
    expect(plan.map((p) => p.date)).toEqual(["2026-06-01", "2026-06-09", "2026-06-18"]);
  });
});
