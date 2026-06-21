import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readManifest, readState, writeState } from "./driveStore";

function tmp(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "drive-")), "drive");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("driveStore", () => {
  it("reads a valid manifest", () => {
    const baseDir = tmp();
    writeFileSync(
      join(baseDir, "manifest.json"),
      JSON.stringify({
        sources: [
          { id: "rules", url: "https://docs.google.com/document/d/DOC1/edit", type: "doc", dest: "docs/drive/rules.md" },
        ],
      }),
    );
    const m = readManifest({ baseDir });
    expect(m.sources[0].id).toBe("rules");
  });

  it("returns {} when state is absent", () => {
    expect(readState({ baseDir: tmp() })).toEqual({});
  });

  it("round-trips state through writeState/readState", () => {
    const baseDir = tmp();
    const state = {
      rules: { modifiedTime: "2026-06-18T09:00:00Z", pulledAt: "2026-06-19T20:00:00Z", dest: "docs/drive/rules.md" },
    };
    const path = writeState(state, { baseDir });
    expect(readFileSync(path, "utf8")).toContain("modifiedTime");
    expect(readState({ baseDir })).toEqual(state);
  });
});
