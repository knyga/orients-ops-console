# Calendar meeting creation (Google Workspace) — design

**Date:** 2026-07-07
**Status:** approved (brainstorm 2026-07-07)

## Problem

The Slack conversational agent can read Jira/loss data and write Jira tickets, but
cannot schedule meetings. The team wants «постав зустріч з Тарасом і Владом завтра
о 15:00»-style requests to produce a real Google Calendar event with attendee
invites and a Meet link, on every agent surface (Slack DM / @mention / thread,
web Assistant tab, `npm run agent`), plus a deterministic CLI.

## Decisions (from brainstorm)

- **Real invites**: the event lands in each attendee's own calendar with a Meet
  link, and attendees get email/Calendar notifications. This requires
  domain-wide delegation (a plain service account cannot invite attendees).
- **Fixed organizer**: the bot always impersonates one configured Workspace
  account (`GOOGLE_CALENDAR_ORGANIZER`), not the requester. All events are
  organized by (and editable from) that account.
- **Roster attendee resolution**: names resolve through the hardcoded
  `lib/people.ts` registry (new optional `email` field). Raw email addresses are
  also accepted. Unknown/ambiguous names fail the proposal loudly with
  candidates listed — never guessed.
- **Create-only v1**: no reschedule/cancel/list, no free-busy. Edits happen in
  Google Calendar by hand.
- **Auth approach A**: reuse the existing `GOOGLE_SERVICE_ACCOUNT_KEY` service
  account; a Workspace admin grants it domain-wide delegation with the single
  scope `https://www.googleapis.com/auth/calendar.events`.

## Architecture

Follows the house Phase-A/Phase-B pattern (`jira-write` → `jira_create`): a
server-only Google client + pure shaping libs, one deterministic CLI, one
confirm-first agent write tool. No new report artifact (this is an action
feature, not a reporting feature); the web surface is the existing Assistant tab.

### 1. `lib/googleCalendar.ts` (server-only Google client)

Mirrors `lib/drive.ts`:

- `import "server-only"`; reads `GOOGLE_SERVICE_ACCOUNT_KEY` (base64
  service-account JSON) and `GOOGLE_CALENDAR_ORGANIZER` (the Workspace email to
  impersonate).
- Builds a cached `JWT` from `google-auth-library` with
  `scopes: ["https://www.googleapis.com/auth/calendar.events"]` and
  `subject: GOOGLE_CALENDAR_ORGANIZER` (this is what makes DWD impersonation
  happen — without `subject` the SA acts as itself and attendee invites 403).
- One export:

```ts
createCalendarEvent(input: CalendarEventInput): Promise<CreatedEvent>
// CalendarEventInput: { title, description?, startIso, endIso, attendeeEmails }
// CreatedEvent: { eventId, htmlLink, meetLink? }
```

- `POST https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`
  on the impersonated user's primary calendar, with a
  `conferenceData.createRequest` (`requestId` = a UUID derived from the
  proposal, `conferenceSolutionKey: {type: "hangoutsMeet"}`) so every event gets
  a Meet link. `sendUpdates=all` sends real invites — acceptable because the
  call happens only at apply time, after human confirmation.
- Errors: missing env → a config `Error` naming the variable; Google 403 →
  an error whose message names the likely cause (DWD grant not completed for
  scope `calendar.events`) so the Slack thread / CLI shows an actionable line,
  not a silent failure. Non-OK responses include the Google error summary.

### 2. Pure event shaping — `lib/calendarEvent.ts`

Pure (no server-only / node imports), unit-tested:

- `buildEventBody(input)` — the exact Calendar API request body (start/end as
  `{dateTime, timeZone: "Europe/Kyiv"}`, attendees array, conference request).
- `validateEventTimes(startIso, endIso)` — both parse as ISO 8601 with an
  explicit offset or are interpreted as Europe/Kyiv wall time; end > start;
  reject past-dated starts (> 5 min ago) so a model slip like «2025-…» is
  caught in the proposal, not the calendar.
- Ukrainian renderers: `renderProposalUk(resolved)` (title, absolute Kyiv
  date/time + duration, resolved attendee names+emails, «з посиланням на Google
  Meet», organizer) and `renderAppliedUk(created)` (confirmation with the Meet
  link + event link).

### 3. Attendee resolution — `lib/people.ts` + `lib/attendees.ts`

- `Person` gains an optional `email?: string` (Workspace address). Filled by a
  human, like every other field in the registry — never scraped.
- New pure helper `resolveAttendees(queries: string[])`:
  - a query containing `@` and matching a simple email shape → taken verbatim;
  - otherwise resolved via the existing `personByQuery` rules (canonical name,
    aliases, substring first-name); a resolved person **without** an `email` is
    an error naming the person («немає email у реєстрі»);
  - unknown/ambiguous → error listing candidates (same UX as `npm run who`).
  - Returns either `{ok: true, attendees: {name, email}[]}` or
    `{ok: false, problems: string[]}` — the proposal fails as a whole if any
    attendee fails (no partial invites).

