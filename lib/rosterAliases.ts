/**
 * Durable roster initial→name aliases (e.g. a resolved "М"→"Максим"), shared by
 * the CLI + web. Backed by the roster_aliases table. mergeAliases is pure.
 */
import { db, schema } from "./db";

export function mergeAliases(seed: Record<string, string>, overrides: Record<string, string>): Record<string, string> {
  return { ...seed, ...overrides };
}

export async function readAliases(): Promise<Record<string, string>> {
  const rows = await db.select().from(schema.rosterAliases);
  return Object.fromEntries(rows.map((r) => [r.initial, r.name]));
}

export async function writeAlias(initial: string, name: string, source: string): Promise<void> {
  const values = { initial, name, source, recordedAt: new Date().toISOString() };
  await db.insert(schema.rosterAliases).values(values).onConflictDoUpdate({ target: schema.rosterAliases.initial, set: values });
}
