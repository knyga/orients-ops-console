import { describe, it, expect, afterEach } from "vitest";
import { selfOrigin } from "./selfOrigin";

afterEach(() => { delete process.env.VERCEL_URL; });

describe("selfOrigin", () => {
  it("derives origin from the request URL", () => {
    expect(selfOrigin(new Request("https://console.example.com/api/slack/events"))).toBe("https://console.example.com");
  });
  it("ignores VERCEL_URL — the generated deployment URL sits behind Vercel Authentication (SSO 302)", () => {
    process.env.VERCEL_URL = "my-app-abc123.vercel.app";
    expect(selfOrigin(new Request("https://console.example.com/api/slack/events"))).toBe("https://console.example.com");
  });
  it("forces https on non-local hosts (the proxied Host can surface as http)", () => {
    expect(selfOrigin(new Request("http://console.example.com/api/x"))).toBe("https://console.example.com");
  });
  it("keeps plain http for localhost dev", () => {
    expect(selfOrigin(new Request("http://localhost:3003/api/x"))).toBe("http://localhost:3003");
  });
});
