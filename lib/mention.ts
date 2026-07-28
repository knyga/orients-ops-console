/**
 * Resolve a person NAME (or a Person) to a Slack `<@ID>` mention for text the bot
 * POSTS TO SLACK, so people get pinged. Pure — a deterministic function of the
 * curated lib/people.ts registry; no live Slack fetch. Never guesses: an
 * ambiguous name (2+ people) or a person without a slackId renders the plain
 * name. Web/CSV/report surfaces must NOT use this — they keep plain names.
 */
import { PEOPLE, type Person } from "./people";
import { resolveInitial } from "./fieldRoster";

/** Category-ish tokens that legitimately are not people — never warn on these. */
function isLikelyPersonName(token: string): boolean {
  const t = token.trim();
  if (t.length < 2) return false;
  if (/\d/.test(t)) return false; // "15ка", counts, dates
  if (t.toLowerCase() === "інші") return false;
  return /\p{L}/u.test(t);
}

/** lower-cased name key → slackId, ambiguous keys dropped. Built once. */
const NAME_TO_ID: Map<string, string> = (() => {
  const seen = new Map<string, Set<string>>();
  const add = (key: string, id: string) => {
    const k = key.trim().toLowerCase();
    if (!k) return;
    (seen.get(k) ?? seen.set(k, new Set()).get(k)!).add(id);
  };
  for (const p of PEOPLE) {
    if (!p.slackId) continue;
    add(p.name, p.slackId);
    for (const a of p.aliases ?? []) add(a, p.slackId);
    if (p.rosterInitial) {
      const r = resolveInitial(p.rosterInitial);
      if ("name" in r) add(r.name, p.slackId);
    }
  }
  const out = new Map<string, string>();
  for (const [k, ids] of seen) if (ids.size === 1) out.set(k, [...ids][0]);
  return out;
})();

/** slackId → canonical display name, for dementionText. */
const ID_TO_NAME: Map<string, string> = new Map(
  PEOPLE.filter((p) => p.slackId).map((p) => [p.slackId!, p.name]),
);

/** "<@ID>" if `name` resolves to exactly one person with a slackId; else the
 *  plain name (with a warn for an unresolved person-like name). */
export function mentionize(name: string): string {
  const id = NAME_TO_ID.get(name.trim().toLowerCase());
  if (id) return `<@${id}>`;
  if (isLikelyPersonName(name)) {
    console.warn(`[mention] no unique Slack id for "${name.trim()}" — add an alias/slackId to lib/people.ts`);
  }
  return name;
}

/** "<@ID>" when the Person has a slackId, else the person's name. */
export function mention(person: Person): string {
  return person.slackId ? `<@${person.slackId}>` : person.name;
}

/** Rewrite every "<@ID>" token back to the person's canonical name (unknown id
 *  tokens left intact). For parse/display surfaces that must stay name-based. */
export function dementionText(text: string): string {
  return text.replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (whole, id) => ID_TO_NAME.get(id) ?? whole);
}
