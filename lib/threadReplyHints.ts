/**
 * Deterministic hints extracted from a thread reply BEFORE classification (pilot
 * evidence autonomy). Fed to the classifier and applied as hard rules: a Vimeo
 * link is video evidence and a #datasets permalink is dataset evidence no
 * matter what the model says. Pure; unit-tested.
 */
export interface ReplyHints {
  vimeoLinks: { url: string; id: string }[];
  datasetPermalinks: { url: string; ts: string }[];
  timeRanges: { start: string; end: string }[];
  minuteFigures: number[];
}

/** Slack renders links as <url> or <url|label>; keep just the url. */
export function unwrapSlackLinks(text: string): string {
  return text.replace(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g, "$1");
}

const VIMEO_RE = /https?:\/\/(?:www\.)?vimeo\.com\/(?:[a-z]+\/[a-z]+\/)?(\d{6,})[^\s<>|]*/gi;
const PERMALINK_RE = /https?:\/\/[^\s<>|]+\/archives\/([A-Z0-9]+)\/p(\d{16})[^\s<>|]*/g;
const RANGE_RE = /(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/g;
const MINUTES_RE = /(\d{1,3})\s*(?:хв|мін|min)(?![\p{L}])/giu;

const pad = (n: string): string => n.padStart(2, "0");

export function extractHints(text: string, datasetsChannelId: string): ReplyHints {
  const t = unwrapSlackLinks(text);
  const vimeoLinks = [...t.matchAll(VIMEO_RE)].map((m) => ({ url: m[0], id: m[1] }));
  const datasetPermalinks = [...t.matchAll(PERMALINK_RE)]
    .filter((m) => m[1] === datasetsChannelId)
    .map((m) => ({ url: m[0], ts: `${m[2].slice(0, 10)}.${m[2].slice(10)}` }));
  const timeRanges = [...t.matchAll(RANGE_RE)]
    .filter((m) => Number(m[1]) < 24 && Number(m[3]) < 24 && Number(m[2]) < 60 && Number(m[4]) < 60)
    .map((m) => ({ start: `${pad(m[1])}:${m[2]}`, end: `${pad(m[3])}:${m[4]}` }));
  const minuteFigures = [...t.matchAll(MINUTES_RE)].map((m) => Number(m[1]));
  return { vimeoLinks, datasetPermalinks, timeRanges, minuteFigures };
}
