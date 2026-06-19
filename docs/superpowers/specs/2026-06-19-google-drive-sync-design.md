# Google Drive sync — design

**Date:** 2026-06-19
**Status:** Approved (design); pending implementation plan

## Problem

Operational source documents (flight-hours spreadsheets, rules docs, per-pilot
reports, monthly stats) currently live in **both** Google Drive and the repo.
They are copied by hand into the repo (e.g. exported HTML under
`docs/Personal Field Metrics May 2026/`, flight-hours pasted into
`reports/field-ops/inputs/<period>.csv`). Two copies = drift + manual upkeep.

**Goal:** Google Drive is the single source of truth. The repo holds a derived,
committed snapshot pulled on demand (eventual consistency — these docs don't
change daily). Stop maintaining two copies by hand.

## Decisions (from brainstorming)

- **Scope:** both spreadsheets that feed reports *and* reference docs humans/Claude read.
- **Auth:** mixed sharing (private org-only + some public links). Service-account
  auth covers both; public "anyone with link" files resolve through the same client.
- **Timing:** snapshot model — pull on demand, commit the snapshot. Drive is
  canonical; the committed copy is a cache. A refresh = rerun the CLI.
- **Export format:** Google Sheets → CSV, Google Docs → Markdown.
- **Shape:** one generic, manifest-driven `drive` feature (not per-CLI flags), so
  every doc flows through one code path and new docs are one manifest line. A
  manifest entry can target `reports/field-ops/inputs/<period>.csv`, so flight
  hours stop being hand-copied.

## Architecture

Follows the house pattern (skill → CLI → committed artifact → web) and the
`server-only` + `--conditions=react-server` + pure-`lib/` discipline used by
vimeo/jira/github.

```
lib/drive.ts            server-only Google client: JWT auth + files.export fetch.
                        Imports "server-only"; CLI runs via --conditions=react-server.
                        Not unit-tested (network/server-only), mirrors lib/vimeo.ts.
lib/driveManifest.ts    pure: parse + validate manifest, extract Drive file ID from
                        various URL shapes. Tested.
lib/driveExport.ts      pure: Drive export payload → CSV / Markdown shaping, gid
                        handling. Tested.
scripts/drive.ts        CLI: npm run drive:pull [--only <id>] [--check] [--format]
reports/drive/manifest.json   committed registry (link → dest + type). Hand-edited.
reports/drive/state.json      committed: per-entry last-pulled modifiedTime + pulledAt.
app/api/drive/route.ts        GET: list manifest + state (committed, no live fetch);
                              ?check=1 does live modifiedTime compare (only network path).
app/(dashboard)/drive/page.tsx   tab: sources table, last-pulled, stale badge, raw link.
```

Snapshots are written to each source's manifest-declared `dest`:
- Sheets → any CSV path, including `reports/field-ops/inputs/<period>.csv` (feeds `npm run fieldops`).
- Docs → committed Markdown under `docs/drive/<slug>.md`.

**The web never pulls/writes** — pulling Drive stays exclusively the CLI's job,
consistent with "the web never writes `reports/`".

## Manifest — `reports/drive/manifest.json`

```json
{
  "sources": [
    {
      "id": "flight-hours-2026-06",
      "url": "https://docs.google.com/spreadsheets/d/<FILE_ID>/edit#gid=0",
      "type": "sheet",
      "dest": "reports/field-ops/inputs/2026-06.csv",
      "gid": "0"
    },
    {
      "id": "rules",
      "url": "https://docs.google.com/document/d/<FILE_ID>/edit",
      "type": "doc",
      "dest": "docs/drive/rules.md"
    }
  ]
}
```

- `id` — stable slug; used by `--only`, as the `state.json` key, and the web row key.
- `url` — full Drive URL; the file ID is parsed from it (no separate field).
- `type` — `sheet` | `doc`.
- `dest` — repo-relative output path.
- `gid` — optional; spreadsheet tab id (defaults to the first tab / `0`).

Validation (in `lib/driveManifest.ts`): unique `id`s, parseable file ID, known
`type`, non-empty `dest`, `gid` only on `sheet`. Invalid manifest → CLI error
listing offending entries.

## Auth

- `.env`: `GOOGLE_SERVICE_ACCOUNT_KEY` = base64 of the service-account JSON
  (single env var, no key file committed; consistent with the token-in-env
  pattern used for Vimeo/Jira/GitHub/Slack).
- Each Drive file (or a containing folder) is shared with the service-account
  email. Public "anyone with link" files need no extra sharing.
- Library: `google-auth-library` only — sign a JWT, exchange for an access
  token, then `fetch` the `files.export` endpoint. Avoids pulling the full
  `googleapis` package.
- Export MIME types: `sheet` → `text/csv` (per `gid`), `doc` → `text/markdown`.

## CLI — `npm run drive:pull`

Added to `package.json`:
`"drive": "node --conditions=react-server --import tsx scripts/drive.ts"`,
invoked as `npm run drive -- pull [...]` (matches the repo's
`npm run <feature> -- <args>` convention). `pull` is the default subcommand;
`--check` flips to check-only.

- **default (pull all):** read manifest → for each source fetch export → write
  `dest` → update `state.json` (`modifiedTime`, `pulledAt`, `dest`).
- `--only <id>` — pull a single source.
- `--check` — no writes; fetch each file's `modifiedTime`, compare to
  `state.json`, print a fresh/stale table, **exit 1 if any stale** (CI-friendly).
- `--format table|json`.

`pulledAt` is stamped from the system clock at CLI runtime (not inside any pure
lib), so the pure modules stay deterministic/testable.

## State & staleness — `reports/drive/state.json`

```json
{
  "flight-hours-2026-06": {
    "modifiedTime": "2026-06-18T09:12:00Z",
    "pulledAt": "2026-06-19T20:40:00Z",
    "dest": "reports/field-ops/inputs/2026-06.csv"
  }
}
```

Stale = Drive `modifiedTime` (live) > stored `modifiedTime`. This is the
"eventual consistency" signal surfaced by `--check` and the web stale badge.

## Web — `/drive` tab

- Nav entry with `enabled` flag (`app/(dashboard)/layout.tsx`).
- Table: source `id`, `type`, `dest` (link to the committed file), last pulled
  (`pulledAt`), and a **stale badge**.
- `GET /api/drive` reads manifest + state only (committed, no network).
  `?check=1` performs the live `modifiedTime` compare to populate stale badges —
  the single network path, mirroring other features' "refresh".
- No write path from the web.

## Testing (Vitest, pure libs only)

- `lib/driveManifest.test.ts` — manifest parse; file-ID extraction across URL
  shapes (`/spreadsheets/d/<id>/edit#gid=`, `/document/d/<id>/edit`, `?id=`,
  trailing variants); validation errors (dup id, bad type, gid on doc).
- `lib/driveExport.test.ts` — export payload → CSV (gid passthrough) and →
  Markdown shaping.
- `lib/drive.ts` not unit-tested (network/server-only), same as `lib/vimeo.ts`.

## Documentation

- New skill `field-drive-sync` (`.claude/skills/`) — when to pull, how to add a
  source, the manifest shape.
- CLAUDE.md: add the `npm run drive` command entry + a short note in the
  Architecture / artifacts section.

## Out of scope (YAGNI)

- Writing back to Drive from the repo (one-way pull only).
- Watching/auto-pull on Drive changes (manual/CI-triggered `--check` + `pull`).
- OAuth user flow (service account only).
- Migrating the existing `docs/Personal Field Metrics May 2026/` HTML — handled
  later by adding manifest entries pointing at those Drive originals.
