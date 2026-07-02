import { describe, it, expect, afterEach } from "vitest";
import { selfOrigin } from "./selfOrigin";

afterEach(() => { delete process.env.VERCEL_URL; });

describe("selfOrigin", () => {
  it("derives origin from the request URL", () => {
    expect(selfOrigin(new Request("https://console.example.com/api/slack/events"))).toBe("https://console.example.com");
  });
  it("prefers VERCEL_URL when set", () => {
    process.env.VERCEL_URL = "my-app.vercel.app";
    expect(selfOrigin(new Request("http://localhost/api/x"))).toBe("https://my-app.vercel.app");
  });
});
