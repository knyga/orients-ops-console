/**
 * Read/write the Drive sync sidecars under reports/drive/:
 *   - manifest.json : committed registry (hand-edited)
 *   - state.json    : per-source last-pulled modifiedTime (CLI-written)
 *
 * Like lib/reports.ts this is deliberately NOT `server-only` — it holds no
 * secrets and is imported by both the API route and the CLI. node:fs keeps it
 * out of the browser bundle. Resolved from process.cwd() (repo root) for the
 * same reason as lib/reports.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest, type DriveManifest } from "./driveManifest";

export interface DriveStateEntry {
  modifiedTime: string;
  pulledAt: string;
  dest: string;
}
export type DriveState = Record<string, DriveStateEntry>;

export interface DriveStoreOpts {
  baseDir?: string;
}

function baseDirOf(opts?: DriveStoreOpts): string {
  return opts?.baseDir ?? join(process.cwd(), "reports", "drive");
}

export function readManifest(opts?: DriveStoreOpts): DriveManifest {
  const path = join(baseDirOf(opts), "manifest.json");
  return parseManifest(readFileSync(path, "utf8"));
}

export function readState(opts?: DriveStoreOpts): DriveState {
  const path = join(baseDirOf(opts), "state.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DriveState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function writeState(state: DriveState, opts?: DriveStoreOpts): string {
  const dir = baseDirOf(opts);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.json");
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  return path;
}