### 4. Agent write tool — `lib/agent/tools/calendar.ts`

`calendar_create_event`, `kind: "write"`, exported as `calendarTools: Tool[]`
and registered in `lib/agent/loop.ts` alongside `jiraTools`/`fieldLoss`.

- `input_schema`: `{ title: string, startIso: string, endIso: string,
  attendees: string[], description?: string }`. The tool description instructs
  the model to convert relative phrases («завтра о 15:00») into concrete
  Europe/Kyiv ISO datetimes and to default duration to 30 minutes when the user
  gave none — the proposal echo shows the resolved absolute time, so the human
  confirms the interpretation.
- `propose(args, ctx)`:
  1. `validateEventTimes` + `resolveAttendees`; any failure → the propose
     throws/returns the problem text so the model can ask the user to clarify
     (same contract as `jira_create`'s unknown-person path — but unlike Jira,
     an unresolved attendee blocks the proposal: a meeting without the right
     people is useless).
  2. Returns a `Proposal` `{kind: "calendar_create_event", params: <resolved,
     serializable input incl. attendee emails>, echoUk: renderProposalUk(...),
     apply: () => createCalendarEvent(...).then(renderAppliedUk)}`.
  3. A thread-born request appends `ctx.sourceUrl` (the Slack permalink) to the
     event description deterministically, mirroring `jira_create`.
- Because it is a standard write tool, every existing surface works unchanged:
  Slack confirm-first («так»/👍, requester-gated), web Assistant, CLI `--yes` —
  all through the shared `lib/proposalExecutor.applyProposal`.
- `lib/proposalExecutor.ts` gains a `calendar_create_event` case (the Slack
  surface persists only `kind + params` across the confirm round-trip, so the
  executor — not the in-memory `apply` closure — must know how to perform the
  write from the serialized params): rebuild the event body from `params` and
  call `createCalendarEvent`, returning `renderAppliedUk`. `ProposalKind`
  widens accordingly.

### 5. Deterministic CLI — `npm run calendar-write`

`scripts/calendar-write.ts` (run with `--conditions=react-server`, like
`jira-write`):

```
npm run calendar-write -- create --title "<text>" --start "2026-07-08T15:00" \
  [--end ... | --duration 30] --attendees "Тарас,Влад,ext@example.com" \
  [--desc "<text>"] [--yes]
```

- **DRY-RUN by default**: prints the resolved plan (organizer, absolute Kyiv
  times, resolved attendee emails, Meet: yes) and touches nothing. `--yes`
  creates the event and prints the event + Meet links.
- No LLM. Reuses `resolveAttendees` / `buildEventBody` / `createCalendarEvent`
  — the same code path as the agent tool's `apply`.

### 6. Operator prerequisites (one-time)

1. Pick/create the organizer account (e.g. a dedicated bot@ user) and set
   `GOOGLE_CALENDAR_ORGANIZER` in Vercel + `.env` (+ `.env.example` entry).
2. Google Admin console → Security → Access and data control → API controls →
   Domain-wide delegation → add the service account's **client ID** with the
   single scope `https://www.googleapis.com/auth/calendar.events`.
3. Fill `email` for the people expected to receive invites in `lib/people.ts`.

Until (2) is done, proposals still render; apply fails with the actionable 403
message.

## Error handling summary

| Failure | Where caught | Behavior |
| --- | --- | --- |
| Unknown/ambiguous/email-less attendee | propose | proposal blocked; model told the problem, asks user |
| Bad/past/inverted times | propose | proposal blocked, reason named |
| Missing env | apply (or CLI startup) | config error naming the variable |
| DWD not granted (403) | apply | actionable Ukrainian line naming the admin step |
| Other Google non-OK | apply | error with Google's summary; surfaced in thread/CLI |

Nothing reaches Google before confirmation; invites go out exactly once, at
apply. Redelivery safety comes from the existing proposal executor (pending
proposals are keyed per conversation and consumed on apply).

## Testing

- `lib/calendarEvent.test.ts` — body building (Kyiv timezone, conference
  request), time validation (offsets, past dates, end≤start), Ukrainian
  renderers.
- `lib/attendees.test.ts` — verbatim emails, alias resolution, email-less
  person error, ambiguous listing.
- `lib/agent/tools/calendar.test.ts` — propose happy path (params serializable,
  echo content), each blocked-proposal path, sourceUrl appended.
- `lib/googleCalendar.test.ts` — server-only alias + mocked fetch: request URL
  (`conferenceDataVersion`, `sendUpdates`), JWT `subject` set, 403 mapping.

## Out of scope (v1)

Reschedule/cancel/list tools, free-busy availability, per-requester organizer
impersonation, recurring events, non-Meet conferencing, a dedicated web tab.
