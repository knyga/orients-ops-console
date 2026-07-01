/**
 * Shared effect: apply a CONFIRMED confirm-first instruction to a published
 * verdict, routing by axis to the right primitive. SERVER-ONLY (writes to Slack +
 * DB). Called by BOTH the events webhook (after an approver confirms) and the
 * `field-instructions` CLI (the operator running --write is the confirmation).
 *
 * Each axis is responsible for its own Ukrainian ack, so callers do not double-ack:
 *  - day        → applyApproverDecision (strikes the body + acks)
 *  - crew/elig  → applyRosterDecision   (edits the 👥 suffix + acks)
 *  - dataset    → upsertResolution(dataset) + ack
 *  - video      → upsertResolution(video, accepted_exception) + ack
 *  - airborne   → upsertAirborneOverride + ack (body re-renders on next field-verdict)
 * Idempotent via the primitives' own guards + content-rev outbound keys.
 */
import "server-only";
import { postMessage } from "./slack";
import { contentRev, instructionAckKey, type SendTrigger } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { type PublishedEntry } from "./published";
import { upsertResolution } from "./resolutions";
import { upsertAirborneOverride } from "./airborneOverrides";
import { applyApproverDecision } from "./applyApproval";
import { applyRosterDecision } from "./applyRosterCorrection";
import { buildRosterOutcome } from "./instructionOutcome";
import { parseRosterSuffix } from "./verdictPublish";
import { resolveInitial, SEED_ALIASES } from "./fieldRoster";
import { mergeAliases, readAliases } from "./rosterAliases";
import type { InstructionAxis, InstructionClassification } from "./instructionClassifyPrompt";
import type { Period } from "./period";

export interface ApplyInstructionArgs {
  entry: PublishedEntry;
  period: Period;
  axis: InstructionAxis;
  instruction: InstructionClassification;
  by: string; // approver name
  evidence: string; // permalink to the deciding reply (or "")
  trigger?: SendTrigger;
}

async function resolveNames(tokens: string[] | undefined): Promise<string[] | undefined> {
  if (!tokens || tokens.length === 0) return tokens;
  const aliases = mergeAliases(SEED_ALIASES, await readAliases());
  return tokens.map((t) => {
    const r = resolveInitial(t, aliases);
    return "name" in r ? r.name : r.unknown;
  });
}

async function ack(entry: PublishedEntry, text: string, axis: string, trigger: SendTrigger): Promise<boolean> {
  const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
  if (!channel) return false;
  await postMessage(
    channel.id,
    text,
    { key: instructionAckKey(entry.date, axis, contentRev(text)), feature: "instruction", channel: channel.name, trigger },
    entry.ts,
  );
  return true;
}

/** Apply one confirmed instruction. Returns whether an effect landed. */
export async function applyInstruction(args: ApplyInstructionArgs): Promise<{ applied: boolean }> {
  const { entry, period, axis, instruction: c, by, evidence, trigger = "unknown" } = args;

  if (axis === "day") {
    if (c.decision !== "accepted_exception" && c.decision !== "rejected") return { applied: false };
    const res = await applyApproverDecision({ entry, period, decision: c.decision, by, reason: c.reason, evidence, trigger });
    return { applied: res.applied };
  }

  if (axis === "crew" || axis === "eligibility") {
    const baseline = parseRosterSuffix(entry.text);
    const resolved: InstructionClassification = {
      ...c,
      roster: await resolveNames(c.roster),
      add: await resolveNames(c.add),
      remove: await resolveNames(c.remove),
      counted: await resolveNames(c.counted),
      notCounted: await resolveNames(c.notCounted),
    };
    const outcome = buildRosterOutcome(baseline, resolved, by, evidence);
    return applyRosterDecision({ entry, period, outcome, trigger });
  }

  if (axis === "dataset") {
    const decision = c.datasetStatus === "DECLINED" ? "rejected" : "accepted_exception";
    await upsertResolution({ date: entry.date, axis: "dataset", decision, note: c.reason, source: evidence || "slack", recordedAt: new Date().toISOString(), by });
    const label = decision === "rejected" ? "датасет ⛔ причину відхилено" : "датасет 📝 виняток (не потрібен)";
    const applied = await ack(entry, `📝 Зафіксовано: ${label} — ${by}. Причина: ${c.reason}`, "dataset", trigger);
    return { applied };
  }

  if (axis === "video") {
    await upsertResolution({ date: entry.date, axis: "video", decision: "accepted_exception", note: c.reason, source: evidence || "slack", recordedAt: new Date().toISOString(), by });
    const applied = await ack(entry, `🎥 Зафіксовано: відео зараховано (виняток) — ${by}. Причина: ${c.reason}`, "video", trigger);
    return { applied };
  }

  // airborne
  if (typeof c.airborneMinutes !== "number") return { applied: false };
  await upsertAirborneOverride({ date: entry.date, minutes: c.airborneMinutes, note: c.reason, by, source: evidence || "slack", recordedAt: new Date().toISOString() });
  const applied = await ack(entry, `✈️ Зафіксовано час у повітрі: ${c.airborneMinutes.toFixed(0)} хв — ${by}. Причина: ${c.reason}`, "airborne", trigger);
  return { applied };
}
