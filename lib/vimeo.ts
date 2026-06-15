/**
 * Typed Vimeo client. SERVER-ONLY.
 *
 * The personal access token is read from process.env.VIMEO_TOKEN and is never
 * exposed to the browser — only this module and app/api/vimeo/route.ts touch it.
 * The `server-only` import makes an accidental client import a build error.
 */
import "server-only";
import { videoUploadDate } from "./reconcile";

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fetch all videos whose upload day (Europe/Kyiv) falls within [start, end].
 *
 * The window is matched on the *Kyiv calendar date* — the same basis the
 * reconciliation uses to group days — not on a UTC instant. Matching on UTC
 * would drop videos uploaded just after Kyiv midnight at the period edges
 * (their UTC instant lands on the previous/next UTC day) and could pull in
 * videos from the day after `end`.
 *
 * Results are sorted by date descending, so we stop paging as soon as a page's
 * oldest item is on a Kyiv day before `start` — we never scan the full account
 * history.
 *
 * @param start inclusive period start, `YYYY-MM-DD`.
 * @param end   inclusive period end, `YYYY-MM-DD`.
 */
export async function fetchVideosInPeriod(
  start: string,
  end: string,
): Promise<VimeoVideo[]> {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new VimeoError(
      `Period bounds must be YYYY-MM-DD: start=${start} end=${end}`,
    );
  }

  const collected: VimeoVideo[] = [];
  let nextUrl: string | null = firstPageUrl();

  while (nextUrl) {
    const page: VimeoListResponse = await getPage(nextUrl);
    const videos = page.data ?? [];

    for (const video of videos) {
      // Lexicographic comparison is valid for YYYY-MM-DD strings.
      const day = videoUploadDate(video.created_time);
      if (day >= start && day <= end) {
        collected.push(video);
      }
    }

    // Descending order: once the oldest item on this page is on a Kyiv day
    // before the period start, every later page is older still — stop.
    const oldestOnPage = videos[videos.length - 1];
    if (oldestOnPage && videoUploadDate(oldestOnPage.created_time) < start) {
      break;
    }

    nextUrl = page.paging?.next
      ? new URL(page.paging.next, VIMEO_API).toString()
      : null;
  }

  return collected;
}
