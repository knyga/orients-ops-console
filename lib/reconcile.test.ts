import { describe, expect, it } from "vitest";
import {
  aggregateByDay,
  summarize,
  videoFlightDate,
  videoUploadDate,
  type FlightDay,
  type ReconVideo,
} from "./reconcile";

const HOUR_SECONDS = 3600;

/** Helper: a video uploaded at noon Kyiv on the given date (stable day mapping). */
function videoOn(date: string, durationSeconds: number): ReconVideo {
  return { createdTime: `${date}T12:00:00+00:00`, durationSeconds };
}

function flight(date: string, flightHours: number): FlightDay {
  return { date, flightHours };
}

describe("videoUploadDate (Europe/Kyiv day boundary)", () => {
  it("maps a post-midnight Kyiv time to the local date, not the UTC date (summer / EEST = UTC+3)", () => {
    // 2026-06-09 22:30Z is 2026-06-10 01:30 in Kyiv (UTC+3 in summer).
    expect(videoUploadDate("2026-06-09T22:30:00Z")).toBe("2026-06-10");
  });

  it("is DST-aware (winter / EET = UTC+2)", () => {
    // 2026-01-15 23:30Z is 2026-01-16 01:30 in Kyiv (UTC+2 in winter).
    expect(videoUploadDate("2026-01-15T23:30:00Z")).toBe("2026-01-16");
  });

  it("throws on an unparseable timestamp", () => {
    expect(() => videoUploadDate("not-a-date")).toThrow();
  });
});

describe("aggregateByDay — the 50% gate", () => {
  it("passes at exactly 50% (2h flight / 1h video) — boundary uses >=", () => {
    const [row] = aggregateByDay(
      [videoOn("2026-04-01", HOUR_SECONDS)],
      [flight("2026-04-01", 2)],
    );
    expect(row.recordedMinutes).toBe(60);
    expect(row.flightMinutes).toBe(120);
    expect(row.ratio).toBe(0.5);
    expect(row.status).toBe("OK");
  });

  it("flags just below 50%", () => {
    // 2h flight (120 min) needs >= 60 min video; 59 min fails.
    const [row] = aggregateByDay(
      [videoOn("2026-04-01", 59 * 60)],
      [flight("2026-04-01", 2)],
    );
    expect(row.ratio).toBeLessThan(0.5);
    expect(row.status).toBe("FLAG");
  });

  it("flags a flight day with zero video", () => {
    const [row] = aggregateByDay([], [flight("2026-04-02", 3)]);
    expect(row.videoCount).toBe(0);
    expect(row.recordedMinutes).toBe(0);
    expect(row.flightMinutes).toBe(180);
    expect(row.ratio).toBe(0);
    expect(row.status).toBe("FLAG");
  });

  it("flags video with no matching flight day (no flight minutes to gate against)", () => {
    const [row] = aggregateByDay([videoOn("2026-04-03", HOUR_SECONDS)], []);
    expect(row.videoCount).toBe(1);
    expect(row.flightMinutes).toBe(0);
    expect(row.ratio).toBeNull();
    expect(row.status).toBe("FLAG");
  });

  it("sums flight hours when a date appears more than once", () => {
    // Two flights logged the same day: 1h + 1.5h = 2.5h (150 min). 90 min video
    // -> 0.6 -> OK. (Were the second entry to overwrite, it'd be 1.5h/90min=1.0.)
    const [row] = aggregateByDay(
      [videoOn("2026-04-06", 90 * 60)],
      [flight("2026-04-06", 1), flight("2026-04-06", 1.5)],
    );
    expect(row.flightMinutes).toBe(150);
    expect(row.status).toBe("OK");
  });

  it("sums multiple videos on the same day before applying the gate", () => {
    // 2 x 40 min = 80 min video against 2h (120 min) flight -> 0.666 -> OK.
    const [row] = aggregateByDay(
      [videoOn("2026-04-04", 40 * 60), videoOn("2026-04-04", 40 * 60)],
      [flight("2026-04-04", 2)],
    );
    expect(row.videoCount).toBe(2);
    expect(row.recordedMinutes).toBe(80);
    expect(row.status).toBe("OK");
  });
});

describe("aggregateByDay — multi-day aggregation", () => {
  const videos = [
    videoOn("2026-04-01", HOUR_SECONDS), // OK day
    videoOn("2026-04-02", 30 * 60), // under-recorded -> FLAG
    videoOn("2026-04-05", HOUR_SECONDS), // no flight day -> FLAG
  ];
  const flights = [
    flight("2026-04-01", 2), // 60 min video / 120 -> OK
    flight("2026-04-02", 2), // 30 min video / 120 -> FLAG
    flight("2026-04-03", 1), // zero video -> FLAG
  ];

  it("returns one row per day, sorted ascending", () => {
    const rows = aggregateByDay(videos, flights);
    expect(rows.map((r) => r.date)).toEqual([
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
      "2026-04-05",
    ]);
    expect(rows.map((r) => r.status)).toEqual(["OK", "FLAG", "FLAG", "FLAG"]);
  });

  it("summarize rolls up totals and flagged days", () => {
    const summary = summarize(aggregateByDay(videos, flights));
    expect(summary.totalVideos).toBe(3);
    expect(summary.totalRecordedMinutes).toBe(60 + 30 + 60);
    expect(summary.flaggedDays).toEqual([
      "2026-04-02",
      "2026-04-03",
      "2026-04-05",
    ]);
  });
});

describe("videoFlightDate", () => {
  it("parses the `Recording YYYY-MM-DD …` name format", () => {
    expect(videoFlightDate("Recording 2026-06-16 195102", "2026-06-18T09:00:00Z")).toBe("2026-06-16");
  });

  it("parses the `WIN_YYYYMMDD_…` name format", () => {
    expect(videoFlightDate("WIN_20260616_17_39_24_Pro", "2026-06-18T09:00:00Z")).toBe("2026-06-16");
  });

  it("falls back to the Kyiv upload date when the name has no date", () => {
    // 2026-06-18T22:30:00Z is 2026-06-19 01:30 in Kyiv (UTC+3)
    expect(videoFlightDate("clip-final", "2026-06-18T22:30:00Z")).toBe("2026-06-19");
  });

  it("ignores an out-of-range fake date in the name and falls back", () => {
    expect(videoFlightDate("project_20261399_x", "2026-06-18T09:00:00Z")).toBe("2026-06-18");
  });
});
