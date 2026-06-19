# Google Drive Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull Google Drive sheets/docs into committed repo snapshots by link, so Drive is the single source of truth and nothing is hand-copied twice.

**Architecture:** A manifest-driven `drive` feature. A committed `reports/drive/manifest.json` maps each Drive link → local `dest` + `type`. `npm run drive -- pull` reads it, fetches each file through a `server-only` Google client (JWT service-account auth), exports Sheets→CSV / Docs→Markdown, writes the snapshot to `dest`, and records each file's Drive `modifiedTime` in `reports/drive/state.json` for stale detection. Pure shaping/validation lives in tested `lib/` modules; the network client is isolated and untested (mirrors `lib/vimeo.ts`). The web `/drive` tab renders manifest + state read-only.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Vitest, `google-auth-library` (new dep), `tsx`/Node CLI run with `--conditions=react-server`.

## Global Constraints

- TypeScript `strict` is on. Import alias `@/*` → repo root.
- Every feature ships **two** interfaces: web + CLI. Shared logic stays in pure `lib/`.
- `lib/drive.ts` MUST `import "server-only"` and read secrets from `process.env` only. Never import it from a `"use client"` file. The CLI runs via `--conditions=react-server` so that import resolves to its empty module.
- Pure `lib/` modules (`driveManifest`, `driveExport`, `driveStore`) MUST NOT import React/Next/`server-only`. `driveStore` may use `node:fs` (same precedent as `lib/reports.ts` — not `server-only`, unreachable from the browser bundle).
- `Date`/clock use only in `scripts/` (CLI runtime), never in pure libs.
- The web never writes — pulling Drive is exclusively the CLI's job.
- Auth env var: `GOOGLE_SERVICE_ACCOUNT_KEY` = base64 of the service-account JSON.
- Export MIME: sheet → CSV via `https://docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=<gid>`; doc → `text/markdown` via Drive API `files/<id>/export`. Scope: `https://www.googleapis.com/auth/drive.readonly`.

---

## File Structure

```
lib/driveManifest.ts       pure: types, parseManifest(), extractFileId(). Tested.
lib/driveManifest.test.ts
lib/driveExport.ts         pure: exportMime(), buildExportUrl(), normalizeExport(). Tested.
lib/driveExport.test.ts
lib/driveStore.ts          fs read/write of manifest.json + state.json (not server-only). Tested.
lib/driveStore.test.ts
lib/drive.ts               server-only Google client: token + fetchExport + fetchModifiedTime. No unit test.
scripts/drive.ts           CLI: npm run drive -- pull|--check [--only <id>] [--format table|json]
reports/drive/manifest.json   committed registry (seed with [] sources)
reports/drive/state.json      committed (seed {})
app/api/drive/route.ts        GET manifest+state; ?check=1 live modifiedTime compare
app/(dashboard)/drive/page.tsx   tab: sources table, last-pulled, stale badge
.claude/skills/field-drive-sync/SKILL.md
```

---

### Task 1: Manifest parsing & validation (pure)

**Files:**
- Create: `lib/driveManifest.ts`
- Test: `lib/driveManifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DriveType = "sheet" | "doc"`
  - `interface DriveSource { id: string; url: string; type: DriveType; dest: string; gid?: string }`
  - `interface DriveManifest { sources: DriveSource[] }`
  - `function extractFileId(url: string): string` — throws `Error` if no id found.
  - `function parseManifest(raw: string): DriveManifest` — parses JSON, validates, throws `Error` with a message listing all problems.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/driveManifest.test.ts
import { describe, expect, it } from "vitest";
import { extractFileId, parseManifest } from "./driveManifest";

describe("extractFileId", () => {
  it("pulls the id from a spreadsheet url", () => {
    expect(
      extractFileId("https://docs.google.com/spreadsheets/d/ABC123_x/edit#gid=0"),
    ).toBe("ABC123_x");
  });

  it("pulls the id from a document url", () => {
    expect(
      extractFileId("https://docs.google.com/document/d/Doc-9/edit"),
    ).toBe("Doc-9");
  });

  it("pulls the id from an open?id= url", () => {
    expect(
      extractFileId("https://drive.google.com/open?id=Zzz999"),
    ).toBe("Zzz999");
  });

  it("throws when no id is present", () => {
    expect(() => extractFileId("https://example.com/nope")).toThrow(/file id/i);
  });
});

