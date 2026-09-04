/**
 * The trailing «🔗 …» cross-link region every per-day #field-qa bot message
 * carries (spec: docs/superpowers/specs/2026-09-04-field-qa-cross-links-design.md).
 * Always the LAST line of a message, disjoint from the verdict's body / 👥 crew /
 * 🛸 drone regions, so each editor can peel it, rebuild its own region, and
 * re-append it unchanged. PURE — no imports; shared by lib/verdictPublish (the
 * region splitters) and lib/dayLinks (the planner).
 */
export const LINKS_MARKER = "🔗 ";

/** Peel exactly one trailing 🔗 line. A 🔗 line anywhere else is left alone. */
export function splitLinksRegion(text: string): { rest: string; linksLine: string | null } {
  const idx = text.lastIndexOf("\n");
  const last = idx === -1 ? text : text.slice(idx + 1);
  if (!last.startsWith(LINKS_MARKER)) return { rest: text, linksLine: null };
  return { rest: idx === -1 ? "" : text.slice(0, idx), linksLine: last };
}

/** Replace/append the trailing 🔗 line; `null` removes it. Idempotent. */
export function withLinksRegion(text: string, line: string | null): string {
  const { rest } = splitLinksRegion(text);
  if (line === null) return rest;
  return rest ? `${rest}\n${line}` : line;
}
