import { describe, expect, it } from "vitest";
import {
  buildPrGroundingText,
  DEFAULT_GROUNDING_CAPS,
  selectMergedInWindow,
  type PrContext,
} from "./prGrounding";

function pr(over: Partial<PrContext> = {}): PrContext {
  return {
    repo: "autopilot",
    number: 42,
    title: "Stabilize takeoff pitch",
    author: "vlad",
    body: "Fixes oscillation on takeoff by clamping pitch rate.",
    mergedAt: "2026-08-12T10:00:00Z",
    comments: [{ author: "bohdan", body: "LGTM after the clamp fix" }],
    diff: "diff --git a/pid.c b/pid.c\n-old\n+new",
    ...over,
  };
}

describe("buildPrGroundingText", () => {
  it("returns empty text and zero meta for no PRs", () => {
    const r = buildPrGroundingText([]);
    expect(r.text).toBe("");
    expect(r.meta.prCount).toBe(0);
    expect(r.meta.included).toEqual([]);
    expect(r.meta.truncated).toBe(false);
  });

  it("renders repo#number, title, author, body, comments and diff for one PR", () => {
    const r = buildPrGroundingText([pr()]);
    expect(r.text).toContain("autopilot#42");
    expect(r.text).toContain("Stabilize takeoff pitch");
    expect(r.text).toContain("vlad");
    expect(r.text).toContain("clamping pitch rate");
    expect(r.text).toContain("bohdan: LGTM after the clamp fix");
    expect(r.text).toContain("diff --git a/pid.c");
    expect(r.meta.prCount).toBe(1);
    expect(r.meta.included).toEqual([
      { repo: "autopilot", number: 42, title: "Stabilize takeoff pitch" },
    ]);
    expect(r.meta.totalChars).toBe(r.text.length);
    expect(r.meta.truncated).toBe(false);
  });

  it("truncates an oversized diff with a marker and flags truncated", () => {
    const r = buildPrGroundingText([pr({ diff: "x".repeat(50_000) })], {
      ...DEFAULT_GROUNDING_CAPS,
      maxDiffChars: 100,
    });
    expect(r.text).toContain("…[обрізано]");
    expect(r.text.length).toBeLessThan(10_000);
    expect(r.meta.truncated).toBe(true);
  });

  it("caps comments per PR and comment length", () => {
    const comments = Array.from({ length: 20 }, (_, i) => ({
      author: `u${i}`,
      body: `comment ${i} ${"y".repeat(1000)}`,
    }));
    const r = buildPrGroundingText([pr({ comments })], {
      ...DEFAULT_GROUNDING_CAPS,
      maxCommentsPerPr: 3,
      maxCommentChars: 40,
    });
    expect(r.text).toContain("u0:");
    expect(r.text).toContain("u2:");
    expect(r.text).not.toContain("u3:");
    expect(r.meta.truncated).toBe(true);
  });

  it("drops PRs beyond maxPrs, keeping input order, and flags truncated", () => {
    const prs = [pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3 })];
    const r = buildPrGroundingText(prs, { ...DEFAULT_GROUNDING_CAPS, maxPrs: 2 });
    expect(r.text).toContain("autopilot#1");
    expect(r.text).toContain("autopilot#2");
    expect(r.text).not.toContain("autopilot#3");
    expect(r.meta.included.map((p) => p.number)).toEqual([1, 2]);
    expect(r.meta.truncated).toBe(true);
  });

  it("stops adding PRs once the total cap is reached", () => {
    const big = "z".repeat(400);
    const prs = [pr({ number: 1, body: big }), pr({ number: 2, body: big })];
    const r = buildPrGroundingText(prs, {
      ...DEFAULT_GROUNDING_CAPS,
      maxTotalChars: 600,
    });
    expect(r.text).toContain("autopilot#1");
    expect(r.text).not.toContain("autopilot#2");
    expect(r.meta.truncated).toBe(true);
    expect(r.meta.totalChars).toBeLessThanOrEqual(600);
  });
});

describe("selectMergedInWindow", () => {
  const nodes = [
    { number: 1, mergedAt: "2026-08-10T08:00:00Z" },
    { number: 2, mergedAt: null },
    { number: 3, mergedAt: "2026-08-16T23:30:00Z" },
    { number: 4, mergedAt: "2026-08-09T23:59:00Z" }, // before window
    { number: 5, mergedAt: "2026-08-17T00:10:00Z" }, // after window
  ];

  it("keeps only PRs merged inside the UTC day window, newest first", () => {
    const out = selectMergedInWindow(nodes, "2026-08-10", "2026-08-16", 30);
    expect(out.map((n) => n.number)).toEqual([3, 1]);
  });

  it("caps the result at maxPrs", () => {
    const out = selectMergedInWindow(nodes, "2026-08-01", "2026-08-31", 1);
    expect(out.map((n) => n.number)).toEqual([5]);
  });
});
