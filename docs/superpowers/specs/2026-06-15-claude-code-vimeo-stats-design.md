# Design: Claude-Code-queryable Vimeo stats

Date: 2026-06-15
Status: Approved (pending spec review)

## Goal

Make this repo usable two ways from the same codebase: as the existing Next.js
web console, **and** as a target Claude Code can query directly. The user wants
to ask Claude Code for field-ops stats in chat and have it answer using the
accesses the repo already holds (the Vimeo personal access token).

This first increment is intentionally narrow.

## Scope

**In scope (this increment):**

- Vimeo-only statistics: video counts, total recorded minutes, per-upload-day
  rollups, and ad-hoc slices Claude Code can derive (longest video, busiest day,
  etc.) over a date window.
- A CLI script that fetches and aggregates, reusing the existing pure `lib/`
  logic with zero duplication.
- A native, committed project skill that teaches Claude Code when and how to use
  the script.

**Out of scope (deferred):**

- Reconciliation / the 50% video gate. That needs flight-hours data, which is
  still ephemeral (browser-only paste). Flight-hours sourcing for the CLI is a
  separate future increment. The skill must state this boundary explicitly.
- Any MCP server or changes to the HTTP API.
- Persisting flight hours anywhere server-side.

## Approach

Decisions taken during brainstorming:

- **Data source:** Vimeo only for now (no flight data).
- **Access path:** a CLI script (not the HTTP API, not MCP). No dev server
  required; the token stays server-side.
- **Division of labor:** extractor **+** aggregator — the script does the
  fetch and the deterministic per-day rollup via the unit-tested logic, then
  emits rich JSON that Claude Code can slice further.
- **Runner:** `tsx` added as a devDependency so the script imports `lib/`
  directly with no build step or code duplication.
- **Output:** JSON by default (for Claude Code to parse); `--format table`
  optional for human reading.

## Components

### 1. CLI script — `scripts/vimeo.ts`

- **Purpose:** fetch the account's videos in a date window and produce
  deterministic stats as structured output.
- **Inputs (flags):**
  - `--start YYYY-MM-DD`, `--end YYYY-MM-DD` — inclusive window.
    Default when omitted: the **current calendar month** in `Europe/Kyiv`
    (first day of month → today), so a bare `npm run vimeo` is useful.
  - `--format json` (default) | `table`.
- **Dependencies:**
  - `fetchVideosInPeriod` from `lib/vimeo.ts` (live Vimeo, no-store).
  - `aggregateByDay` and `videoUploadDate` from `lib/reconcile.ts`.
  - `VIMEO_TOKEN` from `.env` (loaded the same way the Next app sees it; the
    script will load `.env` explicitly since it runs outside Next).
  - `tsx` to execute the TypeScript directly.
  - **`server-only` resolution:** `lib/vimeo.ts` starts with `import "server-only"`.
    That package's `default` export (`index.js`) *throws at import time*; only the
    `react-server` export condition resolves to its empty, no-throw module. The
    Next server runs under that condition; a plain `tsx`/`node` invocation does
    not. So the CLI MUST run Node with `--conditions=react-server` (see npm
    script) — that is what keeps the direct `lib/vimeo.ts` import (and therefore
    zero duplication) viable. This is the one non-obvious wiring detail.
- **Behavior:**
  - Validate flags are `YYYY-MM-DD` (reuse the same constraint the lib enforces;
    surface a clear usage error otherwise).
  - Call `fetchVideosInPeriod(start, end)`.
  - Map to `ReconVideo[]` and call `aggregateByDay(videos, [])` — passing **no**
    flight days. With no flight minutes every day's `ratio` is `null` and
    `status` is `FLAG` by the current policy; the script therefore **omits the
    `ratio`/`status` fields** from its day rollup to avoid implying a
    reconciliation verdict that hasn't been computed. It reports only the
    Vimeo-derived facts (`date`, `videoCount`, `recordedMinutes`).
  - Emit JSON:
    ```jsonc
    {
      "period": { "start": "2026-06-01", "end": "2026-06-15", "timezone": "Europe/Kyiv" },
      "totals": { "videoCount": 42, "recordedMinutes": 1873.5 },
      "byDay": [ { "date": "2026-06-01", "videoCount": 3, "recordedMinutes": 128.0 } ],
      "videos": [ { "date": "2026-06-01", "minutes": 42.0, "name": "...", "link": "https://vimeo.com/..." } ]
    }
    ```
  - `--format table`: print a compact human table of `byDay` plus a totals line.
