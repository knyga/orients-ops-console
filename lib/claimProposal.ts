/**
 * Map a pilot's unverifiable claim onto an EXISTING instruction axis (no new
 * override tables in v1 — see spec §5), and render the escalation echo that tags
 * both approvers. Pure; unit-tested.
 */
import { APPROVERS } from "./approvers";
import type { GapType } from "./askGaps";
import type { ClaimItem, InstructionAxis, InstructionClassification } from "./instructionClassifyPrompt";

const said = (byName: string, text: string): string => `за словами ${byName}: ${text}`.trim();

export function claimToInstruction(claim: ClaimItem, byName: string): { axis: InstructionAxis; instruction: InstructionClassification } {
  if (claim.kind === "airborne" && typeof claim.airborneMinutes === "number") {
    return { axis: "airborne", instruction: { intent: "instruction", axis: "airborne", airborneMinutes: claim.airborneMinutes, reason: said(byName, claim.text) } };
  }
  if (claim.kind === "loss_found") {
    return { axis: "loss", instruction: { intent: "instruction", axis: "loss", lossState: "found", reason: said(byName, claim.text) } };
  }
  const window = claim.kind === "deploy_window" && claim.deployWindow ? ` (виїзд ${claim.deployWindow.start}–${claim.deployWindow.end})` : "";
  return {
    axis: "day",
    instruction: { intent: "instruction", axis: "day", decision: "accepted_exception", reason: `${said(byName, claim.text)}${window}` },
  };
}

/** In a bot gap-question thread the axis is fixed by the gap the bot asked about. */
export function askClaimToInstruction(gapType: GapType, claim: ClaimItem, byName: string): { axis: InstructionAxis; instruction: InstructionClassification } {
  if (gapType === "no_dataset") {
    return { axis: "dataset", instruction: { intent: "instruction", axis: "dataset", datasetStatus: "WAIVED", reason: said(byName, claim.text) } };
  }
  return { axis: "video", instruction: { intent: "instruction", axis: "video", videoWaive: true, reason: said(byName, claim.text) } };
}

export function renderEscalationEcho(args: { byName: string; claimText: string; summaryUk: string; verifyLine?: string }): string {
  const tags = APPROVERS.map((a) => `<@${a.userId}>`).join(" ");
  const verify = args.verifyLine ? ` Перевірив: ${args.verifyLine}.` : "";
  return `🔎 ${args.byName} повідомляє: «${args.claimText}».${verify} Пропоную: ${args.summaryUk}. ${tags} — «так» / «ні».`;
}
