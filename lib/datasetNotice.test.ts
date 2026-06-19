import { describe, expect, it } from "vitest";
import { hasDatasetNotice, type NoticeMessage } from "./datasetNotice";

const msg = (over: Partial<NoticeMessage>): NoticeMessage => ({
  isoTime: "2026-06-16T10:00:00.000Z",
  text: "",
  ...over,
});

describe("hasDatasetNotice", () => {
  it("matches a dataset keyword + ISO date within the window", () => {
    const msgs = [msg({ text: "Датасет за 2026-06-16 завантажено", isoTime: "2026-06-16T10:00:00Z" })];
    expect(hasDatasetNotice(msgs, "2026-06-16", "2026-06-19")).toBe(true);
  });

  it("matches the DD.MM.YYYY date format", () => {
    const msgs = [msg({ text: "датасет 16.06.2026 на драйві", isoTime: "2026-06-17T08:00:00Z" })];
    expect(hasDatasetNotice(msgs, "2026-06-16", "2026-06-19")).toBe(true);
  });

  it("matches an explicit no-dataset note for the day", () => {
    const msgs = [msg({ text: "16.06 немає датасету сьогодні", isoTime: "2026-06-16T18:00:00Z" })];
    expect(hasDatasetNotice(msgs, "2026-06-16", "2026-06-19")).toBe(true);
  });

  it("ignores a dataset message for a different date", () => {
    const msgs = [msg({ text: "Датасет за 2026-06-10", isoTime: "2026-06-16T10:00:00Z" })];
    expect(hasDatasetNotice(msgs, "2026-06-16", "2026-06-19")).toBe(false);
  });

  it("ignores a message posted after the window end", () => {
    const msgs = [msg({ text: "Датасет за 2026-06-16", isoTime: "2026-06-25T10:00:00Z" })];
    expect(hasDatasetNotice(msgs, "2026-06-16", "2026-06-19")).toBe(false);
  });

  it("ignores a dated message that lacks any dataset keyword", () => {
    const msgs = [msg({ text: "що там по 2026-06-16?", isoTime: "2026-06-16T10:00:00Z" })];
    expect(hasDatasetNotice(msgs, "2026-06-16", "2026-06-19")).toBe(false);
  });

  it("does not let a longer number satisfy the DD.MM form (116.069 ≠ 16.06)", () => {
    const msgs = [msg({ text: "датасет на 116.069 точок завантажено", isoTime: "2026-06-16T10:00:00Z" })];
    expect(hasDatasetNotice(msgs, "2026-06-16", "2026-06-19")).toBe(false);
  });
});
