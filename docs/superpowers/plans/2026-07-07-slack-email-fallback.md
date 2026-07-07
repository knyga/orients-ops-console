# Slack-Profile Email Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a calendar attendee resolves to a roster person without an `email`, fall back to their Slack profile email at propose time instead of blocking.

**Architecture:** Split `lib/attendees.ts` into a per-query pure resolver (`resolveAttendeeQuery`) + a shared collector (`collectAttendees`), keeping `resolveAttendees` behavior-identical. A new `lib/attendeesLive.ts` awaits `fetchUserEmail` (new helper in server-only `lib/slack.ts`) for `needs-email` results. The agent tool switches to the live resolver; the CLI inherits it via `calendarCreateProposal`; the proposal echo marks Slack-sourced emails.

**Tech Stack:** TypeScript strict, Vitest (server-only aliased to empty in vitest.config.ts), Slack Web API `users.info`.

**Spec:** `docs/superpowers/specs/2026-07-07-slack-email-fallback-design.md`

## Global Constraints

- `resolveAttendees` keeps its exact signature and today's behavior — all its existing tests must pass unchanged.
- All-or-nothing resolution stays: any unresolved query fails the whole set; problem strings Ukrainian.
- `fetchUserEmail` NEVER throws — null on missing scope/hidden email/API error; the caller produces the loud both-sources error.
- Fallback problem text exactly: `У «<name>» немає email ні в реєстрі (lib/people.ts), ні в профілі Slack.`
- Echo marks fallback addresses exactly: `Name (email, зі Slack)`; roster/verbatim entries render as today.
- `params.attendeeEmails` stays `string[]` — executor and persisted params untouched.
- Nothing cached, nothing written back to the roster.
- Shared checkout: stage ONLY your own files via explicit `git add <path>`, never `git add -A`.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Pure per-query resolver split (`lib/attendees.ts`)

**Files:**
- Modify: `lib/attendees.ts`
- Test: `lib/attendees.test.ts` (append new describe; existing tests unchanged)

