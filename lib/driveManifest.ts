/**
 * Pure parsing + validation for the Drive sync manifest
 * (reports/drive/manifest.json). No fs, no network — see lib/driveStore.ts
 * for reading the file and lib/drive.ts for fetching.
 */

export type DriveType = "sheet" | "doc";

export interface DriveSource {
  /** Stable slug — CLI --only, state.json key, web row key. */
  id: string;
  /** Full Drive URL; the file id is parsed from it. */
  url: string;
  type: DriveType;
  /** Repo-relative output path for the snapshot. */
  dest: string;
  /** Spreadsheet tab id; only valid on `sheet`. Defaults to "0". */
  gid?: string;
}

export interface DriveManifest {
  sources: DriveSource[];
}

const ID_PATTERNS = [
  /\/d\/([a-zA-Z0-9_-]+)/, // /spreadsheets/d/<id>/, /document/d/<id>/
  /[?&]id=([a-zA-Z0-9_-]+)/, // open?id=<id>
];

/** Extract the Drive file id from a share/edit URL. Throws if none found. */
export function extractFileId(url: string): string {
  for (const re of ID_PATTERNS) {
    const m = url.match(re);
    if (m) return m[1];
  }
  throw new Error(`Could not extract a Drive file id from url: ${url}`);
}

const TYPES: readonly DriveType[] = ["sheet", "doc"];

/** Parse + validate the manifest JSON. Throws listing every problem found. */
export function parseManifest(raw: string): DriveManifest {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`manifest is not valid JSON: ${(e as Error).message}`);
  }

  const sources = (data as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) {
    throw new Error('manifest must have a "sources" array');
  }

  const errors: string[] = [];
  const seen = new Set<string>();

  sources.forEach((s, i) => {
    const src = s as Partial<DriveSource>;
    const where = `sources[${i}]${src.id ? ` (${src.id})` : ""}`;

    if (!src.id || typeof src.id !== "string") errors.push(`${where}: missing id`);
    else if (seen.has(src.id)) errors.push(`${where}: duplicate id "${src.id}"`);
    else seen.add(src.id);

    if (!src.type || !TYPES.includes(src.type as DriveType)) {
      errors.push(`${where}: type must be one of ${TYPES.join(", ")}`);
    }
    if (!src.dest || typeof src.dest !== "string") errors.push(`${where}: missing dest`);
    if (src.gid !== undefined && src.type !== "sheet") {
      errors.push(`${where}: gid is only valid on type "sheet"`);
    }
    if (typeof src.url !== "string") {
      errors.push(`${where}: missing url`);
    } else {
      try {
        extractFileId(src.url);
      } catch {
        errors.push(`${where}: could not extract a Drive file id from url`);
      }
    }
  });

  if (errors.length) {
    throw new Error(`Invalid manifest:\n  - ${errors.join("\n  - ")}`);
  }

  return { sources: sources as DriveSource[] };
}
