import { describe, expect, it } from "vitest";
import { CLASSIFY_INSTRUCTION_TOOL, buildInstructionPrompt, classifyInstructionTool } from "./instructionClassifyPrompt";

describe("instructionClassifyPrompt", () => {
  it("includes the verdict, the reply, and a pending-proposal echo when present", () => {
    const p = buildInstructionPrompt(
      "⚠️ 2026-06-25 — потрібна перевірка.\n👥 У полі: Влад.",
      "так",
      "Додати Тараса до складу 2026-06-25",
    );
    expect(p).toContain("Влад");
    expect(p).toContain("так");
    expect(p).toContain("Додати Тараса до складу 2026-06-25");
    expect(p).toContain("ОЧІКУЄ ПІДТВЕРДЖЕННЯ");
  });

  it("omits the pending block when there is no active proposal", () => {
    const p = buildInstructionPrompt("verdict", "додай Тараса", null);
    expect(p).not.toContain("ОЧІКУЄ ПІДТВЕРДЖЕННЯ");
  });

  it("exposes a tool covering all axes + confirm/cancel", () => {
    const props = CLASSIFY_INSTRUCTION_TOOL.input_schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining([
        "intent",
        "axis",
        "roster",
        "add",
        "remove",
        "counted",
        "notCounted",
        "decision",
        "datasetStatus",
        "videoWaive",
        "airborneMinutes",
        "reason",
      ]),
    );
    const intent = (CLASSIFY_INSTRUCTION_TOOL.input_schema.properties as Record<string, { enum?: string[] }>).intent;
    expect(intent.enum).toEqual(expect.arrayContaining(["confirm", "cancel", "instruction", "unclear"]));
  });

  // «відмінити, немає звіту» on a thread with NO pending proposal must be classifiable
  // only as an instruction (day-reject) or unclear — never a confirm/cancel of a
  // proposal that doesn't exist (2026-07-04: that combination noop'd silently).
  it("narrows the intent enum to instruction/unclear when no proposal is pending", () => {
    const tool = classifyInstructionTool(null);
    const intent = (tool.input_schema.properties as Record<string, { enum?: string[] }>).intent;
    expect(intent.enum).toEqual(["instruction", "unclear"]);
  });

  it("keeps the full intent enum when a proposal is pending", () => {
    const tool = classifyInstructionTool("Відхилити день 2026-06-24");
    const intent = (tool.input_schema.properties as Record<string, { enum?: string[] }>).intent;
    expect(intent.enum).toEqual(["confirm", "cancel", "instruction", "unclear"]);
  });

  it("maps day-annulment wording to a rejection instruction when nothing is pending", () => {
    const p = buildInstructionPrompt("verdict", "відмінити, немає звіту", null);
    expect(p).toContain("НЕМАЄ pending proposal");
    expect(p).toContain("«відмінити»");
    expect(p).toContain('decision="rejected"');
  });

  it("the tool schema carries the loss axis + lossState", () => {
    const schema = CLASSIFY_INSTRUCTION_TOOL.input_schema as {
      properties: { axis: { enum: string[] }; lossState: { enum: string[] } };
    };
    expect(schema.properties.axis.enum).toContain("loss");
    expect(schema.properties.lossState.enum).toEqual(["found", "lost"]);
  });

  it("the prompt guides the loss axis", () => {
    const p = buildInstructionPrompt("verdict", "борт знайшли", null);
    expect(p).toContain('axis="loss"');
    expect(p).toContain('lossState="found"');
  });
});

import { allowedIntents, classifyThreadReplyTool, coerceThreadReply, buildThreadReplyPrompt } from "./instructionClassifyPrompt";
import type { ReplyHints } from "./threadReplyHints";

const noHints: ReplyHints = { vimeoLinks: [], datasetPermalinks: [], timeRanges: [], minuteFigures: [] };

describe("thread-reply classifier — role-narrowed schema", () => {
  it("pilot schema never offers confirm/cancel/instruction, even with a pending echo", () => {
    expect(allowedIntents("pilot", "прийняти день")).toEqual(["evidence", "claim", "chat", "unclear"]);
    const tool = classifyThreadReplyTool("pilot", "прийняти день");
    const intent = (tool.input_schema as { properties: { intent: { enum: string[] } } }).properties.intent;
    expect(intent.enum).not.toContain("confirm");
    expect(intent.enum).not.toContain("instruction");
  });
  it("approver schema offers confirm/cancel only with a pending echo", () => {
    expect(allowedIntents("approver", null)).toEqual(["instruction", "evidence", "claim", "chat", "unclear"]);
    expect(allowedIntents("approver", "x")).toEqual(["confirm", "cancel", "instruction", "evidence", "claim", "chat", "unclear"]);
  });
});

describe("coerceThreadReply — deterministic backstops", () => {
  it("a pilot's out-of-role intent becomes unclear", () => {
    expect(coerceThreadReply({ intent: "confirm", reason: "" }, "pilot", "x", noHints).intent).toBe("unclear");
  });
  it("a pilot's instruction-shaped reply becomes a claim/explanation", () => {
    const c = coerceThreadReply({ intent: "instruction", axis: "day", decision: "accepted_exception", reason: "прийняти день" }, "pilot", null, noHints);
    expect(c.intent).toBe("claim");
    expect(c.claim?.kind).toBe("explanation");
  });
  it("a vimeo link forces evidence(video) regardless of the model label", () => {
    const hints: ReplyHints = { ...noHints, vimeoLinks: [{ url: "https://vimeo.com/123456789", id: "123456789" }] };
    const c = coerceThreadReply({ intent: "chat", reason: "" }, "pilot", null, hints);
    expect(c.intent).toBe("evidence");
    expect(c.evidence).toEqual([{ kind: "video", links: ["https://vimeo.com/123456789"] }]);
  });
  it("a #datasets permalink forces evidence(dataset)", () => {
    const hints: ReplyHints = { ...noHints, datasetPermalinks: [{ url: "https://s/archives/C1/p1781000000000100", ts: "1781000000.000100" }] };
    const c = coerceThreadReply({ intent: "unclear", reason: "" }, "approver", null, hints);
    expect(c.evidence?.[0]).toEqual({ kind: "dataset", links: ["https://s/archives/C1/p1781000000000100"] });
  });
  it("keeps a model-provided claim alongside evidence", () => {
    const hints: ReplyHints = { ...noHints, vimeoLinks: [{ url: "https://vimeo.com/1", id: "1" }] };
    const c = coerceThreadReply(
      { intent: "evidence", evidence: [{ kind: "video", links: [] }], claim: { kind: "explanation", text: "дощ" }, reason: "" },
      "pilot", null, hints,
    );
    expect(c.intent).toBe("evidence");
    expect(c.claim?.text).toBe("дощ");
  });
  it("drops a malformed claim kind", () => {
    const c = coerceThreadReply({ intent: "claim", claim: { kind: "weather", text: "x" }, reason: "" }, "pilot", null, noHints);
    expect(c.intent).toBe("unclear");
    expect(c.claim).toBeUndefined();
  });
});

describe("buildThreadReplyPrompt", () => {
  it("names the role and lists hints", () => {
    const p = buildThreadReplyPrompt("⚠️ verdict", "залив відео", null, "pilot", { ...noHints, minuteFigures: [140] });
    expect(p).toContain("PILOT");
    expect(p).toContain("140");
  });
});
