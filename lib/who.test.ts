import { describe, it, expect } from "vitest";
import { buildPersonView, findUnlinked, type WhoSources } from "./who";
import type { Person } from "./people";
import type { StoredMessage } from "./slackMirror";

const PERIOD = { start: "2026-06-01", end: "2026-06-30" };

function msg(over: Partial<StoredMessage>): StoredMessage {
  return {
    ts: "1", channel: "general", authorId: "U1", author: "X",
    isoTime: "2026-06-02T09:00:00.000Z", text: "hi", permalink: "p",
    firstSeen: "x", lastSeen: "x", ...over,
  };
}

const OLEKS: Person = {
  name: "Oleksandr K", role: "CEO/CTO",
  slackId: "U1", jiraAccount: "acc-o", githubLogin: "oknyga", rosterInitial: "О",
};

describe("buildPersonView timeline", () => {
  it("keeps only this person's messages, sorted by ts, dropping tombstones", () => {
    const sources: WhoSources = {
      messages: [
        msg({ ts: "3", authorId: "U1", channel: "datasets", isoTime: "2026-06-03T10:00:00.000Z", text: "c" }),
        msg({ ts: "1", authorId: "U1", channel: "general", isoTime: "2026-06-01T08:00:00.000Z", text: "a" }),
        msg({ ts: "2", authorId: "U2", text: "not mine" }),
        msg({ ts: "4", authorId: "U1", text: "deleted", deleted: true }),
      ],
      jira: null, github: null, bonus: null,
    };
    const view = buildPersonView(OLEKS, PERIOD, sources);
    expect(view.timeline.map((t) => t.text)).toEqual(["a", "c"]);
    expect(view.timeline[0]).toMatchObject({ channel: "general", permalink: "p" });
  });
});

describe("buildPersonView summary", () => {
  it("attaches jira/github/field blocks when identity + report present", () => {
    const sources: WhoSources = {
      messages: [],
      jira: { rows: [
        { accountId: "acc-o", issueKeys: ["ORI-1", "ORI-2"], storyPoints: 5 },
        { accountId: "other", issueKeys: ["X-9"], storyPoints: 1 },
      ] },
      github: { contributors: [
        { login: "oknyga", commits: 12, additions: 900, deletions: 120, prsOpened: 4, prsMerged: 3 },
      ] },
      bonus: {
        people: [{ name: "Олександр", trips: 2, net: 900 }],
        days: [
          { date: "2026-06-05", roster: ["Олександр", "Андріан"], deployMin: 200, counted: true },
          { date: "2026-06-06", roster: ["Андріан"], deployMin: 180, counted: true },
          { date: "2026-06-07", roster: ["Олександр"], deployMin: 150, counted: true },
        ],
      },
    };
    const view = buildPersonView(OLEKS, PERIOD, sources);
    expect(view.summary.jira).toEqual({ issueKeys: ["ORI-1", "ORI-2"], count: 2, points: 5 });
    expect(view.summary.github).toEqual({ commits: 12, additions: 900, deletions: 120, prsOpened: 4, prsMerged: 3 });
    // field: roster name "Олександр" resolved from rosterInitial "О"; flightDays/minutes
    // summed over days whose roster includes that name.
    expect(view.summary.field).toEqual({ trips: 2, flightDays: 2, flightMinutes: 350, netUah: 900 });
  });

  it("excludes voided days (no drone-count report) from flightDays/flightMinutes", () => {
    const sources: WhoSources = {
      messages: [],
      jira: null,
      github: null,
      bonus: {
        people: [{ name: "Олександр", trips: 1, net: 700 }],
        days: [
          { date: "2026-06-05", roster: ["Олександр"], deployMin: 200, counted: true },
          { date: "2026-06-06", roster: ["Олександр"], deployMin: 240, counted: false }, // voided
        ],
      },
    };
    const view = buildPersonView(OLEKS, PERIOD, sources);
    // The voided day matches the roster but earned nothing, so it must not
    // inflate flightDays/flightMinutes (net/trips come from bonus.people).
    expect(view.summary.field).toEqual({ trips: 1, flightDays: 1, flightMinutes: 200, netUah: 700 });
  });

  it("omits a block when the person lacks that identity", () => {
    const noGh: Person = { name: "Op", role: "field operator", slackId: "U1", rosterInitial: "А" };
    const sources: WhoSources = {
      messages: [],
      jira: { rows: [{ accountId: "acc-o", issueKeys: ["ORI-1"], storyPoints: 1 }] },
      github: { contributors: [{ login: "oknyga", commits: 1, additions: 1, deletions: 0, prsOpened: 0, prsMerged: 0 }] },
      bonus: null,
    };
    const view = buildPersonView(noGh, PERIOD, sources);
    expect(view.summary.jira).toBeUndefined();   // no jiraAccount
    expect(view.summary.github).toBeUndefined();  // no githubLogin
    expect(view.summary.field).toBeUndefined();   // no bonus report
  });

  it("omits a block when the report is present but has no matching row", () => {
    const sources: WhoSources = {
      messages: [],
      jira: { rows: [{ accountId: "someone-else", issueKeys: ["X-1"], storyPoints: 1 }] },
      github: null, bonus: null,
    };
    expect(buildPersonView(OLEKS, PERIOD, sources).summary.jira).toBeUndefined();
  });
});

describe("findUnlinked", () => {
  it("lists identities present in data but claimed by no person", () => {
    const people: Person[] = [OLEKS];
    const sources: WhoSources = {
      messages: [msg({ authorId: "U1" }), msg({ authorId: "U_unknown" })],
      jira: { rows: [{ accountId: "acc-o", issueKeys: [], storyPoints: 0 }, { accountId: "acc-x", issueKeys: [], storyPoints: 0 }] },
      github: { contributors: [{ login: "oknyga", commits: 0, additions: 0, deletions: 0, prsOpened: 0, prsMerged: 0 }, { login: "petro-x", commits: 0, additions: 0, deletions: 0, prsOpened: 0, prsMerged: 0 }] },
      bonus: { people: [{ name: "Олександр", trips: 0, net: 0 }, { name: "Невідомий", trips: 0, net: 0 }], days: [] },
    };
    const r = findUnlinked(sources, people);
    expect(r.slack).toEqual(["U_unknown"]);
    expect(r.jira).toEqual(["acc-x"]);
    expect(r.github).toEqual(["petro-x"]);
    expect(r.roster).toEqual(["Невідомий"]); // "Олександр" is linked via О; "Невідомий" is not
  });

  it("excludes null github logins (commits with no linked account) from the hygiene list", () => {
    const sources: WhoSources = {
      messages: [],
      jira: null,
      github: { contributors: [
        { login: null, commits: 7, additions: 0, deletions: 0, prsOpened: 0, prsMerged: 0 },
        { login: "petro-x", commits: 1, additions: 0, deletions: 0, prsOpened: 0, prsMerged: 0 },
      ] },
      bonus: null,
    };
    const r = findUnlinked(sources, [OLEKS]);
    expect(r.github).toEqual(["petro-x"]); // a bare null must never appear
  });
});
