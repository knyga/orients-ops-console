# Weekly investor report — design

**Date:** 2026-07-31
**Status:** approved design, pre-implementation

## Problem

Angel investors (semi-technical: strong on battlefield use-cases, weak on tech nuance) need a weekly progress report in Ukrainian. The team wants it drafted automatically every **Tuesday 09:00 Kyiv** in **#general**. The post is an **internal draft**: the team reads/edits it there before forwarding to investors — so it auto-posts with no confirm gate.

Format: a short narrative **summary paragraph first**, then deterministic **bullet sections** with the week's numbers.

## Decisions (from brainstorm)

- **Window:** the previous **Mon–Sun Kyiv calendar week** (aligns with the sprint cycle: commit Monday, report Sunday — sprint numbers are final by Tuesday).
- **Publishing:** fully automatic post to #general (internal draft; humans edit before investors see it).
- **Summary:** one Claude call turns the gathered numbers into a 3–5 sentence Ukrainian investor-toned summary (battlefield-value framing, no tech jargon, **never invents figures** — all numbers passed in the prompt). On Claude failure, fall back to a deterministic one-paragraph template and **still post**.
- **Content blocks:** Jira delivery (+ sprint completion %), field ops core (виїзди, time in field, time in air, accepted/flagged days), video/datasets. Drone losses deliberately excluded.

## Approach

Clone the proven sprint-report pattern (`lib/runSprint.ts`): shared orchestration module used by both a CLI and a Vercel cron, report stored in the DB `reports` table, Slack send deduped at the `lib/slack.ts` chokepoint, and a web tab reading the stored JSON. Two interfaces (CLI + web) per the house rule.

### Components

| Piece | Path | Role |
|---|---|---|
| Pure logic | `lib/investorReport.ts` | Week-window math, day-row slicing, bullet/message rendering, fallback summary. No I/O; unit-tested. |
| Orchestration | `lib/runInvestor.ts` | Gather → summarize → store → post. DRY-RUN aware (`publish: false` returns the exact message, posts nothing). Mirrors `runSprint.ts`. |
| Store | `lib/investorStore.ts` | Thin wrapper on the shared `reports` table, feature `investor`, period = canonical `periodKey` `YYYY-MM-DD_YYYY-MM-DD` (Mon_Sun). Mirrors `sprintStore.ts`. |
| CLI | `scripts/investor.ts` → `npm run investor -- [--publish --channel general] [--today YYYY-MM-DD] [--format table]` | **DRY-RUN by default** (prints the exact Ukrainian post, sends nothing); `--publish` requires `--channel <name>` (a tracked channel). `--today` overrides "now" for testing/backfill. |
| Cron | `app/api/cron/investor-report/route.ts`, `vercel.json` `0 6 * * 2` | ≈ 09:00 Kyiv summer / 08:00 winter — same fixed-UTC compromise as every other cron. `CRON_SECRET` auth. |
| Web | `GET /api/investor` (`?periods=1` list, `?period=<key>` fetch) + **Investor** tab `app/(dashboard)/investor/page.tsx` | Renders the stored JSON: summary, bullets, raw numbers. Committed-only (no live refresh — the cron/CLI is the writer). |

### Data gathering (all sources read-only)

1. **Window:** `computeWeekWindow(today)` → previous Mon–Sun in `Europe/Kyiv` + the canonical period key. Handles month-boundary and DST weeks; pure and tested.
2. **Jira delivery:** `fetchResolvedIssues(start, end)` + `aggregateByUser` → issues resolved, story points total (+ up to ~5 notable issue summaries fed to the Claude prompt for flavor, not printed as bullets).
3. **Sprint completion:** newest stored sprint record (`listSprintSlugs`/`readSprint`) whose `completed.computedAt` falls in/at the window's end → completion rate. Absent → omit the line (no hard fail).
4. **Field ops:** read the DB-backed `field-qa` and `field-verdict` monthly reports covering the window (two months when the week straddles a boundary) and slice to window days → виїзди (report count), time in field (deploy hours), time in air (airborne minutes), accepted vs flagged (NEEDS_REVIEW/PENDING) reports. Dataset-notice days come from the verdict rows' dataset axis (no mirror re-scan).
5. **Video:** live Vimeo `fetchVideosInPeriod(start, end)` → video count + recorded minutes.
6. **Summary:** one Claude call (same `ANTHROPIC_API_KEY` client family as the other classify/summarize calls) with every number + issue titles in the prompt; output constrained to 3–5 Ukrainian sentences. Soft-fail → deterministic fallback paragraph.

### Message shape (Ukrainian, #general)

```
📊 Тижневий звіт для інвесторів — 20–26 липня 2026

<3–5 речень підсумку від Claude: що зробили, яка цінність, що далі>

🛠 Розробка
• Закрито N задач (M стор-поїнтів)
• Виконання спринту: X% (done / committed)

🚁 Польові роботи
• Виїздів: N (прийнято A, на розгляді B)
• Час у полі: H год, час у повітрі: H год

🎥 Дані
• Відео: N роликів, M хв записано
• Датасети: передано за D днів
```

Exact wording final at implementation; structure (summary first, three bullet blocks) is the contract.

### Idempotency & error handling

- **Slack dedup:** outbound key `investor:<periodKey>` at the `lib/slack.ts` reserve-then-send chokepoint — a cron re-fire posts once.
- **Store:** upsert by (feature, period) — re-runs overwrite the same row.
- **Hard fail** (Jira/field/Vimeo fetch throws): skip the post, DM the operator (reuse the nightly's operator-DM helper). Never post on partial data.
- **Soft fail** (Claude summary): fallback template, still post — the draft is human-edited anyway.

### Testing

Unit tests on the pure `lib/investorReport.ts`: window math (mid-month, month-boundary, DST-transition weeks), day-row slicing across two monthly reports, bullet rendering (missing sprint line, zero-flight week), fallback summary. Orchestration fetchers mocked as in `runSprint` tests.

### Env

`JIRA_*`, `VIMEO_TOKEN`, `ANTHROPIC_API_KEY`, `POSTGRES_URL`, `SLACK_TOKEN` (+ `chat:write`), `CRON_SECRET`.

## Out of scope

- Drone-loss block (excluded by decision).
- Confirm-first gate / approver flow (it's an internal draft).
- English version, PDF/email delivery, per-investor customization.
- Editing the posted draft via the bot (humans edit/forward manually).
