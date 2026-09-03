/**
 * The agent tool contract. Pure — no server-only / node imports — so the loop,
 * the tools, and their tests share one vocabulary. A read tool executes inside
 * the loop (`run`); a write tool is never executed by the loop — it produces a
 * Proposal the caller applies after confirmation (`propose`).
 */
export interface ToolResult {
  ok: boolean;
  /** Text fed back to the model as the tool_result (or shown to the user). */
  content: string;
}

/** A confirm-first write: a resolved, structured action + its Ukrainian echo.
 *  `params` is the resolved action (serializable — persisted across a Slack
 *  round-trip); `apply()` performs the write deterministically. */
export interface Proposal {
  kind: string;
  /** Resolved, JSON-serializable action params (the deterministic executor's input). */
  params: Record<string, unknown>;
  echoUk: string;
  apply(): Promise<string>;
}

/** Conversation-level facts the loop knows but the model should not have to
 *  relay — attached deterministically to proposals (e.g. the Slack thread the
 *  request came from, linked into a created ticket's description). */
export interface ProposeContext {
  sourceUrl?: string;
  /** Slack channel the turn came from — a write that edits a message in place
   *  (sprint_plan_build) needs it resolved deterministically, never by the model. */
  channelId?: string;
  /** The thread's anchor ts (the message a thread-scoped write rewrites). */
  threadTs?: string;
  /** True only when the turn came from INSIDE an existing thread. Slack hands
   *  a top-level @mention `threadTs === its own ts` (the bot replies under it),
   *  so `threadTs` alone cannot tell "asked in a thread" from "asked in the
   *  channel" — a channel-vs-thread write (field_summary_post) needs this. */
  inThread?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the tool input (Anthropic `input_schema`). */
  inputSchema: Record<string, unknown>;
  kind: "read" | "write";
  /** Read tools only: execute now, return a result to feed back to the model. */
  run?(args: Record<string, unknown>): Promise<ToolResult>;
  /** Write tools only: resolve args into a confirm-first Proposal (no write yet). */
  propose?(args: Record<string, unknown>, ctx?: ProposeContext): Promise<Proposal>;
}
