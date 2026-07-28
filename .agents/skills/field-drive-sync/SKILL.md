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
