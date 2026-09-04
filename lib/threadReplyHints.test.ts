import { describe, it, expect } from "vitest";
import { extractHints, unwrapSlackLinks } from "./threadReplyHints";

const DS = "C08KG802THU";

describe("unwrapSlackLinks", () => {
  it("strips <url|label> wrappers to the bare url", () => {
    expect(unwrapSlackLinks("see <https://vimeo.com/123456789|video>")).toBe("see https://vimeo.com/123456789");
    expect(unwrapSlackLinks("<https://vimeo.com/123456789>")).toBe("https://vimeo.com/123456789");
  });
});

describe("extractHints", () => {
  it("finds vimeo links with their numeric id (incl. /manage/videos/ and Slack-wrapped)", () => {
    const h = extractHints("залив <https://vimeo.com/manage/videos/987654321|v> і https://vimeo.com/123456789/abcdef", DS);
    expect(h.vimeoLinks.map((v) => v.id)).toEqual(["987654321", "123456789"]);
  });
  it("finds #datasets permalinks only for the datasets channel id", () => {
    const h = extractHints(
      `https://x.slack.com/archives/${DS}/p1781000000000100 https://x.slack.com/archives/C08GY2NKF9D/p1781000000000200`,
      DS,
    );
    expect(h.datasetPermalinks).toEqual([{ url: `https://x.slack.com/archives/${DS}/p1781000000000100`, ts: "1781000000.000100" }]);
  });
  it("parses time ranges with : or . and any dash, zero-padding hours", () => {
    const h = extractHints("виїзд був 9.00-15:40, потім 16:00 – 18:05", DS);
    expect(h.timeRanges).toEqual([{ start: "09:00", end: "15:40" }, { start: "16:00", end: "18:05" }]);
  });
  it("parses minute figures (хв/мін/min)", () => {
    expect(extractHints("у повітрі 140 хв, відео 35 min", DS).minuteFigures).toEqual([140, 35]);
  });
  it("returns empty arrays for plain chat", () => {
    const h = extractHints("що ще бракує?", DS);
    expect(h).toEqual({ vimeoLinks: [], datasetPermalinks: [], timeRanges: [], minuteFigures: [] });
  });
});
