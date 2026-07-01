/**
 * Pure people→project routing for Jira ticket creation. No server-only / node
 * imports — a literal-config + pure-function module like lib/people.ts.
 *
 * Encodes the Head-of-Engineering rule: Любомир / Андріан / Тарас are created on
 * the Mr Lab project with the intended assignee written into the description
 * (they are not real assignees on that board). Everyone else goes to the default
 * project; a real Jira assignee is set only when the person carries a
 * jiraAccountId (Jira's assignee field needs an accountId, which lib/people.ts's
 * jiraAccount display-name/username is NOT). Absent that, the person is named in
 * the description — safe and unambiguous.
 */
import type { Person } from "./people";

export interface RoutingConfig {
  defaultProject: string;
  mrLabProject: string;
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

export function routingConfigFromEnv(): RoutingConfig {
  const defaultProject = process.env.JIRA_DEFAULT_PROJECT ?? DEFAULT_PROJECT;
  const mrLabProject = process.env.JIRA_MRLAB_PROJECT;
  if (!mrLabProject) throw new Error("JIRA_MRLAB_PROJECT is not set on the server.");
  return { defaultProject, mrLabProject, mrLabPeople: MRLAB_PEOPLE };
}

export interface IssueRouting {
  projectKey: string;
  assignInDescription: boolean;
  jiraAccountId: string | null;
}

export function routeIssue(person: Person, cfg: RoutingConfig): IssueRouting {
  const isMrLab = cfg.mrLabPeople.includes(person.name);
  if (isMrLab) {
    return { projectKey: cfg.mrLabProject, assignInDescription: true, jiraAccountId: null };
  }
  if (person.jiraAccountId) {
    return { projectKey: cfg.defaultProject, assignInDescription: false, jiraAccountId: person.jiraAccountId };
  }
  return { projectKey: cfg.defaultProject, assignInDescription: true, jiraAccountId: null };
}
