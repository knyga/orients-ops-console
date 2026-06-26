# Connecting Google Drive (read-only, private files)

One-time setup, ~5 min. The Drive sync feature pulls Drive sheets/docs into
committed repo snapshots (`npm run drive -- pull`); Drive stays the source of
truth, the repo holds a cache. See `.claude/skills/field-drive-sync/SKILL.md`
for the CLI/manifest reference.

Private files require a Google credential — there is no zero-Cloud-Console path
for them. A **service account** is the simplest (no token refresh, no consent
screen) and is the only auth the feature supports. Access is **read-only**
(`drive.readonly` scope + Viewer share); nothing can write back to Drive.

## 1. Enable the Drive API

1. Open https://console.cloud.google.com → pick or create a project (top bar).
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.

## 2. Create a service account

1. **APIs & Services → Credentials → Create credentials → Service account**.
2. Name it (e.g. `ops-console-drive`) → **Create and continue** → skip the
   optional roles → **Done**.
3. Copy its **email** — looks like
   `ops-console-drive@<project>.iam.gserviceaccount.com`. Needed in step 4.

## 3. Make a JSON key

1. Click the service account → **Keys** tab → **Add key → Create new key → JSON**
   → **Create**.
2. A `.json` file downloads. This is the secret credential — do not commit it.

## 4. Share your Drive files with it (read-only)

For each private doc/sheet — or a parent **folder** to cover many at once:

- **Share** → paste the service-account email from step 2.3 → role **Viewer** →
  **Send**.
- Viewer = read-only.

Public "anyone with link" files need no share — they resolve through the same
client (and even with `GOOGLE_SERVICE_ACCOUNT_KEY` unset).

## 5. Put the key in `.env` as base64

The app reads `GOOGLE_SERVICE_ACCOUNT_KEY` = base64 of the whole JSON file:

```bash
base64 -i /path/to/downloaded-key.json | tr -d '\n'
```

Add the output to `.env`:

```
GOOGLE_SERVICE_ACCOUNT_KEY=<paste-the-base64-string>
```

## 6. Register your links in the manifest

Edit `reports/drive/manifest.json` — one entry per file:

```json
{
  "sources": [
    {
      "id": "rules",
      "url": "https://docs.google.com/document/d/<FILE_ID>/edit",
      "type": "doc",
      "dest": "docs/drive/rules.md"
    },
    {
      "id": "flight-hours-2026-06",
      "url": "https://docs.google.com/spreadsheets/d/<FILE_ID>/edit#gid=0",
      "type": "sheet",
      "dest": "reports/field-ops/inputs/2026-06.csv",
      "gid": "0"
    }
  ]
}
```

- `id` — stable slug (used by `--only`, the state key, the web row).
- `url` — full Drive URL; the file id is parsed from it.
- `type` — `doc` → Markdown, `sheet` → CSV.
- `dest` — where the snapshot lands. Point a sheet at
  `reports/field-ops/inputs/<period>.csv` to feed `npm run fieldops`.
- `gid` — sheet tab (sheets only; default `0`). Find it in the URL after `#gid=`.

## 7. Pull

```bash
npm run drive -- pull              # all sources
npm run drive -- pull --only rules # one source
npm run drive -- --check           # report stale vs Drive, no writes (exit 1 if stale)
```

Snapshots write to each `dest`; `reports/drive/state.json` records last-pulled
times. The `/drive` web tab shows status + "Check for updates" (read-only —
pulling stays the CLI's job).

## Verify

Add one source → `npm run drive -- pull` → the `dest` file appears with the doc
contents.

## Gotchas

- If a pull 404s on a private file, the Viewer share in step 4 didn't take —
  re-check the service-account email and the role.
- The base64 must be the full JSON on one line (the `tr -d '\n'` strips
  newlines); a partial paste yields "not valid base64 JSON" on the next run.
