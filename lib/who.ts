/**
 * Pure assembler for the `who` person-centric view. The Slack mirror is the
 * timestamped spine; Jira / GitHub / field-bonus attach as period summaries.
 * No fs/DB/Next imports — the orchestrator (CLI / API route) reads the sources
 * and passes them in (the lib/reconcile.ts discipline).
 */
import type { Person } from "./people";
import { personForSlackId, personForJiraAccount, personForGithubLogin } from "./people";
import { resolveInitial } from "./fieldRoster";
import type { Period } from "./period";
import type { StoredMessage } from "./slackMirror";

export interface TimelineEntry { ts: string; isoTime: string; channel: string; text: string; permalink: string }
export interface JiraSummary { issueKeys: string[]; count: number; points: number }
export interface GithubSummary { commits: number; additions: number; deletions: number; prsOpened: number; prsMerged: number }
export interface FieldSummary { trips: number; flightDays: number; flightMinutes: number; netUah: number }

export interface WhoSources {
  messages: StoredMessage[];
  jira: { rows: { accountId: string | null; issueKeys: string[]; storyPoints: number }[] } | null;
  github: { contributors: { login: string; commits: number; additions: number; deletions: number; prsOpened: number; prsMerged: number }[] } | null;
  bonus: { people: { name: string; trips: number; net: number }[]; days: { date: string; roster: string[]; deployMin: number | null }[] } | null;
}

export interface PersonView {
  person: Person;
  period: Period;
  timeline: TimelineEntry[];
  summary: { jira?: JiraSummary; github?: GithubSummary; field?: FieldSummary };
}

export interface UnlinkedReport { slack: string[]; jira: string[]; github: string[]; roster: string[] }

/** Roster (Cyrillic) name for a person via their rosterInitial, or undefined. */
function rosterName(person: Person): string | undefined {
  if (!person.rosterInitial) return undefined;
  const r = resolveInitial(person.rosterInitial);
  return "name" in r ? r.name : undefined;
}

export function buildPersonView(person: Person, period: Period, sources: WhoSources): PersonView {
  const timeline: TimelineEntry[] = sources.messages
    .filter((m) => !m.deleted && person.slackId && m.authorId === person.slackId)
    .map((m) => ({ ts: m.ts, isoTime: m.isoTime, channel: m.channel, text: m.text, permalink: m.permalink }))
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const summary: PersonView["summary"] = {};

  if (person.jiraAccount && sources.jira) {
    const row = sources.jira.rows.find((r) => r.accountId === person.jiraAccount);
    if (row) summary.jira = { issueKeys: row.issueKeys, count: row.issueKeys.length, points: row.storyPoints };
  }

  if (person.githubLogin && sources.github) {
    const c = sources.github.contributors.find((c) => c.login === person.githubLogin);
    if (c) summary.github = { commits: c.commits, additions: c.additions, deletions: c.deletions, prsOpened: c.prsOpened, prsMerged: c.prsMerged };
  }

  const rname = rosterName(person);
  if (rname && sources.bonus) {
    const pb = sources.bonus.people.find((p) => p.name === rname);
    if (pb) {
      const myDays = sources.bonus.days.filter((d) => d.roster.includes(rname));
      const flightMinutes = myDays.reduce((sum, d) => sum + (d.deployMin ?? 0), 0);
      summary.field = { trips: pb.trips, flightDays: myDays.length, flightMinutes, netUah: pb.net };
    }
  }

  return { person, period, timeline, summary };
}

export function findUnlinked(sources: WhoSources, people: Person[]): UnlinkedReport {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const slack = uniq(sources.messages.map((m) => m.authorId).filter((id) => !personForSlackId(id, people)));
  const jira = uniq((sources.jira?.rows ?? [])
    .map((r) => r.accountId)
    .filter((a): a is string => a !== null && !personForJiraAccount(a, people)));
  const github = uniq((sources.github?.contributors ?? [])
    .map((c) => c.login)
    .filter((l) => !personForGithubLogin(l, people)));
  // A roster name is "linked" if some person's rosterInitial resolves to it.
  const linkedRosterNames = new Set(
    people
      .map((p) => (p.rosterInitial ? resolveInitial(p.rosterInitial) : null))
      .filter((r): r is { name: string } => !!r && "name" in r)
      .map((r) => r.name),
  );
  const roster = uniq((sources.bonus?.people ?? [])
    .map((p) => p.name)
    .filter((n) => !linkedRosterNames.has(n)));
  return { slack, jira, github, roster };
}
