/**
 * Typed Vimeo client. SERVER-ONLY.
 *
 * The personal access token is read from process.env.VIMEO_TOKEN and is never
 * exposed to the browser — only this module and app/api/vimeo/route.ts touch it.
 * The `server-only` import makes an accidental client import a build error.
 */
import "server-only";

const VIMEO_API = "https://api.vimeo.com/me/videos";
const API_VERSION = "application/vnd.vimeo.*+json;version=3.4";

/** Only the fields we request via `fields=...`. */
export interface VimeoPictures {
  base_link: string;
}

export interface VimeoVideo {
  name: string;
  /** Duration in seconds. */
  duration: number;
  description: string | null;
  /** Upload time, ISO 8601. */
  created_time: string;
  /** Public Vimeo page URL. */
  link: string;
  pictures: VimeoPictures;
}

interface VimeoPaging {
  next: string | null;
}

interface VimeoListResponse {
  data: VimeoVideo[];
  paging: VimeoPaging;
}

export class VimeoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VimeoError";
  }
}

const FIELDS = [
  "name",
  "duration",
  "description",
  "created_time",
  "link",
  "pictures.base_link",
].join(",");

function token(): string {
  const value = process.env.VIMEO_TOKEN;
  if (!value) {
    throw new VimeoError("VIMEO_TOKEN is not set on the server.");
  }
  return value;
}

async function getPage(url: string): Promise<VimeoListResponse> {
  const res = await fetch(url, {
    headers: {
      Accept: API_VERSION,
      Authorization: `bearer ${token()}`,
    },
    // Always hit Vimeo live; reconciliation must reflect current truth.
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new VimeoError(
      `Vimeo API returned ${res.status} ${res.statusText}${
        body ? `: ${body.slice(0, 300)}` : ""
      }`,
      res.status,
    );
  }

  return (await res.json()) as VimeoListResponse;
}

/** Build the absolute URL for the first page of the account's videos. */
function firstPageUrl(): string {
  const params = new URLSearchParams({
    fields: FIELDS,
    sort: "date",
    direction: "desc",
    per_page: "100",
  });
  return `${VIMEO_API}?${params.toString()}`;
}

/**
 * Fetch all videos uploaded within [start, end] (inclusive day bounds).
 *
 * Results are sorted by date descending, so we stop paging as soon as a page's
 * oldest item predates `start` — we never scan the full account history. The
 * returned list is filtered to the period and preserves descending order.
 *
 * @param start ISO date/datetime marking the inclusive start of the period.
 * @param end   ISO date/datetime marking the inclusive end of the period.
 */
export async function fetchVideosInPeriod(
  start: string,
  end: string,
): Promise<VimeoVideo[]> {
  const startMs = new Date(start).getTime();
  // Treat a bare `YYYY-MM-DD` end as the whole day by extending to its last ms.
  const endMs = endOfPeriodMs(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new VimeoError(`Invalid period bounds: start=${start} end=${end}`);
  }

  const collected: VimeoVideo[] = [];
  let nextUrl: string | null = firstPageUrl();

  while (nextUrl) {
    const page: VimeoListResponse = await getPage(nextUrl);
    const videos = page.data ?? [];

    for (const video of videos) {
      const uploadedMs = new Date(video.created_time).getTime();
      if (uploadedMs >= startMs && uploadedMs <= endMs) {
        collected.push(video);
      }
    }

    // Descending order: once the oldest item on this page is before the period
    // start, every later page is older still — stop.
    const oldestOnPage = videos[videos.length - 1];
    if (oldestOnPage && new Date(oldestOnPage.created_time).getTime() < startMs) {
      break;
    }

    nextUrl = page.paging?.next
      ? new URL(page.paging.next, VIMEO_API).toString()
      : null;
  }

  return collected;
}

/** Inclusive end-of-day for a bare date; passthrough for a full datetime. */
function endOfPeriodMs(end: string): number {
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(end.trim());
  const ms = new Date(isDateOnly ? `${end}T23:59:59.999Z` : end).getTime();
  return ms;
}
