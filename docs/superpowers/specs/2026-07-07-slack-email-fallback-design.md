# Slack-profile email fallback for calendar attendees — design

**Date:** 2026-07-07
**Status:** approved (brainstorm 2026-07-07)
**Extends:** `2026-07-07-calendar-meeting-creation-design.md`

## Problem

`calendar_create_event` resolves attendees through the `lib/people.ts` roster and
fails loudly when a resolved person has no `email` — which today is everyone
(zero filled). First real use: «створи дзвінок нам з Богданом …» → blocked on
Bohdan's missing email. The user wants the bot to fall back to the person's
Slack profile email instead of asking.

## Decision

Live fallback at propose time (approach A of the brainstorm). Roster `email`
always wins when present; when it is missing and the person has a `slackId`,
the propose step fetches their Slack profile email via `users.info` and uses
it. Nothing is cached or written back to the roster. All-or-nothing attendee
resolution is unchanged — a person whose email is obtainable nowhere still
blocks the proposal loudly.

## Architecture

Three small layers, mirroring the existing pure/live split (`crewSheet` vs
`crewLive`):

### 1. Pure layer — `lib/attendees.ts` (refactor, behavior-preserving)

New exported per-query resolver:

```ts
export type AttendeeQueryResult =
  | { kind: "resolved"; attendee: ResolvedAttendee }
  | { kind: "needs-email"; name: string; slackId: string } // person found, no roster email, has slackId
  | { kind: "problem"; problem: string };

export function resolveAttendeeQuery(query: string, people?: Person[]): AttendeeQueryResult
```

- Verbatim-email, unknown, ambiguous, and malformed-email cases return the same
  strings as today.
- A resolved person without `email` and **without** `slackId` is a `problem`
  (today's «немає email у реєстрі» text); with a `slackId` it is `needs-email`.
- `resolveAttendees(queries, people?)` keeps its exact signature and behavior
  (a `needs-email` result maps to today's «немає email у реєстрі» problem) —
  it becomes a thin wrapper over `resolveAttendeeQuery`, so the CLI-visible
  pure path and all existing tests stay valid.

### 2. Live layer — `lib/slack.ts` + new `lib/attendeesLive.ts`

- `lib/slack.ts` gains `fetchUserEmail(userId: string): Promise<string | null>`
  — one `users.info` call, returns `user.profile.email ?? null`; returns null
  (never throws) on a non-ok response or missing field, matching the module's
  best-effort helpers.
- `lib/attendeesLive.ts` exports
  `resolveAttendeesLive(queries: string[], people?: Person[]): Promise<AttendeeResolution>`:
  1. Run `resolveAttendeeQuery` per query (pure pass).
  2. For each `needs-email`, `fetchUserEmail(slackId)`:
     - email found → `{ name, email, source: "slack" }`;
     - null → problem: `У «<name>» немає email ні в реєстрі (lib/people.ts), ні в профілі Slack.`
  3. Same all-or-nothing + dedup-by-email semantics as `resolveAttendees`
     (dedup logic shared, not duplicated).
- `ResolvedAttendee` gains optional `source?: "slack"` (pure type, in
  `lib/attendees.ts`).

### 3. Consumers

- `lib/agent/tools/calendar.ts` switches `resolveAttendees` →
  `await resolveAttendeesLive`. That is the only consumer change: the CLI
  (`scripts/calendar-write.ts`) calls `calendarCreateProposal`, so it inherits
  the fallback automatically (it already runs with `SLACK_TOKEN` available in
  `.env`; without a token the fetch helper returns null and the loud error
  names both sources).
- `renderProposalUk` (`lib/calendarEvent.ts`) marks fallback-sourced addresses
  so the human confirms knowing where the email came from:
  `Bohdan Forostianyi (bohdan@orients.ai, зі Slack)`. Roster/verbatim entries
  render exactly as today.
- Proposal `params.attendeeEmails` stays a plain `string[]` — the executor and
  the persisted-params round-trip are untouched.

## Error handling

| Case | Behavior |
| --- | --- |
| Roster email present | used, no Slack call |
| No roster email, slackId, Slack returns email | used, echo marked «зі Slack» |
| No roster email, slackId, Slack returns none (missing scope / hidden / API error) | loud problem naming both sources; proposal blocked |
| No roster email, no slackId | today's «немає email у реєстрі» problem |
| Unknown / ambiguous / malformed | unchanged |

No retries, no caching (one `users.info` per needy attendee per propose —
negligible), no writes to the roster.

## Operator prerequisite (verified missing 2026-07-07)

The bot token currently lacks the **`users:read.email`** OAuth scope —
`users.info` responds ok but without `profile.email`. Add the scope in the
Slack app config and reinstall the app to the workspace. Until then the
fallback degrades to the loud both-sources error (the feature fails visibly,
not silently).

## Testing

- `lib/attendees.test.ts` — existing tests unchanged (wrapper equivalence);
  new cases for `resolveAttendeeQuery`'s `needs-email` vs no-slackId split.
- `lib/attendeesLive.test.ts` — mocked `fetchUserEmail`: fallback success
  (source marked), fallback failure (both-sources problem), mixed roster+slack
  sets, dedup across sources.
- `lib/calendarEvent.test.ts` — echo marks «зі Slack» only for
  `source: "slack"` attendees.
- `lib/agent/tools/calendar.test.ts` — tool test updated to mock
  `lib/attendeesLive` (raw-email cases keep working without Slack).

## Out of scope

Writing fetched emails back to the roster; using Slack emails for anything but
calendar attendees; Google Admin Directory lookup; caching.
