import { describe, expect, it } from "vitest";
import { investorKey } from "./outboundKeys";

describe("investorKey", () => {
  it("namespaces the send by the explicit week key", () => {
    expect(investorKey("2026-07-20_2026-07-26")).toBe("investor:2026-07-20_2026-07-26");
  });
});
