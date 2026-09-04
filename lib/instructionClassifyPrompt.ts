/**
 * Pure prompt + tool schema for classifying an approver's verdict-thread reply
 * into ONE data-overwrite instruction across every axis, OR a confirmation /
 * cancellation of a pending proposal. One forced tool-call per Slack event (the
 * 3s webhook budget allows exactly one Claude call). Server-only-free so it
 * unit-tests (mirrors lib/rosterCorrectionClassifyPrompt.ts).
 *
 * Axes: crew / eligibility / day (accept-reject) / dataset / video / airborne / loss.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type InstructionIntent = "confirm" | "cancel" | "instruction" | "unclear";
export type InstructionAxis = "crew" | "eligibility" | "day" | "dataset" | "video" | "airborne" | "loss";

export interface InstructionClassification {
  intent: InstructionIntent;
  axis?: InstructionAxis;
  // crew / eligibility
  roster?: string[]; // crew: full authoritative crew (set)
  add?: string[]; // crew: add to the crew
  remove?: string[]; // crew: remove from the crew
  counted?: string[]; // eligibility: count for the bonus this day
  notCounted?: string[]; // eligibility: do NOT count this day (kept on crew)
  early?: boolean; // crew/eligibility: count the trip as an early departure (+200) / deny it
  // day
  decision?: "accepted_exception" | "rejected";
  // dataset
  datasetStatus?: "WAIVED" | "DECLINED";
  // video
  videoWaive?: boolean;
  // airborne
  airborneMinutes?: number;
  // loss
  lossState?: "found" | "lost";
  reason: string;
}

export const CLASSIFY_INSTRUCTION_TOOL: Anthropic.Tool = {
  name: "classify_instruction",
  description:
    "Classify an authorized approver's reply in a flight-day verdict thread as a single data-overwrite " +
    "instruction (crew / eligibility / day accept-reject / dataset / video / airborne minutes / drone loss), or as a " +
    "confirmation / cancellation of the pending proposal, or unclear.",
  input_schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: ["confirm", "cancel", "instruction", "unclear"],
        description:
          "confirm = approves the PENDING proposal shown; cancel = rejects the PENDING proposal; " +
          "instruction = a new data change (set axis + payload); unclear = a question/comment that changes nothing",
      },
      axis: {
        type: "string",
        enum: ["crew", "eligibility", "day", "dataset", "video", "airborne", "loss"],
        description: "instruction only: which datum to overwrite",
      },
      roster: { type: "array", items: { type: "string" }, description: "crew: full authoritative crew (names/initials)" },
      add: { type: "array", items: { type: "string" }, description: "crew: people to add" },
      remove: { type: "array", items: { type: "string" }, description: "crew: people to remove" },
      counted: { type: "array", items: { type: "string" }, description: "eligibility: people to COUNT for the bonus this day" },
      notCounted: { type: "array", items: { type: "string" }, description: "eligibility: people NOT to count this day (kept on crew)" },
      early: { type: "boolean", description: "crew/eligibility: true when the approver says the day counts as an early departure (ранній виїзд), false to deny it; omit otherwise" },
      decision: {
        type: "string",
        enum: ["accepted_exception", "rejected"],
        description: "day: accept the flagged day as an exception, or reject/veto it",
      },
      datasetStatus: {
        type: "string",
        enum: ["WAIVED", "DECLINED"],
        description: "dataset: waive the missing #datasets notice, or decline the stated reason",
      },
      videoWaive: { type: "boolean", description: "video: true to forgive the < 50% video coverage for the day" },
      airborneMinutes: { type: "number", description: "airborne: the corrected airborne minutes for the day" },
      lossState: {
        type: "string",
        enum: ["found", "lost"],
        description: "loss: found = the lost drone was recovered (the loss no longer counts); lost = confirm it is permanently lost",
      },
      reason: { type: "string", description: "Short factual summary of the correction (or why it is a confirm/cancel/unclear)" },
    },
    required: ["intent", "reason"],
  },
};

/**
 * The classify tool, with the `intent` enum narrowed to instruction/unclear when
 * there is no pending proposal — confirm/cancel are only meaningful against one.
 * Without this, «відмінити, немає звіту» on a bare thread classifies as a
 * "cancel" of a nonexistent proposal and noops silently instead of rejecting the day.
 */
