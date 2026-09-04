import { describe, it, expect } from "vitest";
import { toEvidenceEvent } from "./evidenceEvents";

describe("toEvidenceEvent", () => {
  it("maps a row, defaulting nullable fields", () => {
    const ev = toEvidenceEvent({
      id: "e1", threadTs: "1.1", channel: "field-qa", date: "2026-09-01", reportTs: null,
      byUserId: "U1", byName: "Тарас", role: "pilot", kind: "evidence", evidence: { vimeoLinks: [] },
      outcome: "closed", statusBefore: "NEEDS_REVIEW", statusAfter: "ACCEPTED",
      sourceReplyTs: "1.2", proposalId: null, createdAt: "2026-09-04T10:00:00.000Z",
    });
    expect(ev.reportTs).toBeNull();
    expect(ev.role).toBe("pilot");
    expect(ev.outcome).toBe("closed");
  });
});
