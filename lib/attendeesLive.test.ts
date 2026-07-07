import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveAttendeesLive } from "./attendeesLive";
import type { Person } from "./people";

const fetchUserEmail = vi.hoisted(() => vi.fn());
vi.mock("./slack", () => ({ fetchUserEmail }));

const PEOPLE_FIXTURE: Person[] = [
  { name: "Taras Panasiuk", role: "field", email: "taras@getshaman.com", aliases: ["Тарас"] },
  { name: "Bohdan F", role: "eng", slackId: "U0BOHDAN", aliases: ["Богдан"] }, // no email, has slackId
  { name: "Vlad Bondar", role: "field", aliases: ["Влад"] }, // no email, no slackId
];

beforeEach(() => fetchUserEmail.mockReset());

describe("resolveAttendeesLive", () => {
  it("uses the Slack profile email for a needs-email person, marked source: slack", async () => {
    fetchUserEmail.mockResolvedValue("bohdan@orients.ai");
    const r = await resolveAttendeesLive(["Богдан"], PEOPLE_FIXTURE);
    expect(fetchUserEmail).toHaveBeenCalledWith("U0BOHDAN");
    expect(r).toEqual({
      ok: true,
      attendees: [{ name: "Bohdan F", email: "bohdan@orients.ai", source: "slack" }],
    });
  });

  it("roster email wins — no Slack call for a person who has one", async () => {
    const r = await resolveAttendeesLive(["Тарас"], PEOPLE_FIXTURE);
    expect(fetchUserEmail).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attendees[0].source).toBeUndefined();
  });

  it("fails loudly naming both sources when Slack has no email", async () => {
    fetchUserEmail.mockResolvedValue(null);
    const r = await resolveAttendeesLive(["Богдан"], PEOPLE_FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems[0]).toBe("У «Bohdan F» немає email ні в реєстрі (lib/people.ts), ні в профілі Slack.");
    }
  });

  it("mixed set: roster + slack-fallback + raw email, all-or-nothing on one failure", async () => {
    fetchUserEmail.mockResolvedValue("bohdan@orients.ai");
    const ok = await resolveAttendeesLive(["Тарас", "Богдан", "x@y.com"], PEOPLE_FIXTURE);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.attendees).toHaveLength(3);

    const bad = await resolveAttendeesLive(["Богдан", "Влад"], PEOPLE_FIXTURE);
    expect(bad.ok).toBe(false); // Влад has no slackId — pure problem blocks the set
  });

  it("dedupes a slack-fallback email against a raw duplicate", async () => {
    fetchUserEmail.mockResolvedValue("bohdan@orients.ai");
    const r = await resolveAttendeesLive(["Богдан", "bohdan@orients.ai"], PEOPLE_FIXTURE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attendees).toHaveLength(1);
  });

  it("rejects a garbage Slack profile email — fails loudly naming both sources", async () => {
    fetchUserEmail.mockResolvedValue("  garbage  ");
    const r = await resolveAttendeesLive(["Богдан"], PEOPLE_FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems[0]).toBe("У «Bohdan F» немає email ні в реєстрі (lib/people.ts), ні в профілі Slack.");
    }
  });

  it("trims a padded-but-valid Slack profile email before using it", async () => {
    fetchUserEmail.mockResolvedValue("  bohdan@orients.ai  ");
    const r = await resolveAttendeesLive(["Богдан"], PEOPLE_FIXTURE);
    expect(r).toEqual({
      ok: true,
      attendees: [{ name: "Bohdan F", email: "bohdan@orients.ai", source: "slack" }],
    });
  });
});
