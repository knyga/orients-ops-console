/**
 * Authorize a Vercel Cron request. Vercel injects `Authorization: Bearer
 * <CRON_SECRET>` on scheduled invocations when CRON_SECRET is set in the project
 * env; the cron routes check it so they can't be triggered by anyone else. Fails
 * closed: no secret configured → unauthorized. Pure (no side effects).
 */
export function isAuthorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
