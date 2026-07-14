import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "../..");
const telosRoot = join(packageRoot, "templates", "TELOS");
const starterFiles = [
  "BELIEFS.md",
  "CHALLENGES.md",
  "DECISIONS.md",
  "GOALS.md",
  "IDEAS.md",
  "LEARNED.md",
  "PROJECTS.md",
] as const;
const forbiddenPrivatePatterns = [
  /\/Users\//u,
  /~\/\.claude/u,
  /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u,
  /(?:\+?\d[\s().-]*){10,}/u,
  /Nikolay|Николай|Kovelin|Ковелин/iu,
] as const;

describe("sanitized TELOS starters", () => {
  test("provide schema-backed empty records", () => {
    const schema = JSON.parse(readFileSync(join(telosRoot, "schema.json"), "utf8"));
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.properties.record_type.enum).toEqual([
      "beliefs",
      "challenges",
      "decisions",
      "goals",
      "ideas",
      "learned",
      "projects",
    ]);

    for (const filename of starterFiles) {
      const content = readFileSync(join(telosRoot, filename), "utf8");
      expect(content.startsWith("---\n"), filename).toBe(true);
      expect(content).toContain("schema_version: 1");
      expect(content).toContain("status: starter");
      expect(content).toContain("## Entries\n");
      expect(content).not.toMatch(/^\s*-\s+\S+/mu);
    }
  });

  test("contain no personal or host-specific values", () => {
    for (const filename of ["README.md", ...starterFiles]) {
      const content = readFileSync(join(telosRoot, filename), "utf8");
      for (const pattern of forbiddenPrivatePatterns) {
        expect(pattern.test(content), `${filename}: ${pattern}`).toBe(false);
      }
    }
  });
});
