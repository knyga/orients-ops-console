/**
 * Pure people→project routing for Jira ticket creation. No server-only / node
 * imports — a literal-config + pure-function module like lib/people.ts.
 *
 * Encodes the Head-of-Engineering rule: Любомир / Андріан / Тарас's tickets are
 * assigned to the shared "Mr Lab" Jira USER (they have no own Jira accounts),
 * with the intended person written into the description. Everyone else goes to
 * the default project; a real Jira assignee is set only when the person carries
 * a jiraAccountId (Jira's assignee field needs an accountId, which
 * lib/people.ts's jiraAccount display-name/username is NOT). Absent that, the
 * person is named in the description — safe and unambiguous.
 */
import type { Person } from "./people";

export interface RoutingConfig {
  defaultProject: string;
  mrLabAccountId: string;
  mrLabPeople: string[];
}

/** Canonical lib/people.ts names that route to Mr Lab (Bohdan's rule). */
export const MRLAB_PEOPLE: string[] = [
  "Liubomyr Zaiats",
  "Andrian Korchynskiy",
  "Taras Panasyuk",
];

/** Team default board is ATP (orients.atlassian.net/.../projects/ATP). Hardcoded
 *  so no new Vercel env var is needed for the default project; JIRA_DEFAULT_PROJECT
 *  can still override it. */
export const DEFAULT_PROJECT = "ATP";

/** The shared "Mr Lab" Jira user (accountType atlassian, no email) — the trio's
 *  tickets are assigned to it. Hardcoded like DEFAULT_PROJECT (an accountId is
 *  config, not a secret); JIRA_MRLAB_ACCOUNT_ID can override it. */
export const MRLAB_ACCOUNT_ID = "712020:4f8c0cbd-bdd4-408e-b8ea-435478c10e9c";

export function routingConfigFromEnv(): RoutingConfig {
  const defaultProject = process.env.JIRA_DEFAULT_PROJECT ?? DEFAULT_PROJECT;
  const mrLabAccountId = process.env.JIRA_MRLAB_ACCOUNT_ID ?? MRLAB_ACCOUNT_ID;
  return { defaultProject, mrLabAccountId, mrLabPeople: MRLAB_PEOPLE };
}

export interface IssueRouting {
  projectKey: string;
  assignInDescription: boolean;
  jiraAccountId: string | null;
}

export function routeIssue(person: Person, cfg: RoutingConfig): IssueRouting {
  const isMrLab = cfg.mrLabPeople.includes(person.name);
  if (isMrLab) {
    return { projectKey: cfg.defaultProject, assignInDescription: true, jiraAccountId: cfg.mrLabAccountId };
  }
  if (person.jiraAccountId) {
    return { projectKey: cfg.defaultProject, assignInDescription: false, jiraAccountId: person.jiraAccountId };
  }
  return { projectKey: cfg.defaultProject, assignInDescription: true, jiraAccountId: null };
}
