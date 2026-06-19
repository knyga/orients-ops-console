import type { SlackFile } from "./policySchedule";

export interface RawFile {
  name?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
}

/** Map raw Slack `.files[]` to our SlackFile shape; undefined when none. */
export function toSlackFiles(raw: RawFile[] | undefined): SlackFile[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((f) => ({
    name: f.name ?? "",
    mimetype: f.mimetype ?? "",
    urlPrivate: f.url_private_download ?? f.url_private ?? "",
  }));
}
