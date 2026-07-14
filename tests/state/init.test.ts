import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializePaiState } from "../../src/commands/init.ts";

const packageRoot = resolve(import.meta.dir, "../..");
const tempRoots: string[] = [];

function tempDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-pai-init-"));
  tempRoots.push(root);
  return join(root, "profile", "pai");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("initializePaiState", () => {
  test("creates portable TELOS, MEMORY, and PAI state locally", () => {
    const dataRoot = tempDataRoot();
    const report = initializePaiState({ pluginRoot: packageRoot, dataRoot });

    expect(report.created).toContain("TELOS/GOALS.md");
    expect(report.created).toContain("MEMORY/STATE/work.json");
    expect(report.directories).toContain("MEMORY/WORK");
    expect(report.directories).toContain("PAI/ACTIONS");
    expect(existsSync(join(dataRoot, "PAI/FLOWS"))).toBe(true);
    expect(existsSync(join(dataRoot, "PAI/PIPELINES"))).toBe(true);
    expect(readFileSync(join(dataRoot, "MEMORY/STATE/work.json"), "utf8")).toBe(
      '{\n  "schemaVersion": 1,\n  "sessions": {}\n}\n',
    );
    expect(readFileSync(
      join(dataRoot, "MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl"),
      "utf8",
    )).toBe("");
    const ownership = JSON.parse(
      readFileSync(join(dataRoot, ".omp-pai-ownership.json"), "utf8"),
    ) as {
      package: string;
      version: string;
      managedFiles: Array<{ path: string; sha256: string }>;
    };
    expect(ownership.package).toBe("omp-pai-system");
    expect(ownership.version).toBe("0.1.0");
    expect(ownership.managedFiles.some(({ path }) => path === "TELOS/GOALS.md")).toBe(true);
    expect(ownership.managedFiles.every(({ path, sha256 }) =>
      !path.startsWith("/") && /^[a-f0-9]{64}$/u.test(sha256)
    )).toBe(true);
  });

  test("is idempotent and preserves user changes and unknown files", () => {
    const dataRoot = tempDataRoot();
    initializePaiState({ pluginRoot: packageRoot, dataRoot });
    const goalsPath = join(dataRoot, "TELOS/GOALS.md");
    const userGoals = "user-owned goals\n";

    writeFileSync(goalsPath, userGoals);
    writeFileSync(join(dataRoot, "TELOS/LOCAL.md"), "private local record\n");

    const repeated = initializePaiState({ pluginRoot: packageRoot, dataRoot });

    expect(repeated.created).toEqual([]);
    expect(repeated.skipped).toContain("TELOS/GOALS.md");
    expect(readFileSync(goalsPath, "utf8")).toBe(userGoals);
    expect(readFileSync(join(dataRoot, "TELOS/LOCAL.md"), "utf8")).toBe(
      "private local record\n",
    );
  });

  test("rejects ownership entries outside the exact starter allowlist", () => {
    const dataRoot = tempDataRoot();
    initializePaiState({ pluginRoot: packageRoot, dataRoot });
    writeFileSync(
      join(dataRoot, ".omp-pai-ownership.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        package: "omp-pai-system",
        version: "0.1.0",
        managedFiles: [{ path: "TELOS/LOCAL.md", sha256: "0".repeat(64) }],
      })}\n`,
    );

    expect(() => initializePaiState({ pluginRoot: packageRoot, dataRoot }))
      .toThrow("Invalid ownership manifest");
  });

  test("rejects malformed ownership entries before filesystem access", () => {
    const dataRoot = tempDataRoot();
    initializePaiState({ pluginRoot: packageRoot, dataRoot });
    writeFileSync(
      join(dataRoot, ".omp-pai-ownership.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        package: "omp-pai-system",
        version: "0.1.0",
        managedFiles: [{ sha256: "0".repeat(64) }],
      })}\n`,
    );

    expect(() => initializePaiState({ pluginRoot: packageRoot, dataRoot }))
      .toThrow("Invalid ownership manifest");
  });

  test("fails closed on a symlink destination conflict", () => {
    const dataRoot = tempDataRoot();
    const outside = tempDataRoot();
    mkdirSync(join(dataRoot, "TELOS"), { recursive: true });
    symlinkSync(outside, join(dataRoot, "TELOS/GOALS.md"));

    expect(() => initializePaiState({ pluginRoot: packageRoot, dataRoot })).toThrow(
      "Refusing symlink destination",
    );
    expect(existsSync(join(outside, "GOALS.md"))).toBe(false);
  });
});
