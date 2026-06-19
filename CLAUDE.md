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

- `npm run dev` — start the Next.js dev server (http://localhost:3003)
- `npm run build` — production build
- `npm run lint` — ESLint (flat config, `eslint-config-next` core-web-vitals + typescript)
- `npm test` — run the Vitest suite once
- `npm run test:watch` — Vitest in watch mode
- `npm run vimeo -- --start YYYY-MM-DD --end YYYY-MM-DD` — print Vimeo video stats (counts, recorded minutes, per-day) as JSON for the window; `--format table` for a human view; `--write` persists committed `reports/vimeo/<period>.{json,csv}`. Defaults to the current Kyiv month. CLI for video-stats questions (see `.claude/skills/vimeo-stats/`).
- `npm run jira -- --start YYYY-MM-DD --end YYYY-MM-DD` — print Jira dev-reporting stats (per-user resolved counts + story points + their issue keys, period totals, sprint churn) as JSON; `--format table` for a human view; `--write` persists committed `reports/jira/<period>.{json,csv}` (lossless JSON is the web render source; CSV is a human record); `--summarize` (implies `--write`, needs `ANTHROPIC_API_KEY`) adds a Claude per-user occupation summary; `--dump-tickets`/`--summaries-file` drive the sonnet-subagent summary flow. Output mirrors `GET /api/jira`. Defaults to the current month. (See `.claude/skills/jira-dev-reporting/`.)
- `npm run github -- --start YYYY-MM-DD --end YYYY-MM-DD` — print GitHub dev-reporting stats (per-contributor commits/additions/deletions/net + PRs opened/merged, repo ranking) as JSON; `--format table`; `--write` persists committed `reports/github/<period>.{json,csv}`; `--summarize`/`--summaries-file`/`--dump-work` drive the same summary flow as Jira. Output mirrors `GET /api/github`. (See `.claude/skills/github-dev-reporting/`.)
- `npm run fieldops -- --start YYYY-MM-DD --end YYYY-MM-DD` — reconcile live Vimeo against committed flight hours (`reports/field-ops/inputs/<period>.csv`, override with `--inputs`); applies the 50% gate and prints the daily rows + summary as JSON; `--format table`; `--write` persists committed `reports/field-ops/<period>.{json,csv}`. Defaults to the current Kyiv month.
- `npm run field-qa -- --start YYYY-MM-DD --end YYYY-MM-DD [--write]` — extract #field-qa flight-hours reports via Claude; `--write` persists `reports/field-ops/inputs/<period>.csv` (the fieldops input) + `reports/field-qa/<period>.{json,csv}`. `--format table` for a human view. Drives the Field QA tab and the `field-qa-flight-hours` skill.
- `npm run slack-sync -- [init|--backfill --since YYYY-MM-DD|--window N|--channel <name>]` — sync the tracked Slack channels into the local mirror `data/slack/<channel>/<YYYY-MM>.json` (git-ignored; messages keyed by `ts` incl. thread replies, edits, tombstones). `init` backfills from the start of the current Kyiv month; bare `slack-sync` is incremental (auto-inits a channel with no cursor). Downstream features read the mirror, not live Slack. (See `docs/superpowers/specs/2026-06-19-slack-local-mirror-design.md`.)
- `npm run field-verdict -- --start YYYY-MM-DD --end YYYY-MM-DD` — per-flight-day bonus-acceptance verdict (ACCEPTED/PENDING/NEEDS_REVIEW/ACCEPTED_EXCEPTION): airborne minutes from the committed field-qa report, video minutes from live Vimeo attributed by the date in the video name, a #datasets notice from the Slack mirror, and human exceptions from `reports/resolutions/store.json`. `--format table`; `--write` persists committed `reports/field-verdict/<period>.{json,csv}`. Defaults to the current Kyiv month. (Run `npm run slack-sync` + `npm run field-qa -- --write` first.)
- `npm run field-publish -- --start YYYY-MM-DD --end YYYY-MM-DD [--channel <name>] [--publish]` — publish per-day verdicts to Slack. **DRY-RUN by default**: prints the exact messages it would post (only SETTLED verdicts — ACCEPTED/NEEDS_REVIEW/ACCEPTED_EXCEPTION, never PENDING) and the target channel, and sends nothing. A real post needs the explicit `--publish` flag, a `--channel <name>` (a tracked channel; use a private test channel before #field-qa), and the bot's `chat:write` scope. Idempotent: already-posted days (`reports/published/<period>.json`) are skipped. The only outward-facing write in the console. (See `docs/superpowers/specs/2026-06-19-field-day-acceptance-and-publishing-design.md` phase C.)
- Run a single test file: `npx vitest run lib/reconcile.test.ts`
- Run tests matching a name: `npx vitest run -t "50%"`

## Architecture

An internal ops console (Next.js 16 App Router, React 19, Tailwind v4, TypeScript strict). Shipped features: **Field Ops video reconciliation**, **Dev Reporting (Jira)**, and **GitHub Activity** — the dashboard nav is data-driven with an `enabled` flag (`app/(dashboard)/layout.tsx`).

### Artifacts & the skill→CLI→committed-artifact→web pattern (read this for any new feature)

**Claude Code is first-class: the skill/CLI is the product.** Each reporting feature's CLI (`npm run <feature>`) computes a period's data and, with `--write`, persists **two committed sidecars** under `reports/<feature>/<period>.{json,csv}`: a **lossless JSON** (the web's render source — the exact shape `GET /api/<feature>` returns) and a **flat CSV** (a human/spreadsheet record; intentionally lossy — no nested data like sprint churn or repo ranking). The shared read/write/list logic is in `lib/reports.ts` (CLI-safe, **not** `server-only`); the pure period-key helpers are in `lib/period.ts` (client-bundle-safe, no `node:fs`). `periodKey` is the canonical key: `YYYY-MM` for a single month, else `YYYY-MM-DD_YYYY-MM-DD`.

The web is **hybrid**: `GET /api/<feature>` serves the committed JSON for `?period=<key>` (404 when absent), lists committed periods for `?periods=1`, and falls back to a **live** fetch for `?refresh=1&start=&end=` (the only network path). **The web never writes `reports/` — committing artifacts is exclusively the CLI's job.** The reporting pages share the `lib/usePeriodReport` hook (period picker → render newest committed → "Refresh live" for the current month). Field Ops is the exception: `/api/field-ops` is committed-only because live reconciliation needs the ephemeral pasted flight hours, which stays a client computation against `/api/vimeo?refresh=1`.

To add a new reporting feature, follow `.claude/skills/authoring-reporting-features/SKILL.md`.

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

The same server-only client also backs a CLI, `scripts/vimeo.ts` (run via `npm run vimeo`). Because `lib/vimeo.ts` imports `server-only` — whose default export throws — the CLI runs Node with `--conditions=react-server` so that import resolves to its empty module. All shaping lives in the pure, tested `scripts/vimeoStats.ts`. The same `server-only` + `--conditions=react-server` discipline applies to `lib/jira.ts`, `lib/github.ts` (token-injected client in `lib/githubClient.ts`, which is deliberately *not* server-only) and `lib/summarize.ts`. Reconciliation now also has a CLI — `npm run fieldops` (`scripts/fieldops.ts`) — combining live Vimeo with committed flight hours.

### UI flow

`app/(dashboard)/field-ops/page.tsx` defaults to rendering the **committed** reconciliation for the selected period (read-only). Its **Live (unsaved)** mode is the original interactive flow: fetch videos via `/api/vimeo?refresh=1`, paste flight hours into `FlightHoursEditor` (CSV parsed by `lib/flightHours.ts`, tolerant of headers/blank lines/`,` or `;`), reconciliation recomputed client-side in a `useMemo` calling `aggregateByDay`/`summarize`. Pasted flight hours are still **ephemeral**; to make a month a committed source of record, the hours are committed to `reports/field-ops/inputs/<period>.csv` and `npm run fieldops -- --write` produces the artifact. The Dev Reporting and GitHub pages follow the shared `usePeriodReport` hybrid pattern (committed by default, live Refresh for the current month).

## Conventions

- Import alias `@/*` maps to the repo root (`tsconfig.json`).
- TypeScript `strict` is on; the pure `lib/` modules are the place for logic that warrants tests.
