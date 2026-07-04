/**
 * Base URL for a fire-and-forget call to our own function (Phase C.2 self-invoke).
 *
 * Deliberately the host the request arrived on, NOT VERCEL_URL: VERCEL_URL is the
 * auto-generated per-deployment URL, which sits behind Vercel Authentication
 * (Deployment Protection) — a fetch there 302s to the SSO wall and the target
 * route is never invoked, silently (observed 2026-07-04). Slack reaches us
 * through the public production alias, so the incoming host is the one origin
 * known to be publicly routable to this deployment. https is forced because the
 * proxied Host can surface as http behind the edge; localhost keeps its scheme
 * and port for dev.
 */
export function selfOrigin(req: Request): string {
  const url = new URL(req.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return url.origin;
  return `https://${url.host}`;
}
