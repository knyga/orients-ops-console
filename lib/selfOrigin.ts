/** Base URL for a fire-and-forget call to our own function (Phase C.2 self-invoke). */
export function selfOrigin(req: Request): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return new URL(req.url).origin;
}
