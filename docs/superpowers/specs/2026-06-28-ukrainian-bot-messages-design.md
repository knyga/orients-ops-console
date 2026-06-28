# Ukrainian bot messages (team-facing Slack output)

**Date:** 2026-06-28
**Status:** Approved (Approach A)

## Problem

Some members of the field team don't read English. The bot already asks its
questions in Ukrainian (`lib/askGaps.ts`), but three other team-facing surfaces
still post English. They must speak Ukrainian.

## Scope — the only team-facing English strings

| Surface | Function | Posted by |
|---|---|---|
| per-day verdict | `lib/verdictPublish.ts` → `formatDayMessage` | `field-publish` |
| approver override (amendment + ack) | `lib/verdictPublish.ts` → `formatOverride` | `lib/applyApproval.ts` (webhook + `field-approvals`) |
| auto-apply failure notice | `lib/webhookNotice.ts` → `formatWebhookFailureNotice` | `app/api/slack/events/route.ts` |

**Explicitly out of scope (stay English — internal ops audience):**
`fieldDayVerdict.reasons`, the web console, and the report JSON/CSV artifacts.

## Approach A — translate at the presentation layer

The Ukrainian lives only in the three formatters. The domain stays
language-neutral so the web/reports are untouched.

- **Do not** translate the English `day.reasons` strings. For NEEDS_REVIEW,
  rebuild the gap wording in Ukrainian from the structured fields the verdict
  already carries (`ratio`, `videoMinutes`, `airborneMinutes`, `datasetPosted`),
  mirroring the phrasing in `askGaps.ts` for consistency. This needs
  `MIN_RATIO` from `lib/reconcile` (as `askGaps` already imports).
- **Pass human-supplied text through verbatim:** the ACCEPTED_EXCEPTION reason
  (`day.reasons`, which for that status is human resolution text), the approver
  name (`by`) and reason in `formatOverride`, and the raw server error in the
  failure notice. We translate the static wrapper, never someone's words or a
  technical error string.

### Exact strings

`formatDayMessage` (helpers: `pct`, `vid`=video min, `air`=airborne min,
`ds` = `datasetPosted ? "датасет ✓" : "без датасету"`):

- ACCEPTED:
  `✅ {date} — прийнято (відео {vid} хв — це {pct} від {air} хв у повітрі; {ds}).`
- ACCEPTED_EXCEPTION (reasons = human text, passed through):
  `🟡 {date} — прийнято (виняток): {reasons.join("; ")}.`
- NEEDS_REVIEW (UA reasons rebuilt from fields):
  `⚠️ {date} — потрібна перевірка: {uaReasons.join("; ")} (відео {vid} хв / {air} хв у повітрі, {ds}).`
  - low video, `ratio === null`: `немає записаного часу в повітрі за день`
  - low video, otherwise: `відео {vid} хв — лише {pct} від {air} хв у повітрі (< 50%)`
  - no dataset: `немає повідомлення про датасет за цей день`

`formatOverride` (`label` = `accepted_exception ? "прийнято (виняток)" : "відхилено"`):

- `updatedText`: `~{originalText}~\n{icon} Оновлено → {label}, {by}: {reason}`
- `replyText`: `{icon} Зафіксовано: {label}, {by}. Причина: {reason}`

`formatWebhookFailureNotice` (`trimmed` = the verbatim error, ≤240 chars):

- `⚠️ Не вдалося застосувати автоматично — помилка сервера: {trimmed}. Її залоговано для оператора; я не оброблятиму цю відповідь, доки це не виправлять.`

## Consequence

`field-publish` / `field-approvals` dry-run previews print Ukrainian, because
they print the exact message that would be posted. Correct (it's the real text).

## Testing

Each formatter has a `.test.ts`. TDD: update the assertions to the Ukrainian
strings first, watch them fail, then change the formatters. Cover all three
`formatDayMessage` branches (incl. `ratio === null`) and both override decisions.
The functions stay pure (no new imports beyond `MIN_RATIO`).
