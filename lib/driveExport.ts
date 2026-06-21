/**
 * Pure helpers for turning a manifest source into the right Drive export
 * request, and for normalizing the bytes that come back. No fs/network.
 *
 * Sheets are exported per-gid through the docs.google.com export host (the
 * Drive API `files.export` only yields the first sheet); docs use the Drive
 * API markdown export. Both are called with a Bearer token in lib/drive.ts.
 */
import { extractFileId, type DriveType } from "./driveManifest";

export function exportMime(type: DriveType): string {
  return type === "sheet" ? "text/csv" : "text/markdown";
}

export function buildExportUrl(source: {
  type: DriveType;
  url: string;
  gid?: string;
}): string {
  const id = extractFileId(source.url);
  if (source.type === "sheet") {
    const gid = source.gid ?? "0";
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  }
  const mime = encodeURIComponent(exportMime(source.type));
  return `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${mime}`;
}

export function metadataUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?fields=modifiedTime`;
}

export function normalizeExport(text: string): string {
  const noBom = text.replace(/^﻿/, "");
  const lf = noBom.replace(/\r\n/g, "\n");
  return lf.endsWith("\n") ? lf : `${lf}\n`;
}