**Interfaces:**
- Consumes: `personByQuery`, `PEOPLE`, `Person` (existing).
- Produces (Task 2 relies on these exact names):
  - `ResolvedAttendee` gains optional `source?: "slack"`.
  - `type AttendeeQueryResult = { kind: "resolved"; attendee: ResolvedAttendee } | { kind: "needs-email"; name: string; slackId: string } | { kind: "problem"; problem: string }`
  - `resolveAttendeeQuery(query: string, people?: Person[]): AttendeeQueryResult` (expects a non-empty, pre-trimmed query)
  - `collectAttendees(results: AttendeeQueryResult[]): AttendeeResolution` (dedup + all-or-nothing; maps a leftover `needs-email` to today's «немає email у реєстрі» problem)

- [ ] **Step 1: Append the failing tests**

Append to `lib/attendees.test.ts` (inside the file, after the existing describe block — reuse the existing `FIXTURE` const; note `Vlad Bondar` has no email and no slackId, so add one fixture person WITH slackId and no email):

```ts
const WITH_SLACK: Person[] = [
  ...FIXTURE,
  { name: "Bohdan F", role: "eng", slackId: "U0BOHDAN", aliases: ["Богдан"] }, // no email, has slackId
];

describe("resolveAttendeeQuery", () => {
  it("resolves a roster person with an email", () => {
    expect(resolveAttendeeQuery("Тарас", WITH_SLACK)).toEqual({
      kind: "resolved",
      attendee: { name: "Taras Panasiuk", email: "taras@getshaman.com" },
    });
  });

  it("returns needs-email for a person with a slackId and no email", () => {
    expect(resolveAttendeeQuery("Богдан", WITH_SLACK)).toEqual({
      kind: "needs-email",
      name: "Bohdan F",
      slackId: "U0BOHDAN",
    });
  });

  it("is a problem for a person with neither email nor slackId", () => {
    const r = resolveAttendeeQuery("Влад", WITH_SLACK);
    expect(r.kind).toBe("problem");
    if (r.kind === "problem") expect(r.problem).toMatch(/Vlad Bondar.*email/);
  });

  it("passes raw emails and rejects malformed ones", () => {
    expect(resolveAttendeeQuery("x@y.com", WITH_SLACK)).toEqual({
      kind: "resolved",
      attendee: { name: "x@y.com", email: "x@y.com" },
    });
    expect(resolveAttendeeQuery("not@an", WITH_SLACK).kind).toBe("problem");
  });
});

describe("collectAttendees", () => {
  it("maps a leftover needs-email to the roster problem (pure-path parity)", () => {
    const r = collectAttendees([{ kind: "needs-email", name: "Bohdan F", slackId: "U0BOHDAN" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/Bohdan F.*email у реєстрі/);
  });

  it("dedupes resolved attendees by email case-insensitively", () => {
    const r = collectAttendees([
      { kind: "resolved", attendee: { name: "A", email: "a@x.com" } },
      { kind: "resolved", attendee: { name: "a@X.com", email: "a@X.com" } },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attendees).toHaveLength(1);
  });
});
```

Also add `resolveAttendeeQuery, collectAttendees` to the test file's import from `./attendees`.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run lib/attendees.test.ts`
Expected: new tests FAIL (`resolveAttendeeQuery is not a function` / not exported); the 9 existing tests still pass.

- [ ] **Step 3: Refactor the implementation**

Replace the body of `lib/attendees.ts` below the imports with (keep the file's top doc comment, and extend it with one line: `The live Slack-fallback sibling is lib/attendeesLive.ts.`):

```ts
export interface ResolvedAttendee {
  name: string;
  email: string;
  /** Set when the email came from the person's Slack profile, not the roster —
   *  surfaced in the proposal echo so the human confirms knowing the source. */
  source?: "slack";
}

export type AttendeeResolution =
  | { ok: true; attendees: ResolvedAttendee[] }
  | { ok: false; problems: string[] };

/** One query's outcome. needs-email = roster person found with a slackId but no
 *  email — the live resolver (lib/attendeesLive.ts) can still rescue it; the
 *  pure path treats it as the roster problem. */
export type AttendeeQueryResult =
  | { kind: "resolved"; attendee: ResolvedAttendee }
  | { kind: "needs-email"; name: string; slackId: string }
  | { kind: "problem"; problem: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function noEmailProblem(name: string): string {
  return `У «${name}» немає email у реєстрі (lib/people.ts) — додай поле email.`;
}

/** Resolve ONE non-empty, pre-trimmed query. */
export function resolveAttendeeQuery(query: string, people: Person[] = PEOPLE): AttendeeQueryResult {
  if (query.includes("@")) {
    if (EMAIL_RE.test(query)) return { kind: "resolved", attendee: { name: query, email: query } };
    return { kind: "problem", problem: `«${query}» не схоже на email.` };
  }
  const r = personByQuery(query, people);
  if ("unknown" in r) return { kind: "problem", problem: `«${query}» не знайдено в реєстрі (lib/people.ts).` };
  if ("ambiguous" in r) {
    return {
      kind: "problem",
      problem: `«${query}» неоднозначно: ${r.ambiguous.map((p) => p.name).join(", ")}. Уточни, кого саме.`,
    };
  }
  if (r.person.email) return { kind: "resolved", attendee: { name: r.person.name, email: r.person.email } };
  if (r.person.slackId) return { kind: "needs-email", name: r.person.name, slackId: r.person.slackId };
  return { kind: "problem", problem: noEmailProblem(r.person.name) };
}

/** All-or-nothing collection + case-insensitive email dedup. A needs-email that
 *  reaches this point unrescued becomes the roster problem. */
export function collectAttendees(results: AttendeeQueryResult[]): AttendeeResolution {
  const attendees: ResolvedAttendee[] = [];
  const problems: string[] = [];
  for (const r of results) {
    if (r.kind === "resolved") attendees.push(r.attendee);
    else if (r.kind === "problem") problems.push(r.problem);
    else problems.push(noEmailProblem(r.name));
  }
  if (problems.length) return { ok: false, problems };
  const seen = new Set<string>();
  const unique = attendees.filter((a) => {
    const k = a.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!unique.length) return { ok: false, problems: ["Не вказано жодного учасника."] };
  return { ok: true, attendees: unique };
}

export function resolveAttendees(queries: string[], people: Person[] = PEOPLE): AttendeeResolution {
  const results = queries
    .map((s) => s.trim())
    .filter(Boolean)
    .map((q) => resolveAttendeeQuery(q, people));
  return collectAttendees(results);
}
```

The import line stays `import { personByQuery, PEOPLE, type Person } from "./people";`.

- [ ] **Step 4: Run to verify everything passes**

Run: `npx vitest run lib/attendees.test.ts`
Expected: PASS — all 9 pre-existing tests (wrapper equivalence) + the new describes.

- [ ] **Step 5: Commit**

```bash
git add lib/attendees.ts lib/attendees.test.ts
git commit -m "refactor(calendar): per-query attendee resolver + needs-email state

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `fetchUserEmail` + live resolver (`lib/attendeesLive.ts`)

**Files:**
- Modify: `lib/slack.ts` (add one interface + one function, near `listUsers` ~line 98)
- Create: `lib/attendeesLive.ts`
- Test: `lib/attendeesLive.test.ts`

**Interfaces:**
- Consumes: `resolveAttendeeQuery`, `collectAttendees`, types from Task 1; the private `call<T>` helper inside `lib/slack.ts`.
- Produces (Task 3 relies on): `fetchUserEmail(userId: string): Promise<string | null>` (lib/slack.ts) and `resolveAttendeesLive(queries: string[], people?: Person[]): Promise<AttendeeResolution>` (lib/attendeesLive.ts).

- [ ] **Step 1: Write the failing test**

Create `lib/attendeesLive.test.ts` (mocks `./slack` — the real module is server-only and network-bound):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveAttendeesLive } from "./attendeesLive";
import type { Person } from "./people";

const fetchUserEmail = vi.hoisted(() => vi.fn());
vi.mock("./slack", () => ({ fetchUserEmail }));

const PEOPLE_FIXTURE: Person[] = [
  { name: "Taras Panasiuk", role: "field", email: "taras@getshaman.com", aliases: ["Тарас"] },
  { name: "Bohdan F", role: "eng", slackId: "U0BOHDAN", aliases: ["Богдан"] }, // no email, has slackId
  { name: "Vlad Bondar", role: "field", aliases: ["Влад"] }, // no email, no slackId
];

beforeEach(() => fetchUserEmail.mockReset());

describe("resolveAttendeesLive", () => {
  it("uses the Slack profile email for a needs-email person, marked source: slack", async () => {
    fetchUserEmail.mockResolvedValue("bohdan@orients.ai");
    const r = await resolveAttendeesLive(["Богдан"], PEOPLE_FIXTURE);
    expect(fetchUserEmail).toHaveBeenCalledWith("U0BOHDAN");
    expect(r).toEqual({
      ok: true,
      attendees: [{ name: "Bohdan F", email: "bohdan@orients.ai", source: "slack" }],
    });
  });

  it("roster email wins — no Slack call for a person who has one", async () => {
    const r = await resolveAttendeesLive(["Тарас"], PEOPLE_FIXTURE);
    expect(fetchUserEmail).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attendees[0].source).toBeUndefined();
  });

  it("fails loudly naming both sources when Slack has no email", async () => {
    fetchUserEmail.mockResolvedValue(null);
    const r = await resolveAttendeesLive(["Богдан"], PEOPLE_FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems[0]).toBe("У «Bohdan F» немає email ні в реєстрі (lib/people.ts), ні в профілі Slack.");
    }
  });

  it("mixed set: roster + slack-fallback + raw email, all-or-nothing on one failure", async () => {
    fetchUserEmail.mockResolvedValue("bohdan@orients.ai");
    const ok = await resolveAttendeesLive(["Тарас", "Богдан", "x@y.com"], PEOPLE_FIXTURE);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.attendees).toHaveLength(3);

    const bad = await resolveAttendeesLive(["Богдан", "Влад"], PEOPLE_FIXTURE);
    expect(bad.ok).toBe(false); // Влад has no slackId — pure problem blocks the set
  });

  it("dedupes a slack-fallback email against a raw duplicate", async () => {
    fetchUserEmail.mockResolvedValue("bohdan@orients.ai");
    const r = await resolveAttendeesLive(["Богдан", "bohdan@orients.ai"], PEOPLE_FIXTURE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attendees).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/attendeesLive.test.ts`
Expected: FAIL — cannot resolve `./attendeesLive`.

- [ ] **Step 3: Add `fetchUserEmail` to `lib/slack.ts`**

Insert after the `listUsers` function (~line 108), following the module's existing style:

```ts
interface UsersInfoResponse extends SlackOk {
  user?: { profile?: { email?: string } };
}

/** Best-effort profile email for a user id (needs the users:read.email scope).
 *  Null — never a throw — when the scope is missing, the profile hides the
 *  email, or the call fails: the caller (lib/attendeesLive.ts) degrades to its
 *  own loud both-sources error, so this stays silent by design. */
export async function fetchUserEmail(userId: string): Promise<string | null> {
  try {
    const body = await call<UsersInfoResponse>("users.info", new URLSearchParams({ user: userId }));
    return body.user?.profile?.email ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Create `lib/attendeesLive.ts`**

```ts
/**
 * Live attendee resolution: the pure roster pass (lib/attendees.ts) plus a
 * Slack-profile email fallback for roster people whose email field is unfilled.
 * Roster email always wins; nothing is cached or written back. SERVER-ONLY
 * reachable (imports lib/slack); the CLI runs under --conditions=react-server.
 * Needs the bot's users:read.email scope — without it fetchUserEmail returns
 * null and the proposal blocks loudly, naming both sources.
 */
import {
  resolveAttendeeQuery,
  collectAttendees,
  type AttendeeQueryResult,
  type AttendeeResolution,
} from "./attendees";
import { PEOPLE, type Person } from "./people";
import { fetchUserEmail } from "./slack";

export async function resolveAttendeesLive(
  queries: string[],
  people: Person[] = PEOPLE,
): Promise<AttendeeResolution> {
  const pure = queries
    .map((s) => s.trim())
    .filter(Boolean)
    .map((q) => resolveAttendeeQuery(q, people));
  const results: AttendeeQueryResult[] = await Promise.all(
    pure.map(async (r): Promise<AttendeeQueryResult> => {
      if (r.kind !== "needs-email") return r;
      const email = await fetchUserEmail(r.slackId);
      if (email) return { kind: "resolved", attendee: { name: r.name, email, source: "slack" } };
      return {
        kind: "problem",
        problem: `У «${r.name}» немає email ні в реєстрі (lib/people.ts), ні в профілі Slack.`,
      };
    }),
  );
  return collectAttendees(results);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run lib/attendeesLive.test.ts lib/attendees.test.ts && npx tsc --noEmit`
Expected: both files PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add lib/slack.ts lib/attendeesLive.ts lib/attendeesLive.test.ts
git commit -m "feat(calendar): Slack-profile email fallback resolver

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire the tool + mark the echo + docs

**Files:**
- Modify: `lib/agent/tools/calendar.ts` (import + one call site)
- Modify: `lib/calendarEvent.ts` (`renderProposalUk` attendee line)
- Modify: `lib/calendarEvent.test.ts` (one new test)
- Modify: `.env.example` (SLACK_TOKEN scopes comment)
- Modify: `CLAUDE.md` (calendar-write bullet, one clause)

**Interfaces:**
- Consumes: `resolveAttendeesLive` (Task 2), `ResolvedAttendee.source` (Task 1).
- Produces: end-user behavior — «створи дзвінок нам з Богданом…» proposes with Bohdan's Slack email, echo marked «зі Slack».

- [ ] **Step 1: Write the failing echo test**

In `lib/calendarEvent.test.ts`, add inside the `describe("renderProposalUk", ...)` block:

```ts
  it("marks slack-sourced emails and leaves roster ones unmarked", () => {
    const out = renderProposalUk({
      title: "Синк",
      startMs: Date.parse("2026-07-08T12:00:00Z"),
      endMs: Date.parse("2026-07-08T12:30:00Z"),
      attendees: [
        { name: "Taras Panasiuk", email: "taras@getshaman.com" },
        { name: "Bohdan F", email: "bohdan@orients.ai", source: "slack" },
      ],
      organizer: "team@orients.ai",
    });
    expect(out).toContain("Bohdan F (bohdan@orients.ai, зі Slack)");
    expect(out).toContain("Taras Panasiuk (taras@getshaman.com)");
    expect(out).not.toContain("taras@getshaman.com, зі Slack");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/calendarEvent.test.ts`
Expected: the new test FAILS (no «зі Slack» in output); the rest pass.

- [ ] **Step 3: Update `renderProposalUk`**

In `lib/calendarEvent.ts`, replace the `who` computation:

```ts
  const who = r.attendees
    .map((a) => {
      if (a.name === a.email) return a.email;
      return `${a.name} (${a.email}${a.source === "slack" ? ", зі Slack" : ""})`;
    })
    .join(", ");
```

- [ ] **Step 4: Switch the tool to the live resolver**

In `lib/agent/tools/calendar.ts`:
- Replace the import `import { resolveAttendees } from "@/lib/attendees";` with `import { resolveAttendeesLive } from "@/lib/attendeesLive";`
- Replace the call `const resolved = resolveAttendees(queries);` with `const resolved = await resolveAttendeesLive(queries);`
- In the file's top doc comment, change "Attendees resolve through the lib/people.ts roster (email field) or raw emails" to "Attendees resolve through the lib/people.ts roster (email field), a Slack-profile email fallback (lib/attendeesLive.ts), or raw emails".

No test-file mock is needed: the existing tool tests use raw emails and unknown names, both of which resolve in the pure pass without touching `fetchUserEmail`. (The `./slack` module load in the test process is harmless — `server-only` is aliased and the token is read lazily.)

- [ ] **Step 5: Run the affected suites**

Run: `npx vitest run lib/calendarEvent.test.ts lib/agent/tools/calendar.test.ts lib/attendees.test.ts lib/attendeesLive.test.ts && npx tsc --noEmit`
Expected: all PASS; tsc clean.

- [ ] **Step 6: Update the docs**

In `.env.example`, in the SLACK_TOKEN comment block, extend the scopes sentence: after `channels:history + groups:history (private channels) + users:read + files:read`, add ` + users:read.email (the calendar attendee Slack-email fallback — without it, people missing a roster email can't be invited by name)`.

In `CLAUDE.md`, in the `npm run calendar-write` bullet, change "Attendees resolve via the `lib/people.ts` roster (`email` field) or raw emails; unknown names fail loudly, never guessed." to "Attendees resolve via the `lib/people.ts` roster (`email` field), then a live Slack-profile email fallback (`lib/attendeesLive.ts`; needs the bot's `users:read.email` scope), then raw emails verbatim; unknown names fail loudly, never guessed (the echo marks Slack-sourced emails «зі Slack»)."

- [ ] **Step 7: Full verification**

Run: `npm test && npm run lint`
Expected: full suite green (955+ tests); lint 0 errors.

- [ ] **Step 8: Commit**

```bash
git add lib/agent/tools/calendar.ts lib/calendarEvent.ts lib/calendarEvent.test.ts .env.example CLAUDE.md
git commit -m "feat(calendar): use Slack-email fallback in the agent tool, mark echo

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Post-merge operator step

Add the **`users:read.email`** OAuth scope to the Slack app (api.slack.com → the app → OAuth & Permissions → Bot Token Scopes) and reinstall it to the workspace. Verified missing 2026-07-07: `users.info` returns ok without `profile.email`. Until added, name-based attendees without roster emails still fail — loudly, naming both sources.