export function classifyInstructionTool(pendingEcho: string | null): Anthropic.Tool {
  if (pendingEcho) return CLASSIFY_INSTRUCTION_TOOL;
  const schema = CLASSIFY_INSTRUCTION_TOOL.input_schema as { properties: Record<string, unknown> };
  const intent = schema.properties.intent as { enum: string[]; description: string };
  return {
    ...CLASSIFY_INSTRUCTION_TOOL,
    input_schema: {
      ...CLASSIFY_INSTRUCTION_TOOL.input_schema,
      properties: {
        ...schema.properties,
        intent: {
          ...intent,
          enum: ["instruction", "unclear"],
          description:
            "instruction = a data change (set axis + payload); unclear = a question/comment that changes nothing",
        },
      },
    },
  };
}

export function buildInstructionPrompt(
  verdictMessage: string,
  reply: string,
  pendingEcho: string | null,
): string {
  const lines = [
    `You are reconciling a drone field-ops bonus. The bot posted a per-day verdict (it lists the crew`,
    `"👥 У полі: …"), and an AUTHORIZED approver replied in the thread. Decide what the reply means, then`,
    `call classify_instruction.`,
    ``,
    `BOT VERDICT MESSAGE:`,
    verdictMessage,
    ``,
  ];
  if (pendingEcho) {
    lines.push(
      `THERE IS A PROPOSAL ОЧІКУЄ ПІДТВЕРДЖЕННЯ (awaiting confirmation) — the bot already echoed this change`,
      `and is waiting for the approver to confirm or reject it:`,
      `  «${pendingEcho}»`,
      `If the reply agrees ("так", "ок", "підтверджую", "+", "давай", "вірно", 👍) → intent="confirm".`,
      `If it disagrees ("ні", "скасуй", "не треба", "відміна") → intent="cancel".`,
      `If it is a DIFFERENT change → intent="instruction" (a new proposal replaces the pending one).`,
      ``,
    );
  } else {
    lines.push(
      `НЕМАЄ pending proposal (nothing is awaiting confirmation), so the reply can only be a new`,
      `instruction or unclear. Wording that annuls the day itself — «відмінити», «скасувати»,`,
      `«не зараховувати», e.g. «відмінити, немає звіту» — is a day rejection: intent="instruction",`,
      `axis="day", decision="rejected".`,
      ``,
    );
  }
  lines.push(
    `APPROVER REPLY:`,
    reply,
    ``,
    `Instruction guidance (Ukrainian or English) — pick ONE axis:`,
    `- crew: "склад: Тарас, Влад" → axis="crew", roster=[…]; "додай Тараса" → add=["Тарас"]; "прибери Влада"/"Влада не було" → remove=["Влад"].`,
    `- eligibility: "Данило не рахується цього дня" → axis="eligibility", notCounted=["Данило"]; "Тарасу зарахуй" → counted=["Тарас"].`,
    `- day: "зараховуємо, форс-мажор"/"day approved" → axis="day", decision="accepted_exception"; "ні, не прийнято"/"день не зараховано" → axis="day", decision="rejected".`,
    `- dataset: "датасет не потрібен цього дня" → axis="dataset", datasetStatus="WAIVED"; "причина не приймається" → datasetStatus="DECLINED".`,
    `- video: "відео можна не рахувати"/"нормально що менше відео" → axis="video", videoWaive=true.`,
    `- airborne: "в повітрі було 133 хв"/"насправді 90 хвилин у польоті" → axis="airborne", airborneMinutes=133.`,
    `- loss: "борт знайшли"/"дрон знайдено" → axis="loss", lossState="found"; "борт втрачено остаточно"/"не знайшли, списуємо" → axis="loss", lossState="lost".`,
    `- unclear: a question or comment that does not itself state a change ("тільки ти був?", "де звіт?").`,
    `Return people as written (names or single-initial); the caller resolves initials. Return only the tool call.`,
  );
  return lines.join("\n");
}

