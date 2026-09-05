/**
 * Content-addressed memoization for the expensive per-message Claude calls in the
 * #field-qa extract (vision airborne-time reads + drone-count classification).
 * Both used to re-run over the WHOLE active month on every nightly pass, which
 * grew past Vercel Hobby's 60s function cap once the month filled up — the reason
 * the bot stopped publishing verdicts mid-month. Keyed by a hash of the message
 * content (image id for vision, text + Kyiv post-date for drone), so an unchanged
 * message reuses its prior result and only new/edited messages hit Claude.
 * Semantics are unchanged: identical content → identical result; an edit changes
 * the hash → a fresh extraction.
 *
 * NOT server-only: the CLIs import it via fieldQaExtract (like lib/reports.ts).
 * The pure wrapper factories take an injected store so they unit-test DB-free.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "./db";
import type { AirborneExtract } from "./flightExtractPrompt";
import type { DroneClassifier } from "./extractDroneReports";
import type { DroneDayReport } from "./droneCountReportPrompt";

export function contentHash(parts: string): string {
  return createHash("sha256").update(parts).digest("hex");
}

/** Cache keys — also used by callers to preload the exact hashes in one query. */
export const airborneKey = (imageId: string): string => contentHash(`airborne|${imageId}`);
/** The classifier context changes the prompt — so it changes the key too (a
 *  reminder-thread reply re-classifies once instead of replaying the old,
 *  context-free answer). */
export type { DroneClassifyContext } from "./droneCountReportPrompt";
import type { DroneClassifyContext } from "./droneCountReportPrompt";
export const droneKey = (text: string, postedOn?: string, ctx?: DroneClassifyContext): string =>
  contentHash(`drone|${postedOn ?? ""}|${ctx?.inReminderThread ? "reminder-thread|" : ""}${text}`);

/** Hash → stored result JSON. Injected so the wrappers test without a DB. */
export interface ExtractCacheStore {
  readMany(hashes: string[]): Promise<Map<string, string>>;
  write(hash: string, result: string): Promise<void>;
}

/** DB-backed store over the `extract_cache` table, scoped to one `kind`. */
export function dbExtractCacheStore(kind: string): ExtractCacheStore {
  return {
    async readMany(hashes) {
      if (hashes.length === 0) return new Map();
      const rows = await db
        .select()
        .from(schema.extractCache)
        .where(and(eq(schema.extractCache.kind, kind), inArray(schema.extractCache.hash, hashes)));
      return new Map(rows.map((r) => [r.hash, r.result]));
    },
    async write(hash, result) {
      const values = { kind, hash, result, updatedAt: new Date().toISOString() };
      await db
        .insert(schema.extractCache)
        .values(values)
        .onConflictDoUpdate({ target: [schema.extractCache.kind, schema.extractCache.hash], set: values });
    },
  };
}

/**
 * Cached vision airborne-time reader. `load` (the image download) is deferred so
 * a cache hit never touches the network. Writes through on a miss.
 */
export function makeCachedAirborne(
  store: ExtractCacheStore,
  preloaded: Map<string, string>,
  extract: (base64: string, mediaType: string) => Promise<AirborneExtract>,
): {
  run: (imageId: string, load: () => Promise<{ base64: string; mediaType: string }>) => Promise<AirborneExtract>;
  misses: () => number;
} {
  let misses = 0;
  return {
    misses: () => misses,
    async run(imageId, load) {
      const key = airborneKey(imageId);
      const hit = preloaded.get(key);
      if (hit) return JSON.parse(hit) as AirborneExtract;
      misses += 1;
      const { base64, mediaType } = await load();
      const value = await extract(base64, mediaType);
      await store.write(key, JSON.stringify(value));
      return value;
    },
  };
}

/** Cached drone-count classifier, drop-in for the injectable classify param. */
export function makeCachedDroneClassifier(
  store: ExtractCacheStore,
  preloaded: Map<string, string>,
  classify: DroneClassifier,
): { classifier: DroneClassifier; misses: () => number } {
  let misses = 0;
  const classifier: DroneClassifier = async (text, postedOn, ctx) => {
    const key = droneKey(text, postedOn, ctx);
    const hit = preloaded.get(key);
    if (hit) return JSON.parse(hit) as { reports: DroneDayReport[] };
    misses += 1;
    const res = await classify(text, postedOn, ctx);
    await store.write(key, JSON.stringify(res));
    return res;
  };
  return { classifier, misses: () => misses };
}
