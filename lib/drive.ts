/**
 * Typed Google Drive client. SERVER-ONLY.
 *
 * The service-account key is read from process.env.GOOGLE_SERVICE_ACCOUNT_KEY
 * (base64 of the JSON key) and never reaches the browser — the `server-only`
 * import makes an accidental client import a build error. The CLI runs Node
 * with `--conditions=react-server` so this import resolves to its empty module.
 *
 * Not unit-tested (network + secrets), mirroring lib/vimeo.ts. All shaping that
 * IS testable lives in lib/driveExport.ts and lib/driveManifest.ts.
 */
import "server-only";
import { JWT } from "google-auth-library";
import { extractFileId, type DriveSource } from "./driveManifest";
import { buildExportUrl, metadataUrl, normalizeExport } from "./driveExport";

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

let cachedClient: JWT | null = null;

function client(): JWT {
  if (cachedClient) return cachedClient;
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!b64) {
    throw new DriveError("GOOGLE_SERVICE_ACCOUNT_KEY is not set on the server.");
  }
  let key: { client_email: string; private_key: string };
  try {
    key = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (e) {
    throw new DriveError(
      `GOOGLE_SERVICE_ACCOUNT_KEY is not valid base64 JSON: ${(e as Error).message}`,
    );
  }
  cachedClient = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [SCOPE],
  });
  return cachedClient;
}

async function authedFetch(url: string): Promise<Response> {
  const headers = await client().getRequestHeaders(url);
  const res = await fetch(url, { headers, cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DriveError(
      `Drive returned ${res.status} ${res.statusText} for ${url}${
        body ? `: ${body.slice(0, 300)}` : ""
      }`,
      res.status,
    );
  }
  return res;
}

/** Fetch the export bytes for a source plus the file's current modifiedTime. */
export async function fetchExport(
  source: DriveSource,
): Promise<{ text: string; modifiedTime: string }> {
  const [res, modifiedTime] = await Promise.all([
    authedFetch(buildExportUrl(source)),
    fetchModifiedTime(source),
  ]);
  return { text: normalizeExport(await res.text()), modifiedTime };
}

/** Fetch only the Drive modifiedTime for a source (used by --check). */
export async function fetchModifiedTime(source: DriveSource): Promise<string> {
  const res = await authedFetch(metadataUrl(extractFileId(source.url)));
  const { modifiedTime } = (await res.json()) as { modifiedTime: string };
  return modifiedTime;
}