// --- Role-narrowed thread-reply classifier (evidence / claim / chat) ------------------
//
// Extends the approver-only instruction classifier above so ANY human's reply
// (approver or pilot) in a verdict thread can be classified. The model never
// decides WHO may do what: the tool schema is narrowed per role (a pilot's
// schema literally cannot express confirm/cancel/instruction), and
// coerceThreadReply is the deterministic backstop over whatever the model
// returns anyway.

import type { ReplyHints } from "./threadReplyHints";

export type ReplyRole = "approver" | "pilot";
export type ThreadReplyIntent = InstructionIntent | "evidence" | "claim" | "chat";
export interface EvidenceItem { kind: "video" | "dataset"; links: string[] }
export interface ClaimItem {
  kind: "explanation" | "deploy_window" | "airborne" | "loss_found";
  deployWindow?: { start: string; end: string };
  airborneMinutes?: number;
  /** The pilot's words (short, verbatim-ish) — becomes the proposal note. */
  text: string;
}
export interface ThreadReplyClassification extends Omit<InstructionClassification, "intent"> {
  intent: ThreadReplyIntent;
  evidence?: EvidenceItem[];
  claim?: ClaimItem;
}

/** The intents a role may return. Pilots never get confirm/cancel/instruction;
 *  confirm/cancel exist only against a pending proposal (existing rule). */
export function allowedIntents(role: ReplyRole, pendingEcho: string | null): ThreadReplyIntent[] {
  const common: ThreadReplyIntent[] = ["evidence", "claim", "chat", "unclear"];
  if (role === "pilot") return common;
  return [...(pendingEcho ? (["confirm", "cancel"] as ThreadReplyIntent[]) : []), "instruction", ...common];
}

const CLAIM_KINDS = ["explanation", "deploy_window", "airborne", "loss_found"] as const;

export function classifyThreadReplyTool(role: ReplyRole, pendingEcho: string | null): Anthropic.Tool {
  const base = CLASSIFY_INSTRUCTION_TOOL.input_schema as { properties: Record<string, unknown>; required: string[] };
  const intents = allowedIntents(role, pendingEcho);
  return {
    name: "classify_thread_reply",
    description:
      "Classify a human reply in a flight-day verdict thread: verifiable evidence (Vimeo video / #datasets notice), " +
      "an unverifiable claim (deploy window, airborne minutes, drone found, an explanation), " +
      (role === "approver" ? "an approver instruction / confirm / cancel, " : "") +
      "a chat question/comment, or unclear noise.",
    input_schema: {
      type: "object",
      properties: {
        ...base.properties,
        intent: {
          type: "string",
          enum: intents,
          description:
            "evidence = asserts data now exists in Vimeo or #datasets; claim = asserts something we cannot re-check; " +
            "chat = a question/comment asserting no data; unclear = noise" +
            (role === "approver" ? "; instruction = a data change (set axis + payload)" : "") +
            (pendingEcho && role === "approver" ? "; confirm/cancel = answers the PENDING proposal" : ""),
        },
        evidence: {
          type: "array",
          description: "evidence: what can be re-checked. kind=video (Vimeo) or dataset (#datasets). links = URLs quoted in the reply.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["video", "dataset"] },
              links: { type: "array", items: { type: "string" } },
            },
            required: ["kind", "links"],
          },
        },
        claim: {
          type: "object",
          description: "claim (may accompany evidence): the unverifiable part of the reply.",
          properties: {
            kind: { type: "string", enum: [...CLAIM_KINDS] },
            deployWindow: {
              type: "object",
              properties: { start: { type: "string" }, end: { type: "string" } },
              required: ["start", "end"],
            },
            airborneMinutes: { type: "number" },
            text: { type: "string", description: "the pilot's words, short" },
          },
          required: ["kind", "text"],
        },
      },
      required: base.required,
    },
  };
}

