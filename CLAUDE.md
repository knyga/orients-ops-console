# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Feature requirements (non-negotiable)

Every feature MUST ship **two** interfaces, not one:

1. A **web-based** representation (the dashboard UI).
2. A **CLI-based** representation that exposes the same data/answers.

The CLI surface is first-class, not an afterthought: we mostly work with Claude Code to get answers, so each feature must be queryable from the command line (e.g. an `npm run` script or a small Node CLI under `scripts/` / `bin/`) without going through the browser. When adding or changing a feature, build/extend both interfaces and keep the shared logic in the pure `lib/` modules so the web page and the CLI consume the same code path.

## Setup

Copy `.env.example` to `.env` and set `VIMEO_TOKEN` (a Vimeo personal access token with read access to the account's videos). Without it, `GET /api/vimeo` returns 500 and no videos load.

## Commands

- `npm run dev` — start the Next.js dev server (http://localhost:3000)
- `npm run build` — production build
- `npm run lint` — ESLint (flat config, `eslint-config-next` core-web-vitals + typescript)
- `npm test` — run the Vitest suite once
- `npm run test:watch` — Vitest in watch mode
- `npm run vimeo -- --start YYYY-MM-DD --end YYYY-MM-DD` — print Vimeo video stats (counts, recorded minutes, per-day) as JSON for the window; `--format table` for a human view. Defaults to the current Kyiv month. This is the CLI Claude Code uses to answer video-stats questions (see `.claude/skills/vimeo-stats/`).
- `npm run jira -- --start YYYY-MM-DD --end YYYY-MM-DD` — print Jira dev-reporting stats (per-user resolved counts + story points, period totals, sprint churn) as JSON for the window; `--format table` for a human view; `--write` persists the per-user table to `reports/jira/<period>.csv` (committed, building a historical record). Output mirrors `GET /api/jira`. Defaults to the current month. This is the CLI Claude Code uses to answer dev-reporting questions (see `.claude/skills/jira-dev-reporting/`).
- Run a single test file: `npx vitest run lib/reconcile.test.ts`
- Run tests matching a name: `npx vitest run -t "50%"`

## Architecture

An internal ops console (Next.js 16 App Router, React 19, Tailwind v4, TypeScript strict). The one shipped feature is **Field Ops video reconciliation**; the dashboard nav is data-driven with an `enabled` flag (`app/(dashboard)/layout.tsx`) so future modules (e.g. Dev Reporting) slot in as disabled tabs.

### The reconciliation domain (read `lib/reconcile.ts` first)

The business policy lives as a doc comment at the top of `lib/reconcile.ts` and drives the whole app. Key invariants:

- Video is **not** paid per-minute. Recording completeness **gates** the daily field bonus: a flight day passes (`OK`) only when recorded Vimeo minutes ≥ **50%** (`MIN_RATIO`) of flight minutes. Comparison is `>=`, so an exact 50% match passes.
- Below 50%, or any video-without-flight / zero-hour day, is `FLAG` — meaning "needs a human decision", **never** an auto-reject (force-majeure/tech-failure exceptions exist).
- Days are grouped by video **upload date** (`created_time`), not flight date, because uploads can lag up to a working day. Day boundaries use `FIELD_TIMEZONE` (`Europe/Kyiv`), not UTC — see `videoUploadDate`.

`lib/reconcile.ts` and `lib/flightHours.ts` are **pure** (no React/Next imports) and unit-tested — keep them that way. `reconcile.ts` exposes `aggregateByDay` (videos + flight days → daily rows) and `summarize` (daily rows → period totals + flagged days).

### Server/client boundary (the Vimeo token must never reach the browser)

- `lib/vimeo.ts` imports `server-only` and reads `process.env.VIMEO_TOKEN`. The `server-only` import makes an accidental client import a build error — do not remove it, and do not import this module from a `"use client"` file.
- The browser calls `app/api/vimeo/route.ts` (`GET /api/vimeo?start=&end=`), never Vimeo directly. The route validates `YYYY-MM-DD` bounds and maps `VimeoError` → 502 (upstream) or 500 (missing config/token).
- `fetchVideosInPeriod` relies on Vimeo's `sort=date&direction=desc` to stop paging early once a page predates `start`, so it never scans full account history. All Vimeo fetches use `cache: "no-store"` — reconciliation must reflect live truth.

The same server-only client also backs a CLI, `scripts/vimeo.ts` (run via `npm run vimeo`). Because `lib/vimeo.ts` imports `server-only` — whose default export throws — the CLI runs Node with `--conditions=react-server` so that import resolves to its empty module. All shaping lives in the pure, tested `scripts/vimeoStats.ts`; the CLI does not compute reconciliation (no flight-hours source yet).

### UI flow

`app/(dashboard)/field-ops/page.tsx` is the only stateful client page. It fetches videos via the API route into React state, the user enters/pastes flight hours into `FlightHoursEditor` (CSV paste parsed by `lib/flightHours.ts`, tolerant of headers/blank lines/`,` or `;`), and reconciliation is recomputed client-side in a `useMemo` calling `aggregateByDay`/`summarize`. Flight hours are **ephemeral** (in-memory only; nothing is persisted server-side).

## Conventions

- Import alias `@/*` maps to the repo root (`tsconfig.json`).
- TypeScript `strict` is on; the pure `lib/` modules are the place for logic that warrants tests.
