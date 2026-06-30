/**
 * Hardcoded, auditable people registry — the one place that joins a single
 * human across the console's identity namespaces (Slack id, Jira account,
 * GitHub login, #field-qa Cyrillic initial). Styled like lib/approvers.ts and
 * lib/slackChannels.ts: membership is a deliberate, version-controlled decision,
 * not runtime config and not name-matched on the fly (name guessing across
 * sources silently mis-joins people — the failure mode this registry prevents).
 *
 * Every external-id field is optional: field operators carry rosterInitial
 * (+ slackId); developers carry jiraAccount/githubLogin. Seed below with what is
 * known in-repo; fill the rest from `npm run people:scaffold` proposals after a
 * human review. Pure — no DB/Next imports; PEOPLE is a literal.
 */
export interface Person {
  /** Canonical display name (NOT the Cyrillic roster name). */
  name: string;
  role: string;
  slackId?: string;
  jiraAccount?: string;
  githubLogin?: string;
  rosterInitial?: string;
}

export const PEOPLE: Person[] = [
  { name: "Oleksandr K", role: "CEO/CTO", slackId: "U08G4EC244X", rosterInitial: "О" },
  { name: "Bohdan Forostianyi", role: "Head of Engineering", slackId: "U08G4HZQTTR" },
];

/** Resolve a CLI `--person` query: exact (case-insensitive) name first, then a
 *  unique case-insensitive substring; >1 substring hit is ambiguous. */
export function personByQuery(
  q: string,
  people: Person[] = PEOPLE,
): { person: Person } | { ambiguous: Person[] } | { unknown: string } {
  const needle = q.trim().toLowerCase();
  if (!needle) return { unknown: q };
  const exact = people.find((p) => p.name.toLowerCase() === needle);
  if (exact) return { person: exact };
  const hits = people.filter((p) => p.name.toLowerCase().includes(needle));
  if (hits.length === 1) return { person: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };
  return { unknown: q };
}

export function personForSlackId(id: string, people: Person[] = PEOPLE): Person | undefined {
  return people.find((p) => p.slackId === id);
}
export function personForGithubLogin(login: string, people: Person[] = PEOPLE): Person | undefined {
  return people.find((p) => p.githubLogin === login);
}
export function personForJiraAccount(acct: string, people: Person[] = PEOPLE): Person | undefined {
  return people.find((p) => p.jiraAccount === acct);
}
export function personForInitial(initial: string, people: Person[] = PEOPLE): Person | undefined {
  return people.find((p) => p.rosterInitial === initial);
}
