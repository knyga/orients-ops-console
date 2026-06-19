# Architecture & roadmap: field-ops compliance agent

Date: 2026-06-19
Status: North-star (decomposes into sub-project specs)

## Vision

An autonomous field-ops bonus-compliance loop, operated through Claude Code, with
Slack as I/O and the filesystem as memory. It ingests Slack + Vimeo, decides
whether each flight day's bonus is accepted, asks humans when it's missing
information, remembers their answers, and (opt-in) publishes verdicts back to
Slack.

## The loop

```
SYNC → DERIVE → VERDICT → ASK → INGEST → REMEMBER → (re-VERDICT) → PUBLISH
```

Two memories:
- **Conversation mirror** — raw Slack messages (incl. thread replies) for key
  channels, on disk. Re-syncable from Slack (the source of truth).
- **Resolutions store** — durable, committed record of decisions/exceptions the
  agent learned (e.g. "2026-06-13 force-majeure, accepted"). Feeds VERDICT.

## Sub-projects

### S1 — Slack local mirror + sync (foundation, read-only)
- `data/slack/<channel>/<YYYY-MM>.json`, messages keyed by `ts` (incl. thread
  replies), so re-sync **upserts** edits and captures new replies.
- Incremental: persist `lastSync` per channel; each run re-fetches a trailing
  window (catch edits) + everything newer; walks threads for messages with
  replies. One-time historical backfill.
- File attachments: store metadata (url, name); download lazily (e.g. stats-bot
  images on demand).
- **Git policy (proposed):** the raw mirror is **git-ignored** (volume + PII +
  re-syncable); derived artifacts and the resolutions store are **committed**
  (low-volume, auditable decisions). Same split as today's `reports/` (committed)
  vs `.env` (local).
- CLI `npm run slack-sync`; everything downstream reads the mirror, not live Slack.

### S2 — Flight time from bot image (phase A)
Spec: `2026-06-19-field-qa-bot-image-flight-time-design.md`. Reads the stats-bot
`Час в повітрі` from the daily summary image (vision). Will read images via the
mirror's file metadata.

### S3 — Acceptance verdict + resolutions store (phase B)
Spec: `2026-06-19-field-day-acceptance-and-publishing-design.md` (phase B).
`verdictForDay`: ACCEPTED if within 3 working days video ≥ 50% airborne AND a
#datasets notice exists; PENDING inside the window; NEEDS_REVIEW after if unmet.
Consults the **resolutions store** so a remembered exception flips NEEDS_REVIEW →
accepted-exception. Pure + unit-tested.

### S4 — Publisher (phase C, outward, hard-gated)
Spec: same doc (phase C). Posts verdicts; `--dry-run` default; `chat:write`;
test channel first; idempotent.

### S5 — Ask-for-missing-info (outward, hard-gated)
For an askable NEEDS_REVIEW gap (no dataset notice; video < 50% — unrecorded
flights?; airborne day with no flight report), post a clear question in the
relevant channel/thread. State machine per `(gapType, date)`:
`OPEN → ASKED(ts) → ANSWERED → RESOLVED|ESCALATED`. Ask **once**; never re-ask
without policy. Same guardrails as S4 (dry-run, test channel, templates, quiet
hours, kill switch).

### S6 — Ingest + remember answers
Read thread replies to the bot's S5 questions (from the mirror). An LLM
classifier interprets the free-text (Ukrainian) reply → structured resolution
`{resolved, type: accepted_exception|data_provided|still_missing|unclear, note,
evidencePermalink}`. Write to the **resolutions store** (S3). Exceptions remain
auditable/reversible; final human (Oleksandr/Bogdan) confirmation per policy.

## Cross-cutting concerns

- **Outward-posting safety (S4–S6):** the only writes into the team's workspace.
  Non-negotiable: dry-run default + explicit `--publish`; a private test channel
  before #field-qa; ask-once idempotency tracked in the resolutions store;
  reviewed templates; quiet-hours; a global disable switch; bot posts only its
  own verdict/question text to channels in `lib/slackChannels`.
- **Scheduling:** the loop is designed for a daily run, but starts **manual**.
  Graduate to scheduled only after dry-runs look right and posting is trusted.
- **Server-only / pure-lib / committed-artifact** conventions unchanged.
- **Idempotency everywhere:** sync upserts; ask/publish dedupe by `(type,date)`.

## Build order

S1 (mirror) → S2 (flight time) → S3 (verdict + resolutions) → then the guarded
outward layer S4/S5/S6 together (shared posting infra). Each ships independently.

## Open decisions (to confirm before the relevant phase)

1. Mirror git policy: raw git-ignored + derived/resolutions committed (proposed).
2. Video↔flight-day attribution under the 3-wd grace (from the B spec).
3. Outward posting: a dedicated test channel first (proposed); `chat:write` add.
4. Build order / what to start now.