describe("parseManifest", () => {
  const ok = JSON.stringify({
    sources: [
      {
        id: "flight-hours-2026-06",
        url: "https://docs.google.com/spreadsheets/d/SHEET1/edit#gid=0",
        type: "sheet",
        dest: "reports/field-ops/inputs/2026-06.csv",
        gid: "0",
      },
      {
        id: "rules",
        url: "https://docs.google.com/document/d/DOC1/edit",
        type: "doc",
        dest: "docs/drive/rules.md",
      },
    ],
  });

  it("parses a valid manifest", () => {
    const m = parseManifest(ok);
    expect(m.sources).toHaveLength(2);
    expect(m.sources[0].gid).toBe("0");
  });

  it("rejects duplicate ids", () => {
    const dup = JSON.stringify({
      sources: [
        { id: "x", url: "https://docs.google.com/document/d/A/edit", type: "doc", dest: "docs/drive/a.md" },
        { id: "x", url: "https://docs.google.com/document/d/B/edit", type: "doc", dest: "docs/drive/b.md" },
      ],
    });
    expect(() => parseManifest(dup)).toThrow(/duplicate id/i);
  });

  it("rejects an unknown type", () => {
    const bad = JSON.stringify({
      sources: [{ id: "x", url: "https://docs.google.com/document/d/A/edit", type: "pdf", dest: "docs/drive/a.md" }],
    });
    expect(() => parseManifest(bad)).toThrow(/type/i);
  });

  it("rejects gid on a doc", () => {
    const bad = JSON.stringify({
      sources: [{ id: "x", url: "https://docs.google.com/document/d/A/edit", type: "doc", dest: "docs/drive/a.md", gid: "0" }],
    });
    expect(() => parseManifest(bad)).toThrow(/gid/i);
  });

  it("rejects a missing dest", () => {
    const bad = JSON.stringify({
      sources: [{ id: "x", url: "https://docs.google.com/document/d/A/edit", type: "doc" }],
    });
    expect(() => parseManifest(bad)).toThrow(/dest/i);
  });

  it("rejects a url with no extractable id", () => {
    const bad = JSON.stringify({
      sources: [{ id: "x", url: "https://example.com/none", type: "doc", dest: "docs/drive/a.md" }],
    });
    expect(() => parseManifest(bad)).toThrow(/file id/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/driveManifest.test.ts`
Expected: FAIL — "Failed to resolve import './driveManifest'".

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/driveManifest.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/driveManifest.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/driveManifest.ts lib/driveManifest.test.ts
git commit -m "feat(drive): manifest parsing + validation"
```

---

### Task 2: Export URL/MIME builders & normalization (pure)

**Files:**
- Create: `lib/driveExport.ts`
- Test: `lib/driveExport.test.ts`

**Interfaces:**
- Consumes: `DriveSource`, `DriveType` from `./driveManifest`.
- Produces:
  - `function exportMime(type: DriveType): string`
  - `function buildExportUrl(source: { type: DriveType; url: string; gid?: string }): string` — sheets use the docs export host w/ gid; docs use the Drive API export endpoint. Uses `extractFileId` internally.
  - `function metadataUrl(fileId: string): string` — Drive API URL for `modifiedTime`.
  - `function normalizeExport(text: string): string` — strip UTF-8 BOM, CRLF→LF, ensure trailing newline.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/driveExport.test.ts
import { describe, expect, it } from "vitest";
import {
  buildExportUrl,
  exportMime,
  metadataUrl,
  normalizeExport,
} from "./driveExport";

describe("exportMime", () => {
  it("maps sheet to csv", () => expect(exportMime("sheet")).toBe("text/csv"));
  it("maps doc to markdown", () => expect(exportMime("doc")).toBe("text/markdown"));
});

describe("buildExportUrl", () => {
  it("builds a per-gid spreadsheet csv export url", () => {
    const url = buildExportUrl({
      type: "sheet",
      url: "https://docs.google.com/spreadsheets/d/SHEET1/edit#gid=7",
      gid: "7",
    });
    expect(url).toBe(
      "https://docs.google.com/spreadsheets/d/SHEET1/export?format=csv&gid=7",
    );
  });

  it("defaults the gid to 0 when omitted", () => {
    const url = buildExportUrl({
      type: "sheet",
      url: "https://docs.google.com/spreadsheets/d/SHEET1/edit",
    });
    expect(url).toContain("gid=0");
  });

  it("builds a Drive API markdown export url for docs", () => {
    const url = buildExportUrl({
      type: "doc",
      url: "https://docs.google.com/document/d/DOC1/edit",
    });
    expect(url).toBe(
      "https://www.googleapis.com/drive/v3/files/DOC1/export?mimeType=text%2Fmarkdown",
    );
  });
});

describe("metadataUrl", () => {
  it("requests only modifiedTime", () => {
    expect(metadataUrl("DOC1")).toBe(
      "https://www.googleapis.com/drive/v3/files/DOC1?fields=modifiedTime",
    );
  });
});

describe("normalizeExport", () => {
  it("strips a BOM, converts CRLF, and ensures a trailing newline", () => {
    expect(normalizeExport("﻿a,b\r\n1,2")).toBe("a,b\n1,2\n");
  });
  it("does not double the trailing newline", () => {
    expect(normalizeExport("x\n")).toBe("x\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/driveExport.test.ts`
Expected: FAIL — cannot resolve `./driveExport`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/driveExport.ts
/**
 * Pure helpers for turning a manifest source into the right Drive export
 * request, and for normalizing the bytes that come back. No fs/network.
 *
 * Sheets are exported per-gid through the docs.google.com export host (the
 * Drive API `files.export` only yields the first sheet); docs use the Drive
 * API markdown export. Both are called with a Bearer token in lib/drive.ts.
 */
import { extractFileId, type DriveType } from "./driveManifest";

export function exportMime(type: DriveType): string {
  return type === "sheet" ? "text/csv" : "text/markdown";
}

export function buildExportUrl(source: {
  type: DriveType;
  url: string;
  gid?: string;
}): string {
  const id = extractFileId(source.url);
  if (source.type === "sheet") {
    const gid = source.gid ?? "0";
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  }
  const mime = encodeURIComponent(exportMime(source.type));
  return `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${mime}`;
}

export function metadataUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?fields=modifiedTime`;
}

export function normalizeExport(text: string): string {
  const noBom = text.replace(/^﻿/, "");
  const lf = noBom.replace(/\r\n/g, "\n");
  return lf.endsWith("\n") ? lf : `${lf}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/driveExport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/driveExport.ts lib/driveExport.test.ts
git commit -m "feat(drive): export url/mime builders + normalization"
```

---

### Task 3: Manifest + state store (fs)

**Files:**
- Create: `lib/driveStore.ts`
- Test: `lib/driveStore.test.ts`
- Create (seed): `reports/drive/manifest.json`, `reports/drive/state.json`

**Interfaces:**
- Consumes: `parseManifest`, `DriveManifest` from `./driveManifest`.
- Produces:
  - `interface DriveStateEntry { modifiedTime: string; pulledAt: string; dest: string }`
  - `type DriveState = Record<string, DriveStateEntry>`
  - `interface DriveStoreOpts { baseDir?: string }` — `baseDir` defaults to `reports/drive` under `process.cwd()`.
  - `function readManifest(opts?: DriveStoreOpts): DriveManifest` — throws if file missing/invalid.
  - `function readState(opts?: DriveStoreOpts): DriveState` — returns `{}` if absent.
  - `function writeState(state: DriveState, opts?: DriveStoreOpts): string` — writes pretty JSON, returns path.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/driveStore.test.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readManifest, readState, writeState } from "./driveStore";

function tmp(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "drive-")), "drive");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("driveStore", () => {
  it("reads a valid manifest", () => {
    const baseDir = tmp();
    writeFileSync(
      join(baseDir, "manifest.json"),
      JSON.stringify({
        sources: [
          { id: "rules", url: "https://docs.google.com/document/d/DOC1/edit", type: "doc", dest: "docs/drive/rules.md" },
        ],
      }),
    );
    const m = readManifest({ baseDir });
    expect(m.sources[0].id).toBe("rules");
  });

  it("returns {} when state is absent", () => {
    expect(readState({ baseDir: tmp() })).toEqual({});
  });

  it("round-trips state through writeState/readState", () => {
    const baseDir = tmp();
    const state = {
      rules: { modifiedTime: "2026-06-18T09:00:00Z", pulledAt: "2026-06-19T20:00:00Z", dest: "docs/drive/rules.md" },
    };
    const path = writeState(state, { baseDir });
    expect(readFileSync(path, "utf8")).toContain("modifiedTime");
    expect(readState({ baseDir })).toEqual(state);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/driveStore.test.ts`
Expected: FAIL — cannot resolve `./driveStore`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/driveStore.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/driveStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Seed the committed sidecars**

Create `reports/drive/manifest.json`:

```json
{
  "sources": []
}
```

Create `reports/drive/state.json`:

```json
{}
```

- [ ] **Step 6: Commit**

```bash
git add lib/driveStore.ts lib/driveStore.test.ts reports/drive/manifest.json reports/drive/state.json
git commit -m "feat(drive): manifest+state store with seed sidecars"
```

---

### Task 4: Google Drive client (server-only)

**Files:**
- Create: `lib/drive.ts`
- Modify: `package.json` (add `google-auth-library` dependency)
- Modify: `.env.example` (add `GOOGLE_SERVICE_ACCOUNT_KEY`)

**Interfaces:**
- Consumes: `DriveSource` from `./driveManifest`; `buildExportUrl`, `metadataUrl`, `normalizeExport` from `./driveExport`; `extractFileId` from `./driveManifest`.
- Produces:
  - `class DriveError extends Error { status?: number }`
  - `function fetchExport(source: DriveSource): Promise<{ text: string; modifiedTime: string }>`
  - `function fetchModifiedTime(source: DriveSource): Promise<string>`

  No unit test (network + `server-only`), exactly like `lib/vimeo.ts`.

- [ ] **Step 1: Add the dependency**

Run: `npm install google-auth-library`
Expected: `package.json` gains `google-auth-library` under dependencies; lockfile updates.

- [ ] **Step 2: Write the client**

```typescript
// lib/drive.ts
/**
 * Typed Google Drive client. SERVER-ONLY.
 *
 * The service-account key is read from process.env.GOOGLE_SERVICE_ACCOUNT_KEY
 * (base64 of the JSON key) and never reaches the browser — the `server-only`
 * import makes an accidental client import a build error. The CLI runs Node
 * with `--conditions=react-server` so this import resolves to its empty module.
 *
 * Not unit-tested (network + secrets), mirroring lib/vimeo.ts. All shaping that
 * IS testable lives in lib/driveExport.ts and lib/driveManifest.ts.
 */
import "server-only";
import { JWT } from "google-auth-library";
import { extractFileId, type DriveSource } from "./driveManifest";
import { buildExportUrl, metadataUrl, normalizeExport } from "./driveExport";

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

let cachedClient: JWT | null = null;

function client(): JWT {
  if (cachedClient) return cachedClient;
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!b64) {
    throw new DriveError("GOOGLE_SERVICE_ACCOUNT_KEY is not set on the server.");
  }
  let key: { client_email: string; private_key: string };
  try {
    key = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (e) {
    throw new DriveError(
      `GOOGLE_SERVICE_ACCOUNT_KEY is not valid base64 JSON: ${(e as Error).message}`,
    );
  }
  cachedClient = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [SCOPE],
  });
  return cachedClient;
}

async function authedFetch(url: string): Promise<Response> {
  const headers = await client().getRequestHeaders(url);
  const res = await fetch(url, { headers, cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DriveError(
      `Drive returned ${res.status} ${res.statusText} for ${url}${
        body ? `: ${body.slice(0, 300)}` : ""
      }`,
      res.status,
    );
  }
  return res;
}

/** Fetch the export bytes for a source plus the file's current modifiedTime. */
export async function fetchExport(
  source: DriveSource,
): Promise<{ text: string; modifiedTime: string }> {
  const [res, modifiedTime] = await Promise.all([
    authedFetch(buildExportUrl(source)),
    fetchModifiedTime(source),
  ]);
  return { text: normalizeExport(await res.text()), modifiedTime };
}

/** Fetch only the Drive modifiedTime for a source (used by --check). */
export async function fetchModifiedTime(source: DriveSource): Promise<string> {
  const res = await authedFetch(metadataUrl(extractFileId(source.url)));
  const { modifiedTime } = (await res.json()) as { modifiedTime: string };
  return modifiedTime;
}
```

- [ ] **Step 3: Add the env var to `.env.example`**

Add this line under the existing keys in `.env.example`:

```
GOOGLE_SERVICE_ACCOUNT_KEY=
```

- [ ] **Step 4: Verify it type-checks and the server-only guard holds**

Run: `npm run lint`
Expected: no errors for `lib/drive.ts`.

Run: `npx tsc --noEmit` (if available) OR `npm run build` later in Task 7.
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add lib/drive.ts package.json package-lock.json .env.example
git commit -m "feat(drive): server-only Google Drive client + auth"
```

---

### Task 5: CLI — `npm run drive -- pull|--check`

**Files:**
- Create: `scripts/drive.ts`
- Modify: `package.json` (add `"drive"` script)

**Interfaces:**
- Consumes: `readManifest`, `readState`, `writeState`, `DriveState` from `@/lib/driveStore` (use relative `../lib/...` to match sibling scripts); `fetchExport`, `fetchModifiedTime`, `DriveError` from `../lib/drive`; `DriveSource` from `../lib/driveManifest`.
- Produces: a CLI. No exports consumed elsewhere.

- [ ] **Step 1: Add the npm script**

In `package.json` `scripts`, add (after `"slack-sync"`):

```json
    "drive": "node --conditions=react-server --import tsx scripts/drive.ts"
```

- [ ] **Step 2: Write the CLI**

```typescript
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
```

- [ ] **Step 3: Verify the CLI runs against the empty seed manifest**

Run: `npm run drive -- pull`
Expected: prints `drive: manifest has no sources; nothing to do` and exits 0 (the seed manifest has `sources: []`; no Drive call, so no key needed).

Run: `npm run drive -- --check`
Expected: same "nothing to do" message, exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/drive.ts package.json
git commit -m "feat(drive): pull/--check CLI"
```

---

### Task 6: API route — `GET /api/drive`

**Files:**
- Create: `app/api/drive/route.ts`

**Interfaces:**
- Consumes: `readManifest`, `readState` from `@/lib/driveStore`; `fetchModifiedTime`, `DriveError` from `@/lib/drive`.
- Produces: HTTP JSON. Shapes:
  - default → `{ sources: DriveSource[], state: DriveState }`
  - `?check=1` → `{ sources, state, check: { id: string; stale: boolean; modifiedTime: string }[] }`

- [ ] **Step 1: Write the route**

```typescript
// app/api/drive/route.ts
import { NextResponse } from "next/server";
import { readManifest, readState } from "@/lib/driveStore";
import { fetchModifiedTime, DriveError } from "@/lib/drive";

// Reads committed sidecars; ?check=1 hits Drive live. Never statically cache.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/drive
 *   (default)  → { sources, state } from the committed manifest + state (no network)
 *   ?check=1   → adds { check: [{ id, stale, modifiedTime }] } via a live
 *                modifiedTime compare (the only network path; mirrors other
 *                features' refresh). Pulling/writing stays the CLI's job.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  let manifest;
  try {
    manifest = readManifest();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unreadable manifest.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
  const state = readState();

  if (!searchParams.get("check")) {
    return NextResponse.json({ sources: manifest.sources, state });
  }

  try {
    const check = await Promise.all(
      manifest.sources.map(async (s) => {
        const modifiedTime = await fetchModifiedTime(s);
        const known = state[s.id]?.modifiedTime;
        return { id: s.id, stale: !known || modifiedTime > known, modifiedTime };
      }),
    );
    return NextResponse.json({ sources: manifest.sources, state, check });
  } catch (error) {
    if (error instanceof DriveError) {
      const status = error.status ? 502 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify the route serves the seed manifest**

Run: `npm run dev` in one shell, then in another:
`curl -s 'http://localhost:3003/api/drive'`
Expected: `{"sources":[],"state":{}}`.

- [ ] **Step 3: Commit**

```bash
git add app/api/drive/route.ts
git commit -m "feat(drive): GET /api/drive read + check route"
```

---

### Task 7: Web tab — `/drive`

**Files:**
- Create: `app/(dashboard)/drive/page.tsx`
- Modify: `app/(dashboard)/layout.tsx` (add the nav tab)

**Interfaces:**
- Consumes: `GET /api/drive` and `GET /api/drive?check=1`.
- Produces: a client page (no exports).

- [ ] **Step 1: Add the nav tab**

In `app/(dashboard)/layout.tsx`, add to the `TABS` array (after the policy-tracking entry):

```typescript
  { href: "/drive", label: "Drive Sync", enabled: true },
```

- [ ] **Step 2: Write the page**

```tsx
// app/(dashboard)/drive/page.tsx
"use client";

import { useCallback, useEffect, useState } from "react";

interface DriveSource {
  id: string;
  url: string;
  type: "sheet" | "doc";
  dest: string;
  gid?: string;
}
interface DriveStateEntry {
  modifiedTime: string;
  pulledAt: string;
  dest: string;
}
interface CheckRow {
  id: string;
  stale: boolean;
  modifiedTime: string;
}
interface DriveResponse {
  sources: DriveSource[];
  state: Record<string, DriveStateEntry>;
  check?: CheckRow[];
}

export default function DriveSyncPage() {
  const [data, setData] = useState<DriveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async (check: boolean) => {
    setError(null);
    if (check) setChecking(true);
    try {
      const res = await fetch(`/api/drive${check ? "?check=1" : ""}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body as DriveResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const checkById = new Map(data?.check?.map((c) => [c.id, c]) ?? []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Drive Sync</h1>
        <button
          onClick={() => void load(true)}
          disabled={checking}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          {checking ? "Checking…" : "Check for updates"}
        </button>
      </div>

      <p className="text-sm text-slate-500">
        Drive is the source of truth. Snapshots are pulled by the CLI:{" "}
        <code className="rounded bg-slate-100 px-1">npm run drive -- pull</code>. This
        page is read-only.
      </p>

      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {data && data.sources.length === 0 && (
        <p className="text-sm text-slate-500">
          No sources yet. Add entries to <code>reports/drive/manifest.json</code>.
        </p>
      )}

      {data && data.sources.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2 pr-4">Source</th>
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4">Dest</th>
              <th className="py-2 pr-4">Last pulled</th>
              <th className="py-2 pr-4">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((s) => {
              const st = data.state[s.id];
              const chk = checkById.get(s.id);
              return (
                <tr key={s.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium text-slate-900">
                    <a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">
                      {s.id}
                    </a>
                  </td>
                  <td className="py-2 pr-4 text-slate-600">{s.type}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-slate-600">{s.dest}</td>
                  <td className="py-2 pr-4 text-slate-600">{st?.pulledAt ?? "never"}</td>
                  <td className="py-2 pr-4">
                    {chk ? (
                      chk.stale ? (
                        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                          stale
                        </span>
                      ) : (
                        <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                          up to date
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify the build and the page render**

Run: `npm run build`
Expected: build succeeds, `/drive` and `/api/drive` listed in the route output.

Run: `npm run dev`, open `http://localhost:3003/drive`
Expected: "No sources yet." message; "Check for updates" button present and not erroring.

- [ ] **Step 4: Commit**

```bash
git add "app/(dashboard)/drive/page.tsx" "app/(dashboard)/layout.tsx"
git commit -m "feat(drive): /drive web tab"
```

---

### Task 8: Skill + CLAUDE.md docs

**Files:**
- Create: `.claude/skills/field-drive-sync/SKILL.md`
- Modify: `CLAUDE.md` (Commands list + a note in Architecture/artifacts)

**Interfaces:** none (docs only).

- [ ] **Step 1: Write the skill**

```markdown
<!-- .claude/skills/field-drive-sync/SKILL.md -->
---
name: field-drive-sync
description: Use when asked to pull, refresh, or sync documents/spreadsheets from Google Drive into the repo, when a flight-hours sheet or rules doc needs updating from its Drive source, or when answering whether a committed snapshot is stale vs its Drive original.
---

# Field Drive Sync

Google Drive is the source of truth for operational docs (flight-hours sheets,
rules, pilot reports). The repo holds committed snapshots pulled on demand.

## Registry

`reports/drive/manifest.json` maps each Drive link to a local destination:

- `id` — stable slug (used by `--only`, the state key, the web row).
- `url` — full Drive URL (file id parsed from it).
- `type` — `sheet` (→ CSV) or `doc` (→ Markdown).
- `dest` — repo-relative output (e.g. `reports/field-ops/inputs/2026-06.csv`
  to feed `npm run fieldops`, or `docs/drive/rules.md`).
- `gid` — optional spreadsheet tab id (sheets only; defaults to `0`).

Adding a source = one manifest entry, then run a pull. The file must be shared
with the service account email (see `GOOGLE_SERVICE_ACCOUNT_KEY` in `.env`), or
be "anyone with link".

## CLI

- `npm run drive -- pull` — pull every source, write snapshots + `state.json`.
- `npm run drive -- pull --only <id>` — pull one source.
- `npm run drive -- --check [--format json]` — no writes; report fresh/stale
  per source, exit 1 if any is stale (CI-friendly).

## Staleness

`reports/drive/state.json` records each source's last-pulled Drive
`modifiedTime`. A source is stale when the live `modifiedTime` is newer. The
`/drive` web tab shows this via "Check for updates"; the web never pulls.
```

- [ ] **Step 2: Update CLAUDE.md — Commands**

Add this bullet to the Commands list (after the `field-qa` entry):

```markdown
- `npm run drive -- pull [--only <id>]` — pull Google Drive sources declared in `reports/drive/manifest.json` into committed snapshots (Sheets→CSV, Docs→Markdown); `--check` reports fresh/stale without writing (exit 1 if stale). Drive is the source of truth; the repo snapshot is a cache. Requires `GOOGLE_SERVICE_ACCOUNT_KEY` (base64 service-account JSON). (See `.claude/skills/field-drive-sync/`.)
```

- [ ] **Step 3: Update CLAUDE.md — Setup**

Append to the Setup section:

```markdown
For Google Drive sync, set `GOOGLE_SERVICE_ACCOUNT_KEY` (base64 of a service-account JSON key with Drive read access) and share each Drive file (or a folder) with the service-account email.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/field-drive-sync/SKILL.md CLAUDE.md
git commit -m "docs(drive): field-drive-sync skill + CLAUDE.md commands"
```

---

## Self-Review

**1. Spec coverage:**
- Generic manifest-driven puller → Tasks 1,3,5. ✓
- `lib/drive.ts` server-only client + JWT auth + export endpoints → Task 4. ✓
- `lib/driveManifest.ts` / `lib/driveExport.ts` pure + tested → Tasks 1,2. ✓
- `reports/drive/manifest.json` + `state.json` shape + stale detection → Tasks 3,5. ✓
- Sheets→CSV (`reports/field-ops/inputs/*.csv` target), Docs→Markdown (`docs/drive/`) → manifest `dest` + Task 2 MIME. ✓
- CLI `pull` / `--only` / `--check` / `--format` → Task 5. ✓
- `GET /api/drive` read + `?check=1` live compare, no web writes → Task 6. ✓
- `/drive` tab with stale badge, last-pulled, raw link → Task 7. ✓
- Skill + CLAUDE.md → Task 8. ✓
- `.env` `GOOGLE_SERVICE_ACCOUNT_KEY` → Task 4 (.env.example) + Task 8 (Setup). ✓
- Out-of-scope items (write-back, watch, OAuth, HTML migration) correctly omitted. ✓

**2. Placeholder scan:** No TBD/TODO; all code blocks complete; tests have real assertions. ✓

**3. Type consistency:** `DriveSource`/`DriveType`/`DriveManifest` (Task 1) reused verbatim by Tasks 2–7. `DriveState`/`DriveStateEntry` (Task 3) reused by Tasks 5,6. `fetchExport`/`fetchModifiedTime` signatures (Task 4) match calls in Tasks 5,6. `buildExportUrl`/`metadataUrl`/`normalizeExport`/`exportMime` (Task 2) match Task 4 imports. `readManifest`/`readState`/`writeState` (Task 3) match Tasks 5,6. ✓
