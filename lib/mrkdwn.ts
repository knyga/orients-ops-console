/**
 * Convert model-generated GitHub-flavored markdown into Slack mrkdwn.
 *
 * Slack does NOT render markdown: `**bold**`, `[text](url)`, `## headings` all
 * show up literally. The agent loop's model writes markdown, so every reply that
 * reaches Slack must pass through this at the posting boundary (the CLI twin
 * prints to a terminal, where markdown is fine — do not convert inside the loop).
 *
 * Pure module (no React/Next/env) — keep it unit-tested and dependency-free.
 * Code spans and fenced blocks are preserved verbatim.
 */

/** Inline transforms applied to non-code text. */
function convertInline(text: string): string {
  return (
    text
      // links first, so `[**x**](url)` keeps its label transforms simple
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
      .replace(/\*\*\*([^*]+)\*\*\*/g, "*_$1_*")
      .replace(/\*\*([^*]+)\*\*/g, "*$1*")
      .replace(/__([^_]+)__/g, "*$1*")
      .replace(/~~([^~]+)~~/g, "~$1~")
  );
}

/** Line-level transforms (headings, list bullets) applied to non-code text. */
function convertLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) return `*${heading[1].trim()}*`;
      return line.replace(/^(\s*)[-*]\s+/, "$1• ");
    })
    .join("\n");
}

function convertSegment(text: string): string {
  // Protect inline code spans within the segment.
  const parts = text.split(/(`[^`]*`)/);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : convertInline(convertLines(part))))
    .join("");
}

export function markdownToMrkdwn(text: string): string {
  // Split out fenced code blocks; odd indices are the fences themselves.
  const segments = text.split(/(```[\s\S]*?```)/);
  return segments.map((seg, i) => (i % 2 === 1 ? seg : convertSegment(seg))).join("");
}
