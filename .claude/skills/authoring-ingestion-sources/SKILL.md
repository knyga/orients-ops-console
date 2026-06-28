---
name: authoring-ingestion-sources
description: Use when adding a new external data source that must be mirrored/synced into the repo so downstream features read the local copy instead of the live API (e.g. a new Slack-mirror-like or Drive-sync-like source). Covers the sync CLI + cron + cursor + idempotent re-sync conventions. NOT for read-compute-render reporting features (see authoring-reporting-features) or for operating an existing source.
---

# Authoring ingestion sources

## Overview

An **ingestion source** pulls an external system into a local, re-syncable
**mirror** so downstream features read the mirror, never the live API. This is a
different shape from a *reporting* feature.

- **Reporting** (`authoring-reporting-features`): read → compute a period → write
  `reports/<feature>/<period>.{json,csv}` → web renders the committed JSON. The
  CLI is the answer.
- **Ingestion** (this skill): sync external data → local store keyed by a stable
  id → other features consume it. The CLI/cron is plumbing; it produces no
  per-period report and usually no web render route of its own.

**Decision:** Are you computing a period's answer for a human? → reporting. Are
you copying a source locally so other features can read it offline? → ingestion.

Two reference implementations exist — study the one whose storage fits:
- **Postgres-backed**, time-windowed: Slack mirror (`lib/syncChannels.ts`,
  `lib/slackMirror.ts`, `scripts/slack-sync.ts`, `app/api/cron/sync/route.ts`).
- **Filesystem-backed**, per-item snapshots: Drive sync (`lib/drive.ts`,
  `lib/driveStore.ts`, `lib/driveManifest.ts`, `scripts/drive.ts`).

## The layered file roster

Build these layers in order. Names below show the Slack / Drive precedents.

| Layer | server-only? | Tested? | Precedent |
|---|---|---|---|
| **Committed registry** — the list of things to sync (channels / manifest sources). Hand-edited; adding a source is a small PR. | no | — | `lib/slackChannels.ts` / `reports/drive/manifest.json` |
| **Pure args + math** — `parseArgs`, window/floor/mode helpers. No fs/server/Next imports. Lives in **`scripts/`**, imported by the orchestrator via `../scripts/...`. | no | ✅ | `scripts/slackSyncArgs.ts` |
| **Pure store + merge core** — read/merge/write of the mirror; the cursor read/write. The merge/tombstone/upsert logic is pure (`now` injected, no clock read). NOT server-only (CLI + cron import it; `node:fs`/db keep it out of the browser bundle). | no | ✅ | `lib/slackMirror.ts` / `lib/driveStore.ts` |
| **Live client** — fetches the external API with the token from `process.env`. `import "server-only"`. Retries/paginates. Asserts config (`REPLACE_ME` guard). | **yes** | manual | `lib/slack.ts` / `lib/drive.ts` |
| **Orchestrator** — `syncAll...(opts)` driving the pure core per item; shared by BOTH the CLI and the cron route. server-only (imports the live client). | **yes** | the pure decision core is extracted + tested | `lib/syncChannels.ts` |
| **CLI** — `scripts/<feature>-sync.ts`: `process.loadEnvFile()` in try/catch, `parseArgs`, run orchestrator, log per-item summary to **stderr**, `process.exit(1)` on any failure. | runs under `--conditions=react-server` | manual | `scripts/slack-sync.ts` |
| **Cron route** — `app/api/cron/<feature>/route.ts`: `isAuthorizedCron(req)` (401 else), `runtime="nodejs"`, `dynamic="force-dynamic"`, calls the same orchestrator in incremental mode, returns counts. Schedule in `vercel.json`. | server (route) | manual | `app/api/cron/sync/route.ts` |
| **`package.json` script** — `"<feature>-sync": "node --conditions=react-server --import tsx scripts/<feature>-sync.ts"`. | — | — | the `slack-sync` script |

## The server-only boundary (the token must never reach the browser)

- The **live client** and the **orchestrator** `import "server-only"` — its
  default export throws, so an accidental client import is a build error.
- The CLI is plain Node, which *can't* import `server-only`; the
  `--conditions=react-server` flag resolves that import to its empty module. This
  is why every CLI script in `package.json` carries the flag. Omit it → CLI
  crashes at import.
- The **pure store/args** layers are deliberately **NOT** server-only — they hold
  no secrets and both the CLI and the cron route import them; `node:fs`/db (not
  `server-only`) keeps them out of the browser bundle. Copy the rationale comment
  from `lib/reports.ts` / `lib/driveStore.ts` headers.
- The token is read only as `process.env.*` inside the live client, never
  returned in a payload, never a `NEXT_PUBLIC_*` var. Document it in
  `.env.example` with the same "server-side only" wording as `VIMEO_TOKEN`.

## Sync modes, cursor, idempotency, deletion

Re-sync MUST be idempotent — keyed by a **stable id**, output overwritten in
place, never appended. Two proven shapes:

- **Time-windowed (Slack):** modes `init` (backfill from period start, additive),
  `incremental` (auto-init if no cursor; re-fetch `[lastSync − window, now]`),
  `backfill --since`. Cursor = `lastSync` timestamp per item. Deletion =
  **tombstone**: a message gone from a *re-fetched window* is marked
  `deleted:true` (its absence is real); items outside the window are never
  tombstoned (we didn't ask about them).
- **Version-cursor (Drive):** compare the source's `modifiedTime` to the stored
  one; **skip if unchanged**, re-pull if newer. Cursor = last-pulled version per
  item. Deletion = opt-in **`--prune`** (remove from registry → orphan snapshot
  deleted), never automatic — matches the "leave the human decision" ethos in
  `lib/reconcile.ts`.

**Invariants either way:** each item syncs independently — one failure never
aborts the others; an item's cursor advances **only on its own success**; the
orchestrator computes `today`/`now` **once** for the whole run and passes them
into the pure core (so the core stays deterministic and testable).

## Common mistakes

- **Putting the pure args module in `lib/`** — it goes in `scripts/`
  (`slackSyncArgs.ts`); the orchestrator imports it via `../scripts/...`. Don't
  relocate it to dodge an import.
- **Hardcoding a storage backend** — Postgres vs filesystem `reports/<feature>/`
  is a per-source choice; pick by whether you need queryable/large volume (db) or
  a committed, diffable snapshot (fs). Both are valid here.
- **Adding a `GET /api/<feature>` render route** — ingestion sources usually have
  none; the browser reads downstream features that consume the mirror.
- **Appending instead of upserting** — re-sync must be idempotent by stable id.
- **Skipping the `REPLACE_ME`/config assertion** in the live client — fail loud
  before any network work.
- **Forgetting `--conditions=react-server`** in the `package.json` script.
- **Reading the clock inside the pure core** — inject `now`; keep it pure so it's
  unit-testable.

## Checklist

- [ ] Registry committed; `REPLACE_ME` guard in the live client.
- [ ] Pure args (`scripts/`) + pure store/merge core (`lib/`) — both unit-tested,
      `now` injected, NOT server-only.
- [ ] Live client + orchestrator are `server-only`; orchestrator shared by CLI +
      cron; per-item isolation; cursor advances only on success.
- [ ] CLI under `--conditions=react-server`; exits non-zero on failure.
- [ ] Cron route `isAuthorizedCron`-guarded; scheduled in `vercel.json`.
- [ ] Token documented in `.env.example` as server-side only; no `NEXT_PUBLIC_*`.
- [ ] Re-sync is idempotent (stable id); deletion handled (tombstone or `--prune`).
