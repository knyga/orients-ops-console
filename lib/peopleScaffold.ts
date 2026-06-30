/**
 * Pure matching for `npm run people:scaffold`. Groups external identities from
 * live Slack / committed Jira+GitHub / roster by case-insensitive display name
 * into reviewable proposals. This ONLY proposes — a human pastes confirmed
 * entries into lib/people.ts. Name matching is the silent mis-join risk the
 * registry exists to prevent, so every proposal is flagged for review.
 */
export interface Candidate { source: "slack" | "jira" | "github" | "roster"; externalId: string; displayName: string }
export interface Proposal { name: string; matches: Candidate[]; confidence: "name" }

export function proposeMatches(candidates: Candidate[]): Proposal[] {
  const byName = new Map<string, { display: string; matches: Candidate[] }>();
  for (const c of candidates) {
    const key = c.displayName.trim().toLowerCase();
    if (!key) continue;
    const entry = byName.get(key) ?? { display: c.displayName.trim(), matches: [] };
    entry.matches.push(c);
    byName.set(key, entry);
  }
  return [...byName.values()].map((e) => ({ name: e.display, matches: e.matches, confidence: "name" as const }));
}

export function formatProposals(proposals: Proposal[]): string {
  const lines = ["people:scaffold proposals — ⚠ review before pasting into lib/people.ts (name match may mis-join):", ""];
  for (const p of proposals) {
    lines.push(`${p.name}  (confidence: ${p.confidence})`);
    for (const m of p.matches) lines.push(`  ${m.source} ${m.externalId}`);
    lines.push("");
  }
  return lines.join("\n");
}
