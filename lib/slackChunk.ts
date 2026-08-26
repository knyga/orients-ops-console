/**
 * Split a Slack message into chunks that survive chat.postMessage/chat.update.
 * Slack rejects long texts with `msg_too_long` — observed 2026-08-01 on the
 * agent DM surface: edits of 5311+ BYTES failed while 3528 bytes passed, i.e.
 * the limit is ~4000 UTF-8 bytes, not characters (Cyrillic answers hit it at
 * ~2000 chars). Pure module (no Slack/Next imports) — unit-tested.
 *
 * Chunks are lossless: `chunks.join("") === text`. Splits prefer line
 * boundaries (each segment keeps its trailing newline); a single line longer
 * than the limit is hard-split at code-point boundaries.
 */
export const SLACK_MSG_MAX_BYTES = 3800; // headroom under Slack's ~4000-byte msg_too_long cutoff

const encoder = new TextEncoder();
/** UTF-8 byte length — the unit Slack's message cap is actually measured in. */
export const byteLength = (s: string): number => encoder.encode(s).length;

/** Hard-split one oversized segment at code-point boundaries. */
function splitByBytes(segment: string, maxBytes: number): string[] {
  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of segment) {
    const b = byteLength(ch);
    if (currentBytes + b > maxBytes && current.length > 0) {
      out.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += b;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function chunkForSlack(text: string, maxBytes: number = SLACK_MSG_MAX_BYTES): string[] {
  if (byteLength(text) <= maxBytes) return [text];
  // Keep line endings on their segments so concatenation is lossless.
  const segments = text.split(/(?<=\n)/);
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const segment of segments) {
    const segBytes = byteLength(segment);
    if (currentBytes + segBytes > maxBytes) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
        currentBytes = 0;
      }
      if (segBytes > maxBytes) {
        const pieces = splitByBytes(segment, maxBytes);
        chunks.push(...pieces.slice(0, -1));
        current = pieces[pieces.length - 1] ?? "";
        currentBytes = byteLength(current);
        continue;
      }
    }
    current += segment;
    currentBytes += segBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