- **Errors:** missing/empty `VIMEO_TOKEN` → clear message + non-zero exit;
  `VimeoError` from upstream → print its message + non-zero exit. Do not leak
  the token value in any output.
- **What it must NOT do:** import React/Next; mutate `lib/`; compute or display a
  reconciliation pass/fail status; persist anything.

### 2. npm script — `package.json`

- Add `"vimeo": "node --conditions=react-server --import tsx scripts/vimeo.ts"`.
  - `--import tsx` registers tsx's loader so the `.ts` file runs directly.
  - `--conditions=react-server` makes `server-only` resolve to its empty module
    (see script dependencies) instead of throwing.
  - Implementation note: confirm this flag combination works in the project's
    Node version during the first build step; if `--import tsx` is unavailable,
    fall back to `tsx --conditions=react-server scripts/vimeo.ts`.
- Usage: `npm run vimeo -- --start 2026-05-01 --end 2026-05-31`.
- Add `tsx` to `devDependencies`.

### 3. Project skill — `.claude/skills/vimeo-stats/SKILL.md`

- **Location rationale:** native Claude Code project skill, committed to the
  repo. Kept separate from `.agents/skills/` (which is vendored/managed by
  `skills-lock.json` and holds third-party skills) so the two don't collide.
- **Contents:**
  - `name`, `description` frontmatter (description written so Claude Code
    recognizes "field-ops / Vimeo / video stats" questions).
  - Domain primer (condensed from `CLAUDE.md` / `lib/reconcile.ts`): videos are
    grouped by **upload date** (`created_time`), day boundaries are
    **Europe/Kyiv**, video is **not** paid per minute.
  - When to use: any question about how many videos / how many recorded minutes /
    per-day uploads over a period.
  - How to use: run `npm run vimeo -- --start … --end …`, parse the JSON, answer
    from `totals` / `byDay` / `videos`.
  - **Explicit boundary:** reconciliation and the 50% flight-bonus gate are NOT
    available here yet (no flight-hours source); do not infer pass/fail.

## Data flow

```
user asks Claude Code  →  skill matches  →  Claude Code runs
  `npm run vimeo -- --start S --end E`
      → scripts/vimeo.ts loads .env, reads VIMEO_TOKEN
      → fetchVideosInPeriod (live Vimeo)        [lib/vimeo.ts]
      → aggregateByDay(videos, [])              [lib/reconcile.ts]
      → JSON to stdout
  →  Claude Code parses JSON  →  answers, slicing further if needed
```

## Testing

- `lib/` stays pure and already unit-tested; this design adds **no logic** to
  `lib/`, so its tests are unchanged.
- `scripts/vimeo.ts` is a thin I/O + formatting shell over tested functions.
  Extract any non-trivial pure helper (e.g. current-month default window,
  table formatting, JSON shaping) into a small testable function and cover it
  with Vitest. The Vimeo fetch itself is not unit-tested (network), consistent
  with the current suite.
- Manual acceptance: `npm run vimeo -- --start 2026-05-01 --end 2026-05-31`
  returns sensible JSON; `--format table` prints a readable table; missing
  token gives a clear error.

## Conventions

- Import alias `@/*` works in the script (tsconfig); use it for `lib/` imports.
- TypeScript `strict` stays on.
- Do not weaken the server-only guarantee: the token is only ever read in
  Node (CLI or Next server), never shipped to a browser bundle.
