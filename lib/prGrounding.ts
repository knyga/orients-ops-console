/**
 * Pure shaping of merged-PR context (title, description, comments, diff) into
 * the grounding text block appended to the investor-summary prompt. No env, no
 * network, no fs — the fetch layer (lib/githubPrContext.ts) produces PrContext
 * rows and this module turns them into one capped text block + metadata for
 * the stored InvestorRecord (metadata only — raw diffs never hit the DB).
 *
 * Caps exist because PR diffs are unbounded: a runaway diff must not blow the
 * Claude context or the cron budget. Truncation is always flagged in meta,
 * never silent.
 */

export interface PrComment {
  author: string;
  body: string;
}

export interface PrContext {
  repo: string;
  number: number;
  title: string;
  author: string;
  /** PR description (markdown). */
  body: string;
  /** ISO 8601. */
  mergedAt: string;
  comments: PrComment[];
  /** Unified diff text (may already be pre-truncated by the fetcher). */
  diff: string;
}

export interface GroundingCaps {
  maxPrs: number;
  maxBodyChars: number;
  maxCommentsPerPr: number;
  maxCommentChars: number;
  maxDiffChars: number;
  maxTotalChars: number;
}

export const DEFAULT_GROUNDING_CAPS: GroundingCaps = {
  maxPrs: 30,
  maxBodyChars: 2_000,
  maxCommentsPerPr: 10,
  maxCommentChars: 500,
  maxDiffChars: 15_000,
  maxTotalChars: 120_000,
};

/** What the stored record keeps about the grounding (never the raw diffs). */
export interface GroundingMeta {
  /** PRs offered to the builder (pre-cap). */
  prCount: number;
  /** PRs that made it into the text, in order. */
  included: { repo: string; number: number; title: string }[];
  totalChars: number;
  /** True when anything was cut: dropped PRs, or a clipped body/comment/diff. */
  truncated: boolean;
}

export interface GroundingResult {
  text: string;
  meta: GroundingMeta;
}

const CUT = "…[обрізано]";

function clip(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max) return { text: s, cut: false };
  return { text: s.slice(0, max) + CUT, cut: true };
}

/** Render capped PR contexts into the prompt grounding block. */
export function buildPrGroundingText(
  prs: PrContext[],
  caps: GroundingCaps = DEFAULT_GROUNDING_CAPS,
): GroundingResult {
  let truncated = prs.length > caps.maxPrs;
  const included: GroundingMeta["included"] = [];
  const sections: string[] = [];
  let total = 0;

  for (const pr of prs.slice(0, caps.maxPrs)) {
    const body = clip(pr.body, caps.maxBodyChars);
    const diff = clip(pr.diff, caps.maxDiffChars);
    if (pr.comments.length > caps.maxCommentsPerPr) truncated = true;
    const comments = pr.comments.slice(0, caps.maxCommentsPerPr).map((c) => {
      const clipped = clip(c.body, caps.maxCommentChars);
      if (clipped.cut) truncated = true;
      return `- ${c.author}: ${clipped.text}`;
    });
    if (body.cut || diff.cut) truncated = true;

    const section = [
      `### ${pr.repo}#${pr.number}: ${pr.title} (${pr.author}, merged ${pr.mergedAt.slice(0, 10)})`,
      ...(body.text ? [body.text] : []),
      ...(comments.length ? ["Коментарі:", ...comments] : []),
      ...(diff.text ? ["```diff", diff.text, "```"] : []),
    ].join("\n");

    // +1 for the joining newline between sections.
    const addition = section.length + (sections.length ? 1 : 0);
    if (total + addition > caps.maxTotalChars) {
      truncated = true;
      break;
    }
    total += addition;
    sections.push(section);
    included.push({ repo: pr.repo, number: pr.number, title: pr.title });
  }

  const text = sections.join("\n");
  return {
    text,
    meta: { prCount: prs.length, included, totalChars: text.length, truncated },
  };
}

/**
 * Pick the PRs merged inside the [start, end] UTC day window, newest merge
 * first, capped at maxPrs. Pure — the fetch layer feeds it raw PR nodes.
 */
export function selectMergedInWindow<T extends { mergedAt: string | null }>(
  nodes: T[],
  start: string,
  end: string,
  maxPrs: number,
): T[] {
  const since = `${start}T00:00:00.000Z`;
  const until = `${end}T23:59:59.999Z`;
  return nodes
    .filter((n): n is T & { mergedAt: string } =>
      n.mergedAt !== null && n.mergedAt >= since && n.mergedAt <= until,
    )
    .sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1))
    .slice(0, maxPrs);
}
