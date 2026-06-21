import { describe, expect, it } from "vitest";
import { extractFileId, parseManifest } from "./driveManifest";

describe("extractFileId", () => {
  it("pulls the id from a spreadsheet url", () => {
    expect(
      extractFileId("https://docs.google.com/spreadsheets/d/ABC123_x/edit#gid=0"),
    ).toBe("ABC123_x");
  });

  it("pulls the id from a document url", () => {
    expect(
      extractFileId("https://docs.google.com/document/d/Doc-9/edit"),
    ).toBe("Doc-9");
  });

  it("pulls the id from an open?id= url", () => {
    expect(
      extractFileId("https://drive.google.com/open?id=Zzz999"),
    ).toBe("Zzz999");
  });

  it("throws when no id is present", () => {
    expect(() => extractFileId("https://example.com/nope")).toThrow(/file id/i);
  });
});

describe("parseManifest", () => {
  const ok = JSON.stringify({
    sources: [
      {
        id: "flight-hours-2026-06",
        url: "https://docs.google.com/spreadsheets/d/SHEET1/edit#gid=0",
        type: "sheet",
        dest: "reports/field-ops/inputs/2026-06.csv",
        gid: "0",
      },
      {
        id: "rules",
        url: "https://docs.google.com/document/d/DOC1/edit",
        type: "doc",
        dest: "docs/drive/rules.md",
      },
    ],
  });

  it("parses a valid manifest", () => {
    const m = parseManifest(ok);
    expect(m.sources).toHaveLength(2);
    expect(m.sources[0].gid).toBe("0");
  });

  it("rejects duplicate ids", () => {
    const dup = JSON.stringify({
      sources: [
        { id: "x", url: "https://docs.google.com/document/d/A/edit", type: "doc", dest: "docs/drive/a.md" },
        { id: "x", url: "https://docs.google.com/document/d/B/edit", type: "doc", dest: "docs/drive/b.md" },
      ],
    });
    expect(() => parseManifest(dup)).toThrow(/duplicate id/i);
  });

  it("rejects an unknown type", () => {
    const bad = JSON.stringify({
      sources: [{ id: "x", url: "https://docs.google.com/document/d/A/edit", type: "pdf", dest: "docs/drive/a.md" }],
    });
    expect(() => parseManifest(bad)).toThrow(/type/i);
  });

  it("rejects gid on a doc", () => {
    const bad = JSON.stringify({
      sources: [{ id: "x", url: "https://docs.google.com/document/d/A/edit", type: "doc", dest: "docs/drive/a.md", gid: "0" }],
    });
    expect(() => parseManifest(bad)).toThrow(/gid/i);
  });

  it("rejects a missing dest", () => {
    const bad = JSON.stringify({
      sources: [{ id: "x", url: "https://docs.google.com/document/d/A/edit", type: "doc" }],
    });
    expect(() => parseManifest(bad)).toThrow(/dest/i);
  });

  it("rejects a url with no extractable id", () => {
    const bad = JSON.stringify({
      sources: [{ id: "x", url: "https://example.com/none", type: "doc", dest: "docs/drive/a.md" }],
    });
    expect(() => parseManifest(bad)).toThrow(/file id/i);
  });
});
