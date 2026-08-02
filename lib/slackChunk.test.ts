import { describe, expect, it } from "vitest";
import { chunkForSlack, SLACK_MSG_MAX_BYTES } from "./slackChunk";

const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe("chunkForSlack", () => {
  it("returns short text as a single chunk, verbatim", () => {
    expect(chunkForSlack("привіт")).toEqual(["привіт"]);
  });

  it("returns empty text as a single empty chunk", () => {
    expect(chunkForSlack("")).toEqual([""]);
  });

  it("keeps a text exactly at the limit unsplit", () => {
    const text = "a".repeat(100);
    expect(chunkForSlack(text, 100)).toEqual([text]);
  });

  it("splits at line boundaries and keeps every chunk under the limit", () => {
    const line = "— ATP-1586 — Інформативне ОСД для Вартового з оптимізацією CPU";
    const text = Array.from({ length: 80 }, () => line).join("\n");
    const chunks = chunkForSlack(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(bytes(c)).toBeLessThanOrEqual(1000);
    // Lossless: concatenation reassembles the original.
    expect(chunks.join("")).toBe(text);
    // Splits happen at line boundaries: every chunk but the last ends with \n.
    for (const c of chunks.slice(0, -1)) expect(c.endsWith("\n")).toBe(true);
  });

  it("counts bytes, not characters (Cyrillic is 2 bytes/char)", () => {
    const text = `${"б".repeat(300)}\n${"в".repeat(300)}`;
    const chunks = chunkForSlack(text, 700);
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(bytes(c)).toBeLessThanOrEqual(700);
  });

  it("hard-splits a single overlong line without breaking code points", () => {
    const text = "щ".repeat(5000); // 10k bytes, no newlines
    const chunks = chunkForSlack(text, 3000);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(3000);
      expect(c).toMatch(/^щ+$/); // no mangled partial code points
    }
    expect(chunks.join("")).toBe(text);
  });

  it("never emits an empty chunk when splitting", () => {
    const text = "a\n\n\nb\n".repeat(500);
    const chunks = chunkForSlack(text, 100);
    for (const c of chunks) expect(c.length).toBeGreaterThan(0);
    expect(chunks.join("")).toBe(text);
  });

  it("real failure case: a 6091-char / ~10k-byte answer splits under the default limit", () => {
    const line = "• ATP-1607 — Проаналізувати актуальний класифікатор на відео з поля 25.05-31.05\n";
    const text = line.repeat(70); // ≈ 10k bytes, like the 2026-08-01 answer
    const chunks = chunkForSlack(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(bytes(c)).toBeLessThanOrEqual(SLACK_MSG_MAX_BYTES);
    expect(chunks.join("")).toBe(text);
  });
});
