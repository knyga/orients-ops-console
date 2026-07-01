/**
 * Registry helpers: shape Tools for the Anthropic API and look them up by name.
 * The default tool set is assembled in loop.ts (which owns the server-only tool
 * modules); this module stays pure so it is unit-testable without a client.
 */
import type { Tool } from "./types";

export function toAnthropicTools(
  tools: Tool[],
): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
