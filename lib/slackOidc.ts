/**
 * Slack OpenID Connect client (server-only). Builds the "Sign in with Slack"
 * authorize URL and exchanges the authorization code for an id_token over a
 * direct TLS backchannel. Reads SLACK_CLIENT_ID / SLACK_CLIENT_SECRET; the
 * secret must never reach the browser — `server-only` makes an accidental
 * client import a build error.
 */
import "server-only";

const AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";
const TOKEN_URL = "https://slack.com/api/openid.connect.token";

export function clientId(): string {
  const id = process.env.SLACK_CLIENT_ID;
  if (!id) throw new Error("SLACK_CLIENT_ID is not set");
  return id;
}

function clientSecret(): string {
  const secret = process.env.SLACK_CLIENT_SECRET;
  if (!secret) throw new Error("SLACK_CLIENT_SECRET is not set");
  return secret;
}

export function buildAuthorizeUrl(args: { state: string; nonce: string; redirectUri: string }): string {
  const params = new URLSearchParams({
    response_type: "code",
    scope: "openid email profile",
    client_id: clientId(),
    state: args.state,
    nonce: args.nonce,
    redirect_uri: args.redirectUri,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCode(args: { code: string; redirectUri: string }): Promise<{ idToken: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: clientId(),
    client_secret: clientSecret(),
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Slack token endpoint HTTP ${res.status}`);
  const json = (await res.json()) as { ok?: boolean; error?: string; id_token?: string };
  if (!json.ok || !json.id_token) throw new Error(`Slack token exchange failed: ${json.error ?? "no id_token"}`);
  return { idToken: json.id_token };
}
