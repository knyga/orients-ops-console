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

// Filled from `npm run people:scaffold` (live Slack users.list) cross-referenced
// with committed Jira/GitHub reports + the field roster, then human-reviewed
// 2026-06-30 (mis-join-prone joins confirmed with the team). Bots, integrations,
// and Slack-only non-engineering staff (no Jira/GitHub/roster identity) are
// intentionally omitted — add a person when they gain a cross-source identity.
export const PEOPLE: Person[] = [
  // Leadership / engineering
  // jira: both "Oleksandr Knyga" (primary) and a bare "Oleksandr" are this person;
  // the Person.jiraAccount join keys on one id, so only the primary joins today.
  // rosterInitial "О" (Олександр) is deliberately NOT set here — unconfirmed whether
  // the field "Олександр" is the CEO or "Олександр Сорока" (slack U08G4HURRCP).
  { name: "Oleksandr K", role: "CEO/CTO", slackId: "U08G4EC244X", jiraAccount: "Oleksandr Knyga" },
  { name: "Bohdan Forostianyi", role: "Head of Engineering", slackId: "U08G4HZQTTR", jiraAccount: "Bohdan Forostianyi", githubLogin: "forobohd-orients" },

  // Developers (Slack + Jira + GitHub where present)
  { name: "Volodymyr Pavliukevych", role: "developer", slackId: "U09526J29AL", jiraAccount: "Volodymyr Pavliukevych", githubLogin: "VolodymyrPavliukevych" },
  // also flies (field crew) → rosterInitial joins the field-bonus summary
  { name: "Nadia Khasyshyn", role: "developer / field", slackId: "U099CA0UTFS", jiraAccount: "Nadia Khasyshyn", githubLogin: "nadiia-khasyshyn", rosterInitial: "Н" },
  // alt slack U09176GKTMW ("daniltomashi"); 2nd github login "daniltomashi"
  { name: "Danylo Tomashy", role: "developer / field", slackId: "U090AL585N2", jiraAccount: "Danylo Tomashy", githubLogin: "danylo-tomashy", rosterInitial: "Д" },
  // alt slack U09P9EBJRA7 ("Ljubomyr")
  { name: "Liubomyr Zaiats", role: "developer / field", slackId: "U091JDPH9L5", jiraAccount: "Liubomyr Zaiats", githubLogin: "lzaiatsoai", rosterInitial: "Л" },
  // jira bare "Andrii" confirmed as Yefimov (distinct from Svidnytskyi / Gresyk)
  { name: "Andrii Yefimov", role: "developer", slackId: "U08G4J1U5EK", jiraAccount: "Andrii", githubLogin: "andrii-yefimov" },
  { name: "Andrii Svidnytskyi", role: "developer", slackId: "U08GHQUEDPZ", jiraAccount: "Andrii Svidnytskyi" },
  { name: "Andrii Gresyk", role: "developer", slackId: "U09MQPBA9AN", jiraAccount: "Andrii Gresyk" },
  { name: "Maksym Horpynchenko", role: "developer", slackId: "U08G4HVH8B1", jiraAccount: "Horpynchenko Maksym" },
  { name: "Dmytro Antoniuk", role: "developer", slackId: "U08G4HWUYKZ", jiraAccount: "dmytro.antoniuk" },
  { name: "Denys Borysov", role: "developer", slackId: "U08G4HYEGUX", jiraAccount: "denys.borysov" },
  // alt slack U0ANQ8FB6DT, U08NWFTAZFE ("Dmytro R")
  { name: "Dmytro Rozdobudko", role: "developer", slackId: "U08PXFRLGAX", jiraAccount: "dmytro.rozdobudko" },
  { name: "Ruslan B", role: "developer", slackId: "U08G4HTFG6B", jiraAccount: "Ruslan" },

  // Field operators (Slack + roster initial; Jira where present)
  { name: "Andrian Korchynskiy", role: "field operator", slackId: "U09AAVAEE6L", jiraAccount: "Andrian Korchynskiy", rosterInitial: "А" },
  { name: "Taras Panasyuk", role: "field operator", slackId: "U09LT4HM9PY", jiraAccount: "taras.panasyuk", rosterInitial: "Т" },
  { name: "Kostiantyn V.", role: "field operator", slackId: "U0A77GNUDBJ", jiraAccount: "Kostiantyn V.", rosterInitial: "К" },
  // alt slack U091JDN2U5B ("Владислав")
  { name: "Vlad_G", role: "field operator", slackId: "U09UA5J6CHH", rosterInitial: "В" },
  // rosterInitial "Сер" resolves to "Сергій" via resolveInitial's prefix rule
  { name: "Serhiy Shainyuk", role: "field operator", slackId: "U09P35EQUGZ", rosterInitial: "Сер" },
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
