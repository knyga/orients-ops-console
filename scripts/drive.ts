// scripts/drive.ts
/**
 * CLI: sync Google Drive sources declared in reports/drive/manifest.json.
 *
 * Usage:
 *   npm run drive -- pull                 # pull every source, write snapshots + state
 *   npm run drive -- pull --only rules    # pull a single source by id
 *   npm run drive -- --check              # no writes; report fresh/stale, exit 1 if stale
 *   npm run drive -- --check --format json
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so
 * the `server-only` import in ../lib/drive resolves to its empty module.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchExport, fetchModifiedTime, DriveError } from "../lib/drive";
import { readManifest, readState, writeState, type DriveState } from "../lib/driveStore";
import type { DriveSource } from "../lib/driveManifest";

interface Args {
  check: boolean;
  only?: string;
  format: "table" | "json";
}

function parseArgs(argv: string[]): Args {
  const args: Args = { check: false, format: "table" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "pull") continue; // default action; accepted for readability
    else if (a === "--check") args.check = true;
    else if (a === "--only") args.only = argv[++i];
    else if (a === "--format") args.format = argv[++i] === "json" ? "json" : "table";
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function selectSources(all: DriveSource[], only?: string): DriveSource[] {
  if (!only) return all;
  const found = all.filter((s) => s.id === only);
  if (!found.length) throw new Error(`No manifest source with id "${only}"`);
  return found;
}

/** ISO timestamp for `pulledAt` — clock use is confined to the CLI. */
function nowIso(): string {
  return new Date().toISOString();
}

async function runCheck(sources: DriveSource[], format: Args["format"]): Promise<void> {
  const state = readState();
  const rows = await Promise.all(
    sources.map(async (s) => {
      const modifiedTime = await fetchModifiedTime(s);
      const known = state[s.id]?.modifiedTime;
      const stale = !known || modifiedTime > known;
      return { id: s.id, dest: s.dest, stale, modifiedTime, pulled: known ?? "—" };
    }),
  );
  const anyStale = rows.some((r) => r.stale);

  if (format === "json") {
    console.log(JSON.stringify({ rows, anyStale }, null, 2));
  } else {
    for (const r of rows) {
      console.log(`${r.stale ? "STALE" : "fresh"}  ${r.id}  (drive ${r.modifiedTime}, pulled ${r.pulled})`);
    }
  }
  if (anyStale) process.exit(1);
}

async function runPull(sources: DriveSource[]): Promise<void> {
  const state: DriveState = readState();
  for (const s of sources) {
    const { text, modifiedTime } = await fetchExport(s);
    const destPath = join(process.cwd(), s.dest);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, text);
    state[s.id] = { modifiedTime, pulledAt: nowIso(), dest: s.dest };
    process.stderr.write(`drive: pulled ${s.id} -> ${s.dest}\n`);
  }
  const statePath = writeState(state);
  process.stderr.write(`drive: wrote ${statePath} (${sources.length} source(s))\n`);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  const args = parseArgs(process.argv.slice(2));
  const manifest = readManifest();
  const sources = selectSources(manifest.sources, args.only);
  if (!sources.length) {
    process.stderr.write("drive: manifest has no sources; nothing to do\n");
    return;
  }

  if (args.check) await runCheck(sources, args.format);
  else await runPull(sources);
}

main().catch((error: unknown) => {
  const message =
    error instanceof DriveError ? error.message : error instanceof Error ? error.message : String(error);
  process.stderr.write(`drive: ${message}\n`);
  process.exit(1);
});
