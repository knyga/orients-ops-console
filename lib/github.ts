/**
 * Server-only entry point for dev reporting. SERVER-ONLY.
 *
 * Reads GH_ACCESS_TOKEN from process.env and delegates to the shared
 * lib/githubClient. The `server-only` import makes an accidental client import
 * a build error — the token must never reach the browser. The CLI
 * (scripts/github.ts) also imports this module, running Node with
 * `--conditions=react-server` so the `server-only` import resolves to a no-op
 * there. The browser still cannot import it (no such condition in the client
 * build), which keeps the token server-side.
 */
import "server-only";
import {
  fetchOrgActivity,
  GitHubError,
  type OrgActivity,
} from "./githubClient";

/** The org all dev reporting covers (github.com/orients-ai). */
export const ORG = "orients-ai";

function token(): string {
  const value = process.env.GH_ACCESS_TOKEN;
  if (!value) {
    throw new GitHubError("GH_ACCESS_TOKEN is not set on the server.");
  }
  return value;
}

/** Fetch org activity for the period using the server-side token. */
export function fetchOrgActivityForPeriod(
  start: string,
  end: string,
): Promise<OrgActivity> {
  return fetchOrgActivity({ token: token(), org: ORG, start, end });
}

export { GitHubError };
