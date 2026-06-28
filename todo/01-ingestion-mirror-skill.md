# 01 — Ingestion / mirror meta-skill

**Status:** ✅ DONE — `.claude/skills/authoring-ingestion-sources/SKILL.md`
**Leverage:** highest — pays off on the very next feature (Google Drive sync).

> Built and tested (RED/GREEN with subagents). Baseline agent without the skill
> deviated (pure-args in `lib/`, waffled on storage backend) at 62k tokens; a
> fresh agent *with* the skill hit every convention correctly at 37k tokens. The
> skill abstracts the storage backend (Slack=Postgres, Drive=filesystem) since
> both reference implementations now exist. Note: this is the *authoring*
> meta-skill — distinct from `field-drive-sync`, which operates the Drive feature.

## The gap
`authoring-reporting-features` covers *reporting* (read → compute → artifact →
web). It does NOT cover **mirroring an external source into a local store** —
which is now its own pattern in the repo and is about to be repeated.

## Evidence in the codebase
- `scripts/slack-sync.ts` + `lib/slackMirror.ts` + `lib/slackSyncArgs.ts` —
  `init` / incremental / `--backfill` / `--window N` / `--channel`, writing a
  git-ignored mirror at `data/slack/<channel>/<YYYY-MM>.json` keyed by `ts`
  (incl. thread replies, edits, tombstones). Downstream features read the mirror,
  not live Slack.
- Planned next: `.agents/plans/2026-06-19-google-drive-sync.md` (~1200 lines,
  "pull docs/sheets by link") — the *same* ingest-to-local-mirror shape.
- Spec: `docs/superpowers/specs/2026-06-19-slack-local-mirror-design.md`.

## What the skill should encode
- Sync modes: `init` (backfill from period start), incremental (auto-init on no
  cursor), explicit `--backfill --since`.
- The local-mirror layout convention and why it's git-ignored.
- Cursor/windowing, idempotent upsert keyed by a stable id.
- `server-only` client + `--conditions=react-server` CLI discipline (same as the
  Vimeo/Jira/GitHub clients).
- The `REPLACE_ME` placeholder guard pattern.
- Decision rule: when a source is a *mirror* (this skill) vs a *report*
  (`authoring-reporting-features`).

## Acceptance
- SKILL.md modeled off `slack-sync` so authoring Google Drive sync follows it
  step-by-step.
- Cross-linked from `authoring-reporting-features` ("ingesting a raw source? see
  this skill first").
