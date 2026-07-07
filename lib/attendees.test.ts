import { describe, it, expect } from "vitest";
import { resolveAttendees, resolveAttendeeQuery, collectAttendees } from "./attendees";
import type { Person } from "./people";

const FIXTURE: Person[] = [
  { name: "Taras Panasiuk", role: "field", email: "taras@getshaman.com", aliases: ["Тарас Панасюк"] },
  { name: "Vlad Bondar", role: "field", aliases: ["Влад"] }, // deliberately no email
  { name: "Andrii One", role: "dev", email: "a1@getshaman.com", aliases: ["Андрій Один"] },
  { name: "Andrii Two", role: "dev", email: "a2@getshaman.com", aliases: ["Андрій Два"] },
];

describe("resolveAttendees", () => {
  it("resolves roster aliases to Workspace emails", () => {
    const r = resolveAttendees(["Тарас"], FIXTURE);
    expect(r).toEqual({ ok: true, attendees: [{ name: "Taras Panasiuk", email: "taras@getshaman.com" }] });
  });

  it("passes raw emails through verbatim", () => {
    const r = resolveAttendees(["ext@example.com"], FIXTURE);
    expect(r).toEqual({ ok: true, attendees: [{ name: "ext@example.com", email: "ext@example.com" }] });
  });

  it("rejects a malformed email-ish token", () => {
    const r = resolveAttendees(["not@an"], FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toContain("not@an");
  });

  it("fails loudly on a resolved person without an email, naming them", () => {
    const r = resolveAttendees(["Влад"], FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/Vlad Bondar.*email/);
  });

  it("lists candidates on an ambiguous name", () => {
    const r = resolveAttendees(["Андрій"], FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/Andrii One.*Andrii Two/);
  });

  it("fails loudly on an unknown name — never guesses", () => {
    const r = resolveAttendees(["Xyzzy"], FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toContain("Xyzzy");
  });

  it("all-or-nothing: one bad query fails the whole set", () => {
    const r = resolveAttendees(["Тарас", "Xyzzy"], FIXTURE);
    expect(r.ok).toBe(false);
  });

  it("an empty attendee list is an error", () => {
    expect(resolveAttendees([], FIXTURE).ok).toBe(false);
    expect(resolveAttendees(["  "], FIXTURE).ok).toBe(false);
  });

  it("dedupes the same person given by name and by email", () => {
    const r = resolveAttendees(["Тарас", "taras@getshaman.com"], FIXTURE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attendees).toHaveLength(1);
  });
});

const WITH_SLACK: Person[] = [
  ...FIXTURE,
  { name: "Bohdan F", role: "eng", slackId: "U0BOHDAN", aliases: ["Богдан"] }, // no email, has slackId
];

describe("resolveAttendeeQuery", () => {
  it("resolves a roster person with an email", () => {
    expect(resolveAttendeeQuery("Тарас", WITH_SLACK)).toEqual({
      kind: "resolved",
      attendee: { name: "Taras Panasiuk", email: "taras@getshaman.com" },
    });
  });

  it("returns needs-email for a person with a slackId and no email", () => {
    expect(resolveAttendeeQuery("Богдан", WITH_SLACK)).toEqual({
      kind: "needs-email",
      name: "Bohdan F",
      slackId: "U0BOHDAN",
    });
  });

  it("is a problem for a person with neither email nor slackId", () => {
    const r = resolveAttendeeQuery("Влад", WITH_SLACK);
    expect(r.kind).toBe("problem");
    if (r.kind === "problem") expect(r.problem).toMatch(/Vlad Bondar.*email/);
  });

  it("passes raw emails and rejects malformed ones", () => {
    expect(resolveAttendeeQuery("x@y.com", WITH_SLACK)).toEqual({
      kind: "resolved",
      attendee: { name: "x@y.com", email: "x@y.com" },
    });
    expect(resolveAttendeeQuery("not@an", WITH_SLACK).kind).toBe("problem");
  });
});

describe("collectAttendees", () => {
  it("maps a leftover needs-email to the roster problem (pure-path parity)", () => {
    const r = collectAttendees([{ kind: "needs-email", name: "Bohdan F", slackId: "U0BOHDAN" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/Bohdan F.*email у реєстрі/);
  });

  it("dedupes resolved attendees by email case-insensitively", () => {
    const r = collectAttendees([
      { kind: "resolved", attendee: { name: "A", email: "a@x.com" } },
      { kind: "resolved", attendee: { name: "a@X.com", email: "a@X.com" } },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attendees).toHaveLength(1);
  });
});
