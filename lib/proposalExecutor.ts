/**
 * Deterministic confirm-first executor: given a resolved proposal (kind + params)
 * perform the Jira/Calendar write and return a Ukrainian result line. This is the ONE apply
 * path — shared by the CLI (`npm run agent --yes`) and the Slack confirm (`так`),
 * so a proposal that survives a DB round-trip (lib/agentProposals) applies exactly
 * like the in-memory CLI path. No LLM here; the model already resolved the params.
 *
 * SERVER-ONLY reachable (lib/jira reads JIRA_* env).
 */
import {
  createIssue,
  addComment,
  transitionIssue,
  updateIssue,
  listSprints,
  createSprint,
  moveIssueToSprint,
} from "@/lib/jira";
import { createCalendarEvent } from "@/lib/googleCalendar";
import { renderAppliedUk } from "@/lib/calendarEvent";
import { upsertLossRecord } from "@/lib/lossStore";
import { readPublished } from "@/lib/published";
import { parsePeriodKey } from "@/lib/period";
import { TRACKED_CHANNELS } from "@/lib/slackChannels";
import { postMessage } from "@/lib/slack";
import { contentRev, instructionAckKey } from "@/lib/outboundKeys";
import { reportKey } from "@/lib/fieldDayVerdict";
import { APPROVERS } from "@/lib/approvers";
import { mentionize } from "./mention";

