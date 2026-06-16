---
name: authoring-reporting-features
description: Use when adding or extending a reporting feature in this ops console (a new data source like Jira/GitHub/Vimeo, or a new metric/CLI flag/web view). Encodes the house pattern — skill → CLI `--write` → committed JSON+CSV artifact → web renders it — and the server-only / pure-lib / two-interface conventions every feature must follow.
---

# Authoring a reporting feature

This repo's master pattern: **Claude Code is the product.** Every reporting feature is driven from a skill + CLI that produce **committed artifacts**, which the web merely renders. Follow this recipe so a new feature matches the existing three (Vimeo, Jira, GitHub).

## The non-negotiables (from CLAUDE.md)

- **Two interfaces, always:** a web view AND a CLI exposing the same data. Shared logic lives in pure `lib/` modules (no React/Next imports), unit-tested with Vitest.
- **Secrets are server-only:** any module reading a token/env (`lib/<x>.ts`) imports `"server-only"` and reads `process.env`. Never import it from a `"use client"` file; never send a credential to the browser. A client whose token is *injected by the caller* (see `lib/githubClient.ts`) is deliberately NOT server-only so the CLI can reuse it.
- **CLIs run under** `node --conditions=react-server --import tsx scripts/<x>.ts` so the `server-only` default export (which throws in plain Node) resolves to an empty module.

## The artifact pattern

`skill → CLI --write → reports/<feature>/<period>.{json,csv} → web renders committed JSON (hybrid: live Refresh for the current month)`.

- The **JSON** is lossless and is the exact shape `GET /api/<feature>` returns — the web's render source.
- The **CSV** is a flat human/spreadsheet record; it may drop nested data (sprint churn, repo ranking, per-video detail). Document that it's lossy.
- The web **never writes** `reports/`. Committing artifacts is the CLI's job.

## Recipe (mirror the existing feature closest to yours)

1. **Pure aggregation** in `lib/<x>Stats.ts` (or reuse `lib/reconcile.ts`): raw records → the report shape. Unit-test it (`lib/<x>Stats.test.ts`).
2. **Fetcher** in `lib/<x>.ts`: `import "server-only"`, read the token from `process.env`, throw a typed `<X>Error` (map to 502 upstream / 500 config). Network-bound, so untested.
3. **Pure CLI shaping** in `scripts/<x>Report.ts`, mirroring `scripts/jiraReport.ts`: `parseArgs` (incl. `--write`), `resolvePeriod`, `formatTable`, `toCsv` (use the `csvField` RFC-4180 helper for any free-text column). Unit-test it.
4. **CLI** in `scripts/<x>.ts`, mirroring `scripts/jira.ts`: load `.env`, resolve the period, fetch, print JSON/table, and on `--write` call `writeReport("<feature>", period, { json, csv })` from `lib/reports.ts`. Add `"<x>": "node --conditions=react-server --import tsx scripts/<x>.ts"` to `package.json`.
5. **Hybrid API route** `app/api/<x>/route.ts`, mirroring `app/api/jira/route.ts`: `?periods=1` → `listPeriods`; `?period=<key>` → `readReportJson` (404 if absent, 400 if `parsePeriodKey` rejects); `?start=&end=[&refresh]` → live fetch. Keep `runtime="nodejs"` + `dynamic="force-dynamic"`.
6. **Web page** under `app/(dashboard)/<x>/`: use the `lib/usePeriodReport` hook (period picker, render newest committed, Refresh live for the current month). Inject `mapCommitted`/`mapLive` if the committed and live shapes differ (GitHub commits a shaped summary but live returns raw activity). Add the tab to `app/(dashboard)/layout.tsx`.
7. **Feature skill** `.claude/skills/<x>-dev-reporting/SKILL.md`, cloned from `jira-dev-reporting/SKILL.md`.

### Optional: per-entity occupation summaries via subagents

If the feature has per-person text (issue titles, PR titles, commit headlines), reuse the summary plumbing: map the work into the `UserTickets` shape (`{ accountId, displayName, tickets:[{key,summary}] }`) so `buildOccupationPrompt`/`summarizeOccupations` work unchanged. Add `--dump-work`/`--dump-tickets` (emit that JSON and exit), `--summarize` (opus, via `lib/summarize.ts`), and `--summaries-file` (load externally-generated prose). The standing **monthly** workflow generates summaries with **sonnet subagents** (one per month: dump → subagent writes `{accountId: summary}` → feed back via `--summaries-file`), not the opus `--summarize`.

## Skill-authoring conventions

- **`description` is a trigger, not a title.** Write "Use when …" with the concrete questions/phrases that should fire it (see the existing skills' frontmatter). Vague descriptions don't get invoked.
- **Sections:** `Domain (must-know)` → invariants a wrong answer would violate; `When to use` → example questions; `How to use` → exact commands + output shape; `Out of scope` → what NOT to infer (and known gotchas, e.g. GitHub all-zeros = token scope).
- **The CLI is the product; the skill drives the CLI.** Document flags and the artifact paths, not internals.

## Verify (every feature)

- `npm run <x> -- --start … --end … --write` writes both sidecars; re-running a closed period is idempotent.
- `GET /api/<x>?periods=1` lists the new key; `?period=<key>` renders identically to the CLI table; missing → 404 → page offers Refresh.
- `npm test` green; `npm run lint` clean; `npx tsc --noEmit` clean. No `"use client"` file imports `node:fs` or `lib/reports` write paths.
