# Skills to develop

Improvement points for building features more efficiently in this repo. Each
file is one skill worth authoring, with rationale, evidence in the codebase, and
scope. Ordered by leverage (build top first).

The repo's superpower is the **skill → CLI `--write` → committed artifact → web**
pattern, already captured by `.claude/skills/authoring-reporting-features/`. The
gaps below are *new patterns* the codebase has grown that no meta-skill covers
yet, so each one is currently reinvented by hand.

| # | Skill | Status | Why now |
|---|-------|--------|---------|
| 01 | [Ingestion / mirror meta-skill](01-ingestion-mirror-skill.md) | ✅ done — `authoring-ingestion-sources` | `slack-sync` + Drive sync shipped; skill abstracts both backends, RED/GREEN tested |
| 02 | [Verdict + resolutions pipeline skill](02-field-verdict-pipeline-skill.md) | not started | `field-verdict`→`publish`→`ask`→`remember` (S3–S6) shipped with no skill to extend it |
| 03 | [Safe outward-publishing skill](03-outward-publishing-skill.md) | not started | First outward-facing writes exist (`field-publish`/`field-ask`); dry-run-default pattern needs guardrails encoded |
| 04 | [Field-bonus: ask for unknown initials](04-field-bonus-unknown-initial-ask.md) | ⏸ deferred (feature, not a skill) | Field-bonus shipped without its in-thread ask flow (Task 9); needs a self-contained `bonus_asks` store, not the verdict `asks` store |

## Explicitly NOT worth a skill
- A spec→plan workflow — already covered by superpowers (`brainstorming`,
  `writing-plans`, `executing-plans`), which the plans in `.agents/plans/` invoke.
- More thin per-source wrapper skills (another vimeo/jira-shaped wrapper) — cheap
  to write, low leverage. Invest in the meta-patterns above instead.
