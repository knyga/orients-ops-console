/**
 * Ops-failure alerts: DM the approvers when a bot action fails hard (born from
 * the 2026-08-31 incident where an expired Jira token made the bot silently
 * ignore every Jira-touching request — nobody was told).
 *
 * Best-effort by design: an alert failure must never mask or break the caller's
 * own error handling. Dedup rides the outbound chokepoint — `opsAlertKey`
 * (approver + Kyiv day + error class) means one DM per approver per day per
 * error class, however many events fail.
 *
 * Errors are classified by duck-typed `name`/`status` (not instanceof) so the
 * classifier stays import-light and works across module instances.
 */
import { openDm, postMessage } from "./slack";
import { APPROVERS } from "./approvers";
import { opsAlertKey, type SendTrigger } from "./outboundKeys";
import { FIELD_TIMEZONE } from "./reconcile";

interface NamedError {
  name?: unknown;
  status?: unknown;
  message?: unknown;
}

function parts(err: unknown): { name: string; status: number | undefined; message: string } {
  if (err instanceof Error) {
    const status = (err as NamedError).status;
    return { name: err.name, status: typeof status === "number" ? status : undefined, message: err.message };
  }
  return { name: "", status: undefined, message: String(err) };
}

/** True for a Jira 401/403 — the "token is dead" class worth alerting on from
 *  inside the agent tool loop, where other errors are fed back to the model. */
export function isAuthError(err: unknown): boolean {
  const { name, status } = parts(err);
  return name === "JiraError" && (status === 401 || status === 403);
}

/** Stable error-class key for dedup + display: `jira-auth`, `jira-500`,
 *  `slack-502`, `anthropic-config`, or `unknown:<origin>`. */
export function classifyError(err: unknown, origin: string): string {
  const { name, status, message } = parts(err);
  if (name === "JiraError") {
    if (status === 401 || status === 403) return "jira-auth";
    return `jira-${status ?? "unknown"}`;
  }
  if (name === "SlackError") return `slack-${status ?? "unknown"}`;
  if (message.includes("ANTHROPIC_API_KEY")) return "anthropic-config";
  return `unknown:${origin}`;
}

function kyivDay(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const HINTS: Record<string, string> = {
  "jira-auth": "Схоже, Jira токен недійсний або протух — перевірте JIRA_API_TOKEN.",
  "anthropic-config": "На сервері не налаштований ANTHROPIC_API_KEY.",
};

function formatAlert(errKey: string, origin: string, message: string): string {
  const hint = HINTS[errKey] ? `\n${HINTS[errKey]}` : "";
  return `⚠️ Помилка бота (${origin}): ${errKey}${hint}\n> ${message}`;
}

/**
 * DM every approver about a hard bot failure. Never throws; a per-approver DM
 * failure is logged and the rest still go out.
 */
export async function alertApprovers(
  err: unknown,
  origin: string,
  trigger: SendTrigger = "unknown",
): Promise<void> {
  const errKey = classifyError(err, origin);
  const day = kyivDay();
  const text = formatAlert(errKey, origin, parts(err).message);
  for (const approver of APPROVERS) {
    try {
      const dm = await openDm(approver.userId);
      await postMessage(dm, text, {
        key: opsAlertKey(approver.userId, day, errKey),
        feature: "ops-alert",
        channel: "dm",
        trigger,
      });
    } catch (dmErr) {
      console.error(`ops-alert: DM to ${approver.name} failed:`, dmErr);
    }
  }
}
