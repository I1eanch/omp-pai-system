import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "../..");
const requiredPortableTemplates = [
  "templates/PAI/README.md",
  "templates/PAI/PRDFORMAT.md",
  "templates/PAI/CONTEXT_ROUTING.md",
  "templates/PAI/ACTIONS/README.md",
  "templates/PAI/FLOWS/README.md",
  "templates/PAI/PIPELINES/README.md",
] as const;
const forbiddenPortablePatterns = [
  /\/Users\//u,
  /~\/\.claude/u,
  /\.claude\/PAI/u,
  /\.claude\/MEMORY/u,
  /process\.env\.HOME/u,
  /homedir\(\)/u,
] as const;

describe("bundled PAI templates", () => {
  test("provide the portable core specifications", () => {
    for (const relativePath of requiredPortableTemplates) {
      const content = readFileSync(join(packageRoot, relativePath), "utf8");
      expect(content.trim().length, relativePath).toBeGreaterThan(100);
      for (const pattern of forbiddenPortablePatterns) {
        expect(pattern.test(content), `${relativePath}: ${pattern}`).toBe(false);
      }
    }
  });

  test("tracks the licensed portable Algorithm v3.5.0 derivative exactly", () => {
    const content = readFileSync(
      join(packageRoot, "templates/Algorithm/v3.5.0.md"),
    );
    const digest = new Bun.CryptoHasher("sha256").update(content).digest("hex");
    expect(digest).toBe(
      "2ba1c649780ccc60be4065375c40c2664993e928d0ff4d5c4775267e4c8a35ae",
    );
  });
});
