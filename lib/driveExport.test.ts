import { describe, expect, it } from "vitest";
import {
  buildExportUrl,
  exportMime,
  metadataUrl,
  normalizeExport,
} from "./driveExport";

describe("exportMime", () => {
  it("maps sheet to csv", () => expect(exportMime("sheet")).toBe("text/csv"));
  it("maps doc to markdown", () => expect(exportMime("doc")).toBe("text/markdown"));
});

describe("buildExportUrl", () => {
  it("builds a per-gid spreadsheet csv export url", () => {
    const url = buildExportUrl({
      type: "sheet",
      url: "https://docs.google.com/spreadsheets/d/SHEET1/edit#gid=7",
      gid: "7",
    });
    expect(url).toBe(
      "https://docs.google.com/spreadsheets/d/SHEET1/export?format=csv&gid=7",
    );
  });

  it("defaults the gid to 0 when omitted", () => {
    const url = buildExportUrl({
      type: "sheet",
      url: "https://docs.google.com/spreadsheets/d/SHEET1/edit",
    });
    expect(url).toContain("gid=0");
  });

  it("builds a Drive API markdown export url for docs", () => {
    const url = buildExportUrl({
      type: "doc",
      url: "https://docs.google.com/document/d/DOC1/edit",
    });
    expect(url).toBe(
      "https://www.googleapis.com/drive/v3/files/DOC1/export?mimeType=text%2Fmarkdown",
    );
  });
});

describe("metadataUrl", () => {
  it("requests only modifiedTime", () => {
    expect(metadataUrl("DOC1")).toBe(
      "https://www.googleapis.com/drive/v3/files/DOC1?fields=modifiedTime",
    );
  });
});

describe("normalizeExport", () => {
  it("strips a BOM, converts CRLF, and ensures a trailing newline", () => {
    expect(normalizeExport("﻿a,b\r\n1,2")).toBe("a,b\n1,2\n");
  });
  it("does not double the trailing newline", () => {
    expect(normalizeExport("x\n")).toBe("x\n");
  });
});
