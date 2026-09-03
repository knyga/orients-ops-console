/**
 * Minimal Slack-mrkdwn → segments for rendering a bot message on the web
 * (the Verdict tab's «Підсумок» panel shows the exact text the bot posts).
 * Handles what our summaries emit: *bold*, <url|label> links, <#C…> channel
 * refs. Pure, client-bundle-safe.
 */
export type MrkdwnSegment =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "link"; text: string; href: string };

const TOKEN = /\*([^*\n]+)\*|<(https?:\/\/[^|>]+)\|([^>]+)>|<#([A-Z0-9]+)>/g;

export function parseMrkdwnLine(line: string): MrkdwnSegment[] {
  const out: MrkdwnSegment[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: "text", text: line.slice(last, idx) });
    if (m[1] !== undefined) out.push({ kind: "bold", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "link", text: m[3], href: m[2] });
    else out.push({ kind: "text", text: `#${m[4]}` });
    last = idx + m[0].length;
  }
  if (last < line.length) out.push({ kind: "text", text: line.slice(last) });
  return out.length ? out : [{ kind: "text", text: "" }];
}