export type ProposalKind =
  | "jira_create"
  | "jira_comment"
  | "jira_transition"
  | "jira_update"
  | "jira_move_to_sprint"
  | "calendar_create_event"
  | "field_loss_set";

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing required "${key}".`);
  return v;
}

function nonEmptyStringArray(params: Record<string, unknown>, key: string): string[] {
  const v = params[key];
  if (!Array.isArray(v) || v.length === 0 || !v.every((e) => typeof e === "string" && e.trim())) {
    throw new Error(`Missing required "${key}".`);
  }
  return v as string[];
}

/** Resolve a (possibly to-be-created) sprint to an id and move the issue in.
 *  A null sprintId re-checks by name first — the sprint may have appeared
 *  between propose and confirm. Returns whether it had to create the sprint. */
async function resolveAndMove(
  boardId: number,
  sprintId: number | null,
  sprintName: string,
  key: string,
): Promise<boolean> {
  let created = false;
  if (sprintId === null) {
    const future = await listSprints(boardId, "future");
    const existing = future.find((s) => s.name.trim().toLowerCase() === sprintName.trim().toLowerCase());
    if (existing) {
      sprintId = existing.id;
    } else {
      sprintId = (await createSprint(boardId, sprintName)).id;
      created = true;
    }
  }
  await moveIssueToSprint(sprintId, key);
  return created;
}

/** Best-effort Ukrainian ack in the day's earliest published verdict thread —
 *  the visible activity log for an agent-applied loss change. Never throws:
 *  the ledger row is the substance; a missing/unpublished day just skips. */
async function ackLossInVerdictThread(date: string, text: string): Promise<void> {
  try {
    const period = parsePeriodKey(date.slice(0, 7));
    if (!period) return;
    const log = await readPublished(period);
    const entries = Object.values(log)
      .filter((e) => e.date === date)
      .sort((a, b) => (a.reportTs ?? "").localeCompare(b.reportTs ?? ""));
    const entry = entries[0];
    if (!entry) return;
    const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
    if (!channel) return;
    await postMessage(
      channel.id,
      text,
      { key: instructionAckKey(reportKey(date, entry.reportTs), "loss", contentRev(text)), feature: "instruction", channel: channel.name, trigger: "unknown" },
      entry.ts,
    );
  } catch (err) {
    console.error("field_loss_set: verdict-thread ack failed:", err);
  }
}

export async function applyProposal(kind: ProposalKind, params: Record<string, unknown>): Promise<string> {
  switch (kind) {
    case "jira_create": {
      const accountId = params.assigneeAccountId;
      const created = await createIssue({
        projectKey: str(params, "projectKey"),
        summary: str(params, "summary"),
        description: typeof params.description === "string" ? params.description : "",
        assigneeAccountId: typeof accountId === "string" ? accountId : null,
      });
      const createdLine = `✅ Створено ${created.key}: ${created.url}`;
      const sprint = params.nextSprint as
        | { boardId: number; sprintId: number | null; sprintName: string }
        | undefined;
      if (!sprint) return createdLine;
      // The ticket exists — a sprint failure must not hide that.
      try {
        await resolveAndMove(sprint.boardId, sprint.sprintId, sprint.sprintName, created.key);
        return `${createdLine}\nДодано до спринту «${sprint.sprintName}»`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `${createdLine}\n⚠️ Але не вдалося додати до спринту «${sprint.sprintName}»: ${message}`;
      }
    }
    case "jira_comment":
      await addComment(str(params, "key"), str(params, "body"));
      return `✅ Коментар додано до ${str(params, "key")}`;
    case "jira_transition":
      await transitionIssue(str(params, "key"), str(params, "transitionId"));
      return `✅ ${str(params, "key")} переведено`;
    case "jira_update": {
      const fields = (params.fields ?? {}) as Record<string, unknown>;
      await updateIssue(str(params, "key"), fields);
      return `✅ ${str(params, "key")} оновлено`;
    }
    case "jira_move_to_sprint": {
      const key = str(params, "key");
      const sprintName = str(params, "sprintName");
      const boardId = typeof params.boardId === "number" ? params.boardId : Number(params.boardId);
      const sprintId = typeof params.sprintId === "number" ? params.sprintId : null;
      const created = await resolveAndMove(boardId, sprintId, sprintName, key);
      return created
        ? `✅ ${key} додано до спринту «${sprintName}» (спринт створено)`
        : `✅ ${key} додано до спринту «${sprintName}»`;
    }
    case "calendar_create_event": {
      const created = await createCalendarEvent({
        title: str(params, "title"),
        description: typeof params.description === "string" ? params.description : "",
        startIso: str(params, "startIso"),
        endIso: str(params, "endIso"),
        attendeeEmails: nonEmptyStringArray(params, "attendeeEmails"),
        requestId: str(params, "requestId"),
      });
      return renderAppliedUk(created);
    }
    case "field_loss_set": {
      const date = str(params, "date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`field_loss_set: date must be YYYY-MM-DD, got "${date}"`);
      const state = params.state === "found" || params.state === "lost" ? params.state : null;
      if (!state) throw new Error(`field_loss_set: state must be "found" or "lost"`);
      const by = typeof params.by === "string" && params.by ? params.by : APPROVERS[0].name;
      const note =
        typeof params.note === "string" && params.note.trim()
          ? params.note.trim()
          : state === "found"
            ? "борт знайшли (через агента)"
            : "борт втрачено (через агента)";
      await upsertLossRecord({
        date,
        reportTs: "", // day-wide — same shape as `field-instructions --loss`
        lost: true,
        found: state === "found",
        note,
        source: "instruction",
        crashTextHash: null,
        updatedAt: new Date().toISOString(),
        updatedBy: by,
      });
      const who = mentionize(by);
      const ack =
        state === "found"
          ? `🛸 Зафіксовано: борт знайдено — втрату за ${date} знято — ${who}. Причина: ${note}`
          : `🛸 Зафіксовано: борт за ${date} втрачено (не знайдено) — ${who}. Причина: ${note}`;
      await ackLossInVerdictThread(date, ack);
      return state === "found"
        ? `🛸 Зафіксовано: борт знайдено — втрату за ${date} знято.`
        : `🛸 Зафіксовано: борт за ${date} втрачено (не знайдено).`;
    }
    default:
      throw new Error(`Unknown proposal kind: ${kind}`);
  }
}
