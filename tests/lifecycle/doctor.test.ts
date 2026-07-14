import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializePaiState } from "../../src/commands/init.ts";
import { runPaiDoctor } from "../../src/commands/doctor.ts";

const packageRoot = resolve(import.meta.dir, "../..");
const algorithmPath = join(packageRoot, "templates/Algorithm/v3.5.0.md");
const temporaryRoots: string[] = [];

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `omp-pai-doctor-${label}-`));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runPaiDoctor", () => {
  test("passes a fully initialized portable installation", () => {
    const dataRoot = join(temporaryRoot("healthy"), "pai");
    initializePaiState({ pluginRoot: packageRoot, dataRoot });

    const report = runPaiDoctor({
      pluginRoot: packageRoot,
      dataRoot,
      algorithmPath,
      algorithmVersion: "3.5.0",
    });

    expect(report.checks.length).toBeGreaterThanOrEqual(9);
    expect(report.failed).toBe(0);
    expect(report.warned).toBe(0);
    expect(report.passed).toBe(report.checks.length);
  });

  test("passes a symlink override to a regular Algorithm file", () => {
    const root = temporaryRoot("algorithm-symlink");
    const dataRoot = join(root, "pai");
    const linkedAlgorithmPath = join(root, "v3.5.0.md");
    initializePaiState({ pluginRoot: packageRoot, dataRoot });
    symlinkSync(algorithmPath, linkedAlgorithmPath);

    const report = runPaiDoctor({
      pluginRoot: packageRoot,
      dataRoot,
      algorithmPath: linkedAlgorithmPath,
      algorithmVersion: "3.5.0",
    });

    expect(report.failed).toBe(0);
    expect(report.checks.find(({ id }) => id === "algorithm-source")?.status).toBe("pass");
    expect(report.checks.find(({ id }) => id === "algorithm-version")?.status).toBe("pass");
  });

  test("reports missing local state without creating it", () => {
    const dataRoot = join(temporaryRoot("missing"), "pai");

    const report = runPaiDoctor({
      pluginRoot: packageRoot,
      dataRoot,
      algorithmPath,
      algorithmVersion: "3.5.0",
    });

    expect(report.failed).toBe(0);
    expect(report.warned).toBeGreaterThan(0);
    expect(existsSync(dataRoot)).toBe(false);
  });

  test("fails closed when private state contains a symlink", () => {
    const dataRoot = join(temporaryRoot("unsafe"), "pai");
    initializePaiState({ pluginRoot: packageRoot, dataRoot });
    const outside = join(temporaryRoot("outside"), "secret.md");
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(dataRoot, "TELOS/LINK.md"));

    const report = runPaiDoctor({
      pluginRoot: packageRoot,
      dataRoot,
      algorithmPath,
      algorithmVersion: "3.5.0",
    });

    expect(report.failed).toBeGreaterThan(0);
    expect(report.checks.some(({ id, status }) =>
      id === "private-path-safety" && status === "fail"
    )).toBe(true);
  });

  test("fails closed when the configured data root is a symlink", () => {
    const realDataRoot = join(temporaryRoot("real-root"), "pai");
    initializePaiState({ pluginRoot: packageRoot, dataRoot: realDataRoot });
    const linkedDataRoot = join(temporaryRoot("linked-root"), "pai");
    symlinkSync(realDataRoot, linkedDataRoot);

    const report = runPaiDoctor({
      pluginRoot: packageRoot,
      dataRoot: linkedDataRoot,
      algorithmPath,
      algorithmVersion: "3.5.0",
    });

    expect(report.checks.some(({ id, status }) =>
      id === "state-root" && status === "fail"
    )).toBe(true);
    expect(report.checks.some(({ id, status }) =>
      id === "private-path-safety" && status === "fail"
    )).toBe(true);
  });
});
