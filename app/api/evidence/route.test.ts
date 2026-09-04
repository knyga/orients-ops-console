import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  readEvidenceEventsInWindow: vi.fn(),
  readProposalsInWindow: vi.fn(),
}));

vi.mock("@/lib/evidenceEvents", () => ({ readEvidenceEventsInWindow: h.readEvidenceEventsInWindow }));
vi.mock("@/lib/proposals", () => ({ readProposalsInWindow: h.readProposalsInWindow }));

import { GET } from "./route";

function req(url: string) {
  return new Request(url);
}

beforeEach(() => {
  h.readEvidenceEventsInWindow.mockReset();
  h.readProposalsInWindow.mockReset();
});

describe("GET /api/evidence", () => {
  it("400 when period is missing", async () => {
    const res = await GET(req("https://x/api/evidence"));
    expect(res.status).toBe(400);
    expect(h.readEvidenceEventsInWindow).not.toHaveBeenCalled();
  });

  it("400 when period is invalid", async () => {
    const res = await GET(req("https://x/api/evidence?period=not-a-period"));
    expect(res.status).toBe(400);
  });

  it("200 with events + pilot-origin-only proposals", async () => {
    h.readEvidenceEventsInWindow.mockResolvedValue([
      { id: "e1", date: "2026-09-02", channel: "field-qa", threadTs: "100.1", role: "pilot", kind: "evidence", outcome: "closed" },
    ]);
    h.readProposalsInWindow.mockResolvedValue([
      { id: "p1", date: "2026-09-02", origin: "pilot", summaryUk: "pilot claim" },
      { id: "p2", date: "2026-09-03", origin: "approver", summaryUk: "approver instruction" },
    ]);

    const res = await GET(req("https://x/api/evidence?period=2026-09"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(h.readEvidenceEventsInWindow).toHaveBeenCalledWith("2026-09-01", "2026-09-30");
    expect(h.readProposalsInWindow).toHaveBeenCalledWith("2026-09-01", "2026-09-30");

    expect(body.period).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(body.events).toHaveLength(1);
    expect(body.pilotProposals).toEqual([{ id: "p1", date: "2026-09-02", origin: "pilot", summaryUk: "pilot claim" }]);
  });
});
