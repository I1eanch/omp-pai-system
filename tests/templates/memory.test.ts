import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "../..");
const memoryRoot = join(packageRoot, "templates", "MEMORY");
const emptyJsonlFiles = [
  "LEARNING/REFLECTIONS/algorithm-reflections.jsonl",
  "LEARNING/SIGNALS/ratings.jsonl",
] as const;
const forbiddenPrivatePatterns = [
  /\/Users\//u,
  /~\/\.claude/u,
  /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u,
  /(?:\+?\d[\s().-]*){10,}/u,
  /Nikolay|Николай|Kovelin|Ковелин/iu,
] as const;

describe("sanitized MEMORY starters", () => {
  test("define an empty portable layout and registries", () => {
    const layout = JSON.parse(readFileSync(join(memoryRoot, "layout.json"), "utf8"));
    expect(layout.schemaVersion).toBe(1);
    expect(layout.directories).toEqual([
      "WORK",
      "STATE",
      "LEARNING/REFLECTIONS",
      "LEARNING/SIGNALS",
      "LEARNING/FAILURES",
      "LEARNING/SYNTHESIS",
      "RAW",
    ]);

    const work = JSON.parse(readFileSync(join(memoryRoot, "STATE/work.json"), "utf8"));
    expect(work).toEqual({ schemaVersion: 1, sessions: {} });

    for (const relativePath of emptyJsonlFiles) {
      expect(statSync(join(memoryRoot, relativePath)).size, relativePath).toBe(0);
    }
  });

  test("contain no runtime or personal records", () => {
    const textFiles = [
      "README.md",
      "layout.json",
      "STATE/work.json",
      "STATE/work.schema.json",
      "LEARNING/README.md",
    ] as const;
    for (const relativePath of textFiles) {
      const content = readFileSync(join(memoryRoot, relativePath), "utf8");
      for (const pattern of forbiddenPrivatePatterns) {
        expect(pattern.test(content), `${relativePath}: ${pattern}`).toBe(false);
      }
    }
  });
});
