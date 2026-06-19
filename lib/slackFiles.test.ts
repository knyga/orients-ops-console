import { describe, expect, it } from "vitest";
import { toSlackFiles } from "./slackFiles";

describe("toSlackFiles", () => {
  it("maps raw Slack file objects, preferring the download url", () => {
    expect(
      toSlackFiles([
        { name: "a.png", mimetype: "image/png", url_private: "u", url_private_download: "d" },
      ]),
    ).toEqual([{ name: "a.png", mimetype: "image/png", urlPrivate: "d" }]);
  });
  it("falls back to url_private when no download url", () => {
    expect(toSlackFiles([{ name: "b.png", mimetype: "image/png", url_private: "u" }]))
      .toEqual([{ name: "b.png", mimetype: "image/png", urlPrivate: "u" }]);
  });
  it("returns undefined when there are no files", () => {
    expect(toSlackFiles(undefined)).toBeUndefined();
    expect(toSlackFiles([])).toBeUndefined();
  });
});
