/**
 * Resolve a resolved roster NAME (from lib/fieldRoster) to a Slack user id for
 * DMs. Override map first (hand-maintained for nicknames the directory can't
 * match), then an EXACT, UNAMBIGUOUS match against the live directory; otherwise
 * null so the caller skips the DM and flags it — we never DM a guessed id. Pure.
 */
export const SLACK_ID_OVERRIDES: Record<string, string> = {
  // "Constв name": "U0XXXXX",  // fill in as misses surface
};

export function matchSlackId(
  name: string,
  users: { id: string; name: string }[],
  overrides: Record<string, string> = SLACK_ID_OVERRIDES,
): string | null {
  if (overrides[name]) return overrides[name];
  const exact = users.filter((u) => u.name === name);
  if (exact.length === 1) return exact[0].id;
  return null;
}