export function buildThreadReplyPrompt(
  verdictMessage: string,
  reply: string,
  pendingEcho: string | null,
  role: ReplyRole,
  hints: ReplyHints,
): string {
  const lines = [
    `You are reconciling a drone field-ops bonus. The bot posted a per-day verdict and a human replied in the thread.`,
    `The replier is ${role === "approver" ? "an AUTHORIZED APPROVER" : "a PILOT / team member (NOT an approver — they can provide evidence or claims, never decide)"}.`,
    `Decide what the reply means, then call classify_thread_reply.`,
    ``,
    `BOT VERDICT MESSAGE:`,
    verdictMessage,
    ``,
  ];
  if (pendingEcho && role === "approver") {
    lines.push(
      `THERE IS A PROPOSAL awaiting confirmation — the bot already echoed this change:`,
      `  «${pendingEcho}»`,
      `If the reply agrees ("так", "ок", "підтверджую", "+", "давай", 👍) → intent="confirm". If it disagrees ("ні", "скасуй", "не треба") → intent="cancel".`,
      ``,
    );
  }
  const hintLines: string[] = [];
  if (hints.vimeoLinks.length) hintLines.push(`- Vimeo links: ${hints.vimeoLinks.map((v) => v.url).join(", ")} → this IS video evidence.`);
  if (hints.datasetPermalinks.length) hintLines.push(`- #datasets permalinks: ${hints.datasetPermalinks.map((d) => d.url).join(", ")} → this IS dataset evidence.`);
  if (hints.timeRanges.length) hintLines.push(`- time ranges: ${hints.timeRanges.map((r) => `${r.start}–${r.end}`).join(", ")} → likely a deploy_window claim.`);
  if (hints.minuteFigures.length) hintLines.push(`- minute figures: ${hints.minuteFigures.join(", ")} → possibly an airborne claim.`);
  if (hintLines.length) lines.push(`DETECTED HINTS:`, ...hintLines, ``);
  lines.push(
    `HUMAN REPLY:`,
    reply,
    ``,
    `Guidance:`,
    `- evidence: "залив відео", "відео на Vimeo", a Vimeo link → kind=video; "датасет запостив", a #datasets link → kind=dataset. Only these two kinds exist.`,
    `- claim: "виїзд був 09:00–15:40" → kind=deploy_window (+deployWindow); "у повітрі 140 хв" → kind=airborne (+airborneMinutes);`,
    `  "борт знайшли" → kind=loss_found; weather / recorder failure / "ми літали" / any reason to accept → kind=explanation. text = their words.`,
    `- A reply can carry BOTH evidence and a claim ("залив відео, а датасету не було, бо дощ") → intent=evidence, fill evidence AND claim.`,
    `- chat: a question or comment that states no data ("що ще бракує?", "чому 40%?", "де подивитись?").`,
    `- unclear: noise ("ok", an emoji alone).`,
  );
  if (role === "approver") {
    lines.push(
      `- instruction (approver only): a directive to change data — crew ("склад: Тарас, Влад"), eligibility, day accept/reject ("зараховуємо", "відхилити"),`,
      `  dataset waive/decline, video waive, airborne minutes ("в повітрі було 133 хв" FROM AN APPROVER is an instruction, not a claim), loss found/lost.`,
    );
  } else {
    lines.push(`- A pilot writing "прийняти день" / "зарахуйте" is NOT an instruction — it is a claim (kind=explanation).`);
  }
  lines.push(`Return only the tool call.`);
  return lines.join("\n");
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Deterministic backstop over the model output: role gate, hint hard-rules, shape validation. */
export function coerceThreadReply(
  raw: Record<string, unknown>,
  role: ReplyRole,
  pendingEcho: string | null,
  hints: ReplyHints,
): ThreadReplyClassification {
  const allowed = allowedIntents(role, pendingEcho);
  let intent: ThreadReplyIntent = allowed.includes(raw.intent as ThreadReplyIntent) ? (raw.intent as ThreadReplyIntent) : "unclear";

  // Evidence: model items ∪ hint hard-rules (hint links win; dedupe by kind).
  const modelEvidence = Array.isArray(raw.evidence)
    ? (raw.evidence as unknown[]).flatMap((e) => {
        const o = e as { kind?: unknown; links?: unknown };
        if (o.kind !== "video" && o.kind !== "dataset") return [];
        return [{ kind: o.kind, links: Array.isArray(o.links) ? o.links.map(String) : [] } as EvidenceItem];
      })
    : [];
  const byKind = new Map<EvidenceItem["kind"], Set<string>>();
  for (const e of modelEvidence) byKind.set(e.kind, new Set([...(byKind.get(e.kind) ?? []), ...e.links]));
  if (hints.vimeoLinks.length) byKind.set("video", new Set([...(byKind.get("video") ?? []), ...hints.vimeoLinks.map((v) => v.url)]));
  if (hints.datasetPermalinks.length) byKind.set("dataset", new Set([...(byKind.get("dataset") ?? []), ...hints.datasetPermalinks.map((d) => d.url)]));
  const evidence = [...byKind].map(([kind, links]) => ({ kind, links: [...links] }));

  // Claim shape.
  let claim: ClaimItem | undefined;
  const rc = raw.claim as Record<string, unknown> | undefined;
  if (rc && (CLAIM_KINDS as readonly string[]).includes(String(rc.kind))) {
    const dw = rc.deployWindow as { start?: unknown; end?: unknown } | undefined;
    claim = {
      kind: rc.kind as ClaimItem["kind"],
      text: str(rc.text) ?? str(raw.reason) ?? "",
      ...(dw && str(dw.start) && str(dw.end) ? { deployWindow: { start: str(dw.start)!, end: str(dw.end)! } } : {}),
      ...(typeof rc.airborneMinutes === "number" && Number.isFinite(rc.airborneMinutes) ? { airborneMinutes: rc.airborneMinutes } : {}),
    };
  }

  // A pilot's instruction-shaped text is a claim, never an instruction.
  if (role === "pilot" && raw.intent === "instruction") {
    intent = "claim";
    claim = claim ?? { kind: "explanation", text: str(raw.reason) ?? "" };
  }

  // An approver's decisive confirm/cancel/instruction outranks hint-forced evidence
  // (spec §3.3 priority: confirm/cancel → instruction → verify) — a reply like
  // «так, ось відео https://vimeo.com/42» must still apply the pending confirm, not
  // get silently downgraded to evidence and lose the decision. Pilots never reach
  // this branch with a decisive intent (their schema excludes confirm/cancel/
  // instruction, and the block above already converted a raw "instruction" to a
  // claim), so for them hint-forced evidence still wins over everything.
  const isDecisive = intent === "confirm" || intent === "cancel" || intent === "instruction";
  if (evidence.length && !isDecisive) intent = "evidence";
  else if (!evidence.length && intent === "evidence") intent = claim ? "claim" : "unclear";
  if (intent === "claim" && !claim) intent = "unclear";

  return {
    ...(role === "approver" && intent === "instruction" ? pickInstructionFields(raw) : {}),
    intent,
    ...(evidence.length ? { evidence } : {}),
    ...(claim ? { claim } : {}),
    reason: String(raw.reason ?? ""),
  };
}

const VALID_AXES: InstructionAxis[] = ["crew", "eligibility", "day", "dataset", "video", "airborne", "loss"];
const arr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined;

/** The existing per-axis payload fields (same rules as classifyInstruction's narrowing). */
function pickInstructionFields(raw: Record<string, unknown>): Omit<InstructionClassification, "intent" | "reason"> {
  return {
    axis: VALID_AXES.includes(raw.axis as InstructionAxis) ? (raw.axis as InstructionAxis) : undefined,
    roster: arr(raw.roster), add: arr(raw.add), remove: arr(raw.remove), counted: arr(raw.counted), notCounted: arr(raw.notCounted),
    decision: raw.decision === "accepted_exception" || raw.decision === "rejected" ? raw.decision : undefined,
    datasetStatus: raw.datasetStatus === "WAIVED" || raw.datasetStatus === "DECLINED" ? raw.datasetStatus : undefined,
    videoWaive: raw.videoWaive === true ? true : undefined,
    airborneMinutes: typeof raw.airborneMinutes === "number" && Number.isFinite(raw.airborneMinutes) ? raw.airborneMinutes : undefined,
    lossState: raw.lossState === "found" || raw.lossState === "lost" ? raw.lossState : undefined,
  };
}
