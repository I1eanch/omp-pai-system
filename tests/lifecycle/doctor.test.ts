import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runPaiDoctor } from "../../src/commands/doctor.ts";
import { initializePaiState } from "../../src/commands/init.ts";

const packageRoot = resolve(import.meta.dir, "../..");
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
  test("passes schema, permission, and package checks for initialized state", () => {
    const dataRoot = join(temporaryRoot("healthy"), "pai");
    initializePaiState({ pluginRoot: packageRoot, dataRoot });
    const actionRoot = join(dataRoot, "PAI/ACTIONS/echo");
    mkdirSync(actionRoot, { mode: 0o700 });
    writeFileSync(join(actionRoot, "action.ts"), "console.log('{}');\n", { mode: 0o600 });
    writeFileSync(join(actionRoot, "action.json"), JSON.stringify({
      schemaVersion: 1,
      id: "echo",
      entry: "action.ts",
      description: "echo",
      input: true,
      output: true,
      timeoutMs: 1000,
    }), { mode: 0o600 });
    writeFileSync(join(dataRoot, "PAI/FLOWS/echo.json"), JSON.stringify({
      schemaVersion: 1,
      id: "echo",
      initial: "done",
      states: { done: { action: "echo", terminal: true } },
    }), { mode: 0o600 });
    writeFileSync(join(dataRoot, "PAI/PIPELINES/echo.json"), JSON.stringify({
      schemaVersion: 1,
      id: "echo",
      steps: [{ id: "echo", action: "echo", input: "$pipeline.input" }],
    }), { mode: 0o600 });
    const report = runPaiDoctor({ pluginRoot: packageRoot, dataRoot });
    expect(report.failed).toBe(0);
    expect(report.warned).toBe(0);
    expect(report.passed).toBe(report.checks.length);
    expect(report.checks.find(({ id }) => id === "private-permissions")?.status).toBe("pass");
    expect(report.checks.find(({ id }) => id === "telos-state")?.status).toBe("pass");
    expect(report.checks.find(({ id }) => id === "memory-state")?.status).toBe("pass");
  });

  test("reports missing local state read-only", () => {
    const dataRoot = join(temporaryRoot("missing"), "pai");
    const report = runPaiDoctor({ pluginRoot: packageRoot, dataRoot });
    expect(report.failed).toBe(0);
    expect(report.warned).toBeGreaterThan(0);
    expect(existsSync(dataRoot)).toBe(false);
  });

  test("fails closed on broad private permissions and invalid schema", () => {
    const dataRoot = join(temporaryRoot("permissions"), "pai");
    initializePaiState({ pluginRoot: packageRoot, dataRoot });
    chmodSync(join(dataRoot, "TELOS/GOALS.md"), 0o644);
    writeFileSync(join(dataRoot, "MEMORY/layout.json"), "{}\n", { mode: 0o600 });
    chmodSync(join(dataRoot, "MEMORY/layout.json"), 0o600);
    const report = runPaiDoctor({ pluginRoot: packageRoot, dataRoot });
    expect(report.checks.find(({ id }) => id === "private-permissions")?.status).toBe("fail");
    expect(report.checks.find(({ id }) => id === "memory-state")?.status).toBe("fail");
  });

  test("reports malformed TELOS, registry, automation, and private file types", () => {
    const dataRoot = join(temporaryRoot("malformed-state"), "pai");
    initializePaiState({ pluginRoot: packageRoot, dataRoot });
    writeFileSync(join(dataRoot, "TELOS/schema.json"), "{}\n");
    chmodSync(join(dataRoot, "TELOS/schema.json"), 0o600);
    writeFileSync(join(dataRoot, "MEMORY/STATE/work.json"), "{}\n");
    chmodSync(join(dataRoot, "MEMORY/STATE/work.json"), 0o600);
    writeFileSync(join(dataRoot, "PAI/ACTIONS/stray.txt"), "x", { mode: 0o600 });
    const fifo = join(dataRoot, "private-fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    chmodSync(fifo, 0o600);
    const report = runPaiDoctor({ pluginRoot: packageRoot, dataRoot });
    expect(report.checks.find(({ id }) => id === "telos-state")?.status).toBe("fail");
    expect(report.checks.find(({ id }) => id === "memory-state")?.status).toBe("fail");
    expect(report.checks.find(({ id }) => id === "automation-definitions")?.status).toBe("fail");
    expect(report.checks.find(({ id }) => id === "private-permissions")?.status).toBe("fail");
    writeFileSync(join(dataRoot, "TELOS/schema.json"), JSON.stringify({
      properties: { record_type: { enum: [] }, status: { enum: [] } },
    }));
    chmodSync(join(dataRoot, "TELOS/schema.json"), 0o600);
    rmSync(join(dataRoot, "PAI/ACTIONS/stray.txt"));
    writeFileSync(join(dataRoot, "PAI/FLOWS/stray.md"), "x", { mode: 0o600 });
    writeFileSync(join(dataRoot, ".omp-pai-ownership.json"), "{}\n", { mode: 0o600 });
    chmodSync(join(dataRoot, ".omp-pai-ownership.json"), 0o600);
    const second = runPaiDoctor({ pluginRoot: packageRoot, dataRoot });
    expect(second.checks.find(({ id }) => id === "telos-state")?.status).toBe("fail");
    expect(second.checks.find(({ id }) => id === "automation-definitions")?.status).toBe("fail");
    expect(second.checks.find(({ id }) => id === "ownership")?.status).toBe("fail");
  });

  test("reports unreadable package metadata", () => {
    const pluginRoot = temporaryRoot("missing-package");
    const report = runPaiDoctor({
      pluginRoot,
      dataRoot: join(temporaryRoot("missing-package-state"), "pai"),
    });
    expect(report.checks.find(({ id }) => id === "package")).toMatchObject({
      status: "fail",
      message: "Package metadata is unreadable",
    });
  });

  test("fails closed when private state contains a symlink", () => {
    const dataRoot = join(temporaryRoot("unsafe"), "pai");
    initializePaiState({ pluginRoot: packageRoot, dataRoot });
    const outside = join(temporaryRoot("outside"), "secret.md");
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(dataRoot, "TELOS/LINK.md"));
    const report = runPaiDoctor({ pluginRoot: packageRoot, dataRoot });
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
    const report = runPaiDoctor({ pluginRoot: packageRoot, dataRoot: linkedDataRoot });
    expect(report.checks.some(({ id, status }) => id === "state-root" && status === "fail"))
      .toBe(true);
    expect(report.checks.some(({ id, status }) =>
      id === "private-path-safety" && status === "fail"
    )).toBe(true);
  });
});
