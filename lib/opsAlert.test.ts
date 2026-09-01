import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  openDm: vi.fn(),
  postMessage: vi.fn(),
}));
vi.mock("./slack", () => ({ openDm: mocks.openDm, postMessage: mocks.postMessage }));

import { classifyError, isAuthError, alertApprovers } from "./opsAlert";
import { opsAlertKey } from "./outboundKeys";
import { APPROVERS } from "./approvers";

class FakeJiraError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

describe("classifyError", () => {
  it("maps a Jira 401 to jira-auth", () => {
    expect(classifyError(new FakeJiraError("Jira search returned 401 Unauthorized", 401), "agent-run")).toBe("jira-auth");
  });

  it("maps a Jira 403 to jira-auth", () => {
    expect(classifyError(new FakeJiraError("forbidden", 403), "agent-run")).toBe("jira-auth");
  });

  it("maps other Jira statuses to jira-<status>", () => {
    expect(classifyError(new FakeJiraError("boom", 500), "cron-sync")).toBe("jira-500");
  });

  it("maps a missing Anthropic key to anthropic-config", () => {
    expect(classifyError(new Error("Missing ANTHROPIC_API_KEY"), "agent-run")).toBe("anthropic-config");
  });

  it("maps anything else to unknown:<origin>", () => {
    expect(classifyError(new Error("boom"), "agent-run")).toBe("unknown:agent-run");
    expect(classifyError("string error", "cron-sprint-commit")).toBe("unknown:cron-sprint-commit");
  });
});

describe("isAuthError", () => {
  it("is true only for Jira 401/403", () => {
    expect(isAuthError(new FakeJiraError("nope", 401))).toBe(true);
    expect(isAuthError(new FakeJiraError("nope", 403))).toBe(true);
    expect(isAuthError(new FakeJiraError("nope", 500))).toBe(false);
    expect(isAuthError(new Error("nope"))).toBe(false);
  });
});

describe("opsAlertKey", () => {
  it("builds ops-alert:<userId>:<day>:<errKey>", () => {
    expect(opsAlertKey("U1", "2026-08-31", "jira-auth")).toBe("ops-alert:U1:2026-08-31:jira-auth");
  });
});

describe("alertApprovers", () => {
  beforeEach(() => {
    mocks.openDm.mockReset();
    mocks.postMessage.mockReset();
    mocks.openDm.mockImplementation(async (userId: string) => `D-${userId}`);
    mocks.postMessage.mockResolvedValue("1756600000.000001");
  });

  it("DMs every approver once, keyed per approver/day/errKey", async () => {
    await alertApprovers(new FakeJiraError("Jira search returned 401 Unauthorized", 401), "agent-run", "webhook");

    expect(mocks.openDm).toHaveBeenCalledTimes(APPROVERS.length);
    expect(mocks.postMessage).toHaveBeenCalledTimes(APPROVERS.length);
    for (const [i, approver] of APPROVERS.entries()) {
      const [channel, text, meta] = mocks.postMessage.mock.calls[i];
      expect(channel).toBe(`D-${approver.userId}`);
      expect(text).toContain("agent-run");
      expect(text).toContain("Jira search returned 401 Unauthorized");
      expect(meta.key).toMatch(new RegExp(`^ops-alert:${approver.userId}:\\d{4}-\\d{2}-\\d{2}:jira-auth$`));
      expect(meta.feature).toBe("ops-alert");
      expect(meta.trigger).toBe("webhook");
    }
  });

  it("mentions the Jira token on a jira-auth error", async () => {
    await alertApprovers(new FakeJiraError("401", 401), "agent-run", "webhook");
    const [, text] = mocks.postMessage.mock.calls[0];
    expect(text).toContain("JIRA_API_TOKEN");
  });

  it("still DMs the second approver when the first DM fails, and never throws", async () => {
    mocks.openDm.mockImplementationOnce(async () => {
      throw new Error("dm failed");
    });
    await expect(alertApprovers(new Error("boom"), "cron-sync", "cron")).resolves.toBeUndefined();
    expect(mocks.postMessage).toHaveBeenCalledTimes(APPROVERS.length - 1);
  });
});
