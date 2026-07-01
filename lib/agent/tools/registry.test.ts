import { describe, it, expect } from "vitest";
import type { Tool } from "./types";
import { toAnthropicTools, findTool } from "./registry";

const READ: Tool = {
  name: "demo_read",
  description: "d",
  inputSchema: { type: "object", properties: {} },
  kind: "read",
  run: async () => ({ ok: true, content: "x" }),
};

describe("toAnthropicTools", () => {
  it("maps inputSchema → input_schema and keeps name/description", () => {
    expect(toAnthropicTools([READ])).toEqual([
      { name: "demo_read", description: "d", input_schema: { type: "object", properties: {} } },
    ]);
  });
});

describe("findTool", () => {
  it("finds by name, undefined when absent", () => {
    expect(findTool([READ], "demo_read")).toBe(READ);
    expect(findTool([READ], "nope")).toBeUndefined();
  });
});
