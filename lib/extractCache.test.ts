import { describe, it, expect, vi } from "vitest";
import {
  contentHash,
  airborneKey,
  droneKey,
  makeCachedAirborne,
  makeCachedDroneClassifier,
  type ExtractCacheStore,
} from "./extractCache";

/** In-memory store that records writes, for testing the memoization without a DB. */
function fakeStore(): ExtractCacheStore & { writes: Map<string, string> } {
  const writes = new Map<string, string>();
  return {
    writes,
    async readMany() {
      return new Map();
    },
    async write(hash, result) {
      writes.set(hash, result);
    },
  };
}

describe("contentHash", () => {
  it("is deterministic and differs on different input", () => {
    expect(contentHash("a")).toBe(contentHash("a"));
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});

describe("makeCachedAirborne", () => {
  const value = { flew: true, airborneSeconds: 120, flights: 3 };

  it("cache HIT: returns the preloaded value, never downloads or extracts", async () => {
    const store = fakeStore();
    const preloaded = new Map([[airborneKey("F123"), JSON.stringify(value)]]);
    const extract = vi.fn();
    const load = vi.fn();
    const { run, misses } = makeCachedAirborne(store, preloaded, extract);

    const out = await run("F123", load);

    expect(out).toEqual(value);
    expect(extract).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled(); // no image download on a hit
    expect(misses()).toBe(0);
    expect(store.writes.size).toBe(0);
  });

  it("cache MISS: loads, extracts, and writes through under the image-id key", async () => {
    const store = fakeStore();
    const preloaded = new Map<string, string>();
    const extract = vi.fn(async () => value);
    const load = vi.fn(async () => ({ base64: "b64", mediaType: "image/png" }));
    const { run, misses } = makeCachedAirborne(store, preloaded, extract);

    const out = await run("F999", load);

    expect(out).toEqual(value);
    expect(load).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledWith("b64", "image/png");
    expect(misses()).toBe(1);
    expect(store.writes.get(airborneKey("F999"))).toBe(JSON.stringify(value));
  });
});

describe("makeCachedDroneClassifier", () => {
  const reports = { reports: [{ entries: [{ name: "Андріан", isPerson: true, count: 1 }], forDate: null }] };

  it("cache HIT: returns preloaded reports without calling the classifier", async () => {
    const store = fakeStore();
    const preloaded = new Map([[droneKey("Андріан - 1шт", "2026-07-01"), JSON.stringify(reports)]]);
    const classify = vi.fn();
    const { classifier, misses } = makeCachedDroneClassifier(store, preloaded, classify);

    const out = await classifier("Андріан - 1шт", "2026-07-01");

    expect(out).toEqual(reports);
    expect(classify).not.toHaveBeenCalled();
    expect(misses()).toBe(0);
  });

  it("cache MISS: classifies and writes through; the key includes postedOn", async () => {
    const store = fakeStore();
    const preloaded = new Map<string, string>();
    const classify = vi.fn(async () => reports);
    const { classifier, misses } = makeCachedDroneClassifier(store, preloaded, classify);

    const out = await classifier("Андріан - 1шт", "2026-07-02");

    expect(out).toEqual(reports);
    expect(classify).toHaveBeenCalledWith("Андріан - 1шт", "2026-07-02");
    expect(misses()).toBe(1);
    expect(store.writes.get(droneKey("Андріан - 1шт", "2026-07-02"))).toBe(JSON.stringify(reports));
    // same text on a different date is a distinct key → would miss again.
    expect(droneKey("Андріан - 1шт", "2026-07-02")).not.toBe(droneKey("Андріан - 1шт", "2026-07-03"));
  });
});
