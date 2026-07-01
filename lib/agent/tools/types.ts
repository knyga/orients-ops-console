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
 *  `apply()` performs the write deterministically and returns a result string. */
export interface Proposal {
  kind: string;
  echoUk: string;
  apply(): Promise<string>;
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
  propose?(args: Record<string, unknown>): Promise<Proposal>;
}
