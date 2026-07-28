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
  /** Jira Cloud accountId (required to set a real assignee). Distinct from
   *  jiraAccount, which is only a display name/username. Filled 2026-07-08 from
   *  the live Jira user list, exact-displayName-matched against the confirmed
   *  jiraAccount join — and only for ACTIVE Jira accounts (assigning to a
   *  deactivated account is a Jira 400, so inactive people keep the safe
   *  named-in-description fallback in lib/jiraRouting.ts). */
  jiraAccountId?: string;
  githubLogin?: string;
  /** Workspace email for Google Calendar invites (filled by a human, like every
   *  other field here — never scraped). A person without one cannot be invited
   *  by name; resolveAttendees (lib/attendees.ts) fails their query loudly. */
  email?: string;
  rosterInitial?: string;
  /** Alternate query spellings (the Ukrainian Cyrillic name, nicknames) matched
   *  by personByQuery only — never used to join identities across sources.
   *  Team members address the Slack agent in Ukrainian, so without these a
   *  «створи задачу на Тараса Панасюка»-style request cannot resolve. */
  aliases?: string[];
}

// Filled from `npm run people:scaffold` (live Slack users.list) cross-referenced
// with committed Jira/GitHub reports + the field roster, then human-reviewed
// 2026-06-30 (mis-join-prone joins confirmed with the team). Bots, integrations,
// and Slack-only non-engineering staff (no Jira/GitHub/roster identity) are
// intentionally omitted — add a person when they gain a cross-source identity.
// Cyrillic aliases are standard Ukrainian transliterations of the canonical
// names (added 2026-07-05 after the Slack agent failed to resolve «Тарас
// Панасюк»); a first-name-only query resolves via the substring rule, and the
// shared first names (Андрій, Олександр, Дмитро) stay deliberately ambiguous.
export const PEOPLE: Person[] = [
  // Leadership / engineering
  // Confirmed 2026-06-30: rosterInitial "О" (Олександр field crew) is this person;
  // the bare jira "Oleksandr" (2025) is a DIFFERENT person, Oleksandr Soroka (below).
  { name: "Oleksandr K", role: "CEO/CTO", slackId: "U08G4EC244X", jiraAccount: "Oleksandr Knyga", jiraAccountId: "712020:2c0a41b9-bdfe-4fd5-a57b-b8047af80d38", rosterInitial: "О", aliases: ["Олександр Книга"] },
  { name: "Bohdan Forostianyi", role: "Head of Engineering", slackId: "U08G4HZQTTR", jiraAccount: "Bohdan Forostianyi", jiraAccountId: "712020:a9e29b5c-76ce-4b70-a8d4-0e3810bb3f85", githubLogin: "forobohd-orients", aliases: ["Богдан Форостяний"] },

  // Developers (Slack + Jira + GitHub where present)
  { name: "Volodymyr Pavliukevych", role: "developer", slackId: "U09526J29AL", jiraAccount: "Volodymyr Pavliukevych", jiraAccountId: "712020:2c9fa200-866c-4d8b-b00a-bd7d434220b0", githubLogin: "VolodymyrPavliukevych", aliases: ["Володимир Павлюкевич"] },
  // also flies (field crew) → rosterInitial joins the field-bonus summary
  { name: "Nadia Khasyshyn", role: "developer / field", slackId: "U099CA0UTFS", jiraAccount: "Nadia Khasyshyn", jiraAccountId: "712020:db500adf-04e5-4d47-bc2e-8fa57a7ec640", githubLogin: "nadiia-khasyshyn", rosterInitial: "Н", aliases: ["Надія Хасишин"] },
  // alt slack U09176GKTMW ("daniltomashi"); 2nd github login "daniltomashi"
  { name: "Danylo Tomashy", role: "developer / field", slackId: "U090AL585N2", jiraAccount: "Danylo Tomashy", jiraAccountId: "712020:e7ec9331-d84e-47cb-8711-d022220a1133", githubLogin: "danylo-tomashy", rosterInitial: "Д", aliases: ["Данило Томаший"] },
  // alt slack U09P9EBJRA7 ("Ljubomyr")
  { name: "Liubomyr Zaiats", role: "developer / field", slackId: "U091JDPH9L5", jiraAccount: "Liubomyr Zaiats", githubLogin: "lzaiatsoai", rosterInitial: "Л", aliases: ["Любомир Заяць"] },
  // jira bare "Andrii" confirmed as Yefimov (distinct from Svidnytskyi / Gresyk)
  { name: "Andrii Yefimov", role: "developer", slackId: "U08G4J1U5EK", jiraAccount: "Andrii", jiraAccountId: "712020:30d29f09-31cc-4fba-a801-15fe0e3dfe6c", githubLogin: "andrii-yefimov", aliases: ["Андрій Єфімов"] },
  { name: "Andrii Svidnytskyi", role: "developer", slackId: "U08GHQUEDPZ", jiraAccount: "Andrii Svidnytskyi", aliases: ["Андрій Свідницький"] },
  { name: "Andrii Gresyk", role: "developer", slackId: "U09MQPBA9AN", jiraAccount: "Andrii Gresyk", aliases: ["Андрій Гресик"] },
  { name: "Maksym Horpynchenko", role: "developer", slackId: "U08G4HVH8B1", jiraAccount: "Horpynchenko Maksym", jiraAccountId: "712020:8a82cbd1-892a-4e84-ba63-335a65830402", aliases: ["Максим Горпинченко"] },
  { name: "Dmytro Antoniuk", role: "developer", slackId: "U08G4HWUYKZ", jiraAccount: "dmytro.antoniuk", aliases: ["Дмитро Антонюк"] },
  { name: "Denys Borysov", role: "developer", slackId: "U08G4HYEGUX", jiraAccount: "denys.borysov", aliases: ["Денис Борисов"] },
  // alt slack U0ANQ8FB6DT, U08NWFTAZFE ("Dmytro R")
  { name: "Dmytro Rozdobudko", role: "developer", slackId: "U08PXFRLGAX", jiraAccount: "dmytro.rozdobudko", jiraAccountId: "712020:5ea27f6e-e295-45cc-8bae-9232424d050f", aliases: ["Дмитро Роздобудько"] },
  { name: "Ruslan B", role: "developer", slackId: "U08G4HTFG6B", jiraAccount: "Ruslan", aliases: ["Руслан"] },
  // the bare jira "Oleksandr" (1 issue, 2025-05) is this person, not the CEO (confirmed 2026-06-30)
  { name: "Oleksandr Soroka", role: "developer", slackId: "U08G4HURRCP", jiraAccount: "Oleksandr", aliases: ["Олександр Сорока"] },

  // Field operators (Slack + roster initial; Jira where present)
  { name: "Andrian Korchynskiy", role: "field operator", slackId: "U09AAVAEE6L", jiraAccount: "Andrian Korchynskiy", rosterInitial: "А", aliases: ["Андріан Корчинський"] },
  { name: "Taras Panasyuk", role: "field operator", slackId: "U09LT4HM9PY", jiraAccount: "taras.panasyuk", rosterInitial: "Т", aliases: ["Тарас Панасюк"] },
  { name: "Kostiantyn V.", role: "field operator", slackId: "U0A77GNUDBJ", jiraAccount: "Kostiantyn V.", rosterInitial: "К", aliases: ["Костянтин"] },
  // alt slack U091JDN2U5B ("Владислав")
  { name: "Vlad_G", role: "field operator", slackId: "U09UA5J6CHH", rosterInitial: "В", aliases: ["Владислав", "Влад"] },
  // rosterInitial "Сер" resolves to "Сергій" via resolveInitial's prefix rule
  { name: "Serhiy Shainyuk", role: "field operator", slackId: "U09P35EQUGZ", rosterInitial: "Сер", aliases: ["Сергій Шайнюк"] },
];

/** Resolve a CLI `--person` query: exact (case-insensitive) name/alias first,
 *  then a unique case-insensitive substring; >1 substring hit is ambiguous. */
export function personByQuery(
  q: string,
  people: Person[] = PEOPLE,
): { person: Person } | { ambiguous: Person[] } | { unknown: string } {
  const needle = q.trim().toLowerCase();
  if (!needle) return { unknown: q };
  const namesOf = (p: Person) => [p.name, ...(p.aliases ?? [])];
  const exact = people.find((p) => namesOf(p).some((n) => n.toLowerCase() === needle));
  if (exact) return { person: exact };
  const hits = people.filter((p) => namesOf(p).some((n) => n.toLowerCase().includes(needle)));
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
export function personForJiraAccountId(id: string, people: Person[] = PEOPLE): Person | undefined {
  return people.find((p) => p.jiraAccountId === id);
}
