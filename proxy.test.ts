import { describe, it, expect } from "vitest";
import { config } from "./proxy";

describe("auth-gate matcher bypass", () => {
  it("exempts every machine endpoint that carries its own auth", () => {
    // /api/agent/run is invoked by the events webhook itself (x-agent-secret);
    // the session-cookie gate must never intercept it (2026-07-04: it did, and
    // every deferred agent turn died at a 401 before reaching the route).
    for (const prefix of ["api/auth", "api/cron", "api/slack", "api/agent"]) {
      expect(config.matcher[0]).toContain(prefix);
    }
  });

  it("does NOT exempt /api/slack-link (a console data route that merely shares the api/slack prefix)", () => {
    // The bypass alternative is `api/slack(?:/|$)`; `api/slack-link` must still hit the cookie gate.
    const re = new RegExp(`^${config.matcher[0].replace(/^\/\(/, "/(")}$`);
    expect(re.test("/api/slack/events")).toBe(false);
    expect(re.test("/api/slack-link")).toBe(true);
    expect(re.test("/api/field-loss")).toBe(true);
  });
});
