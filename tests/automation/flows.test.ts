import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadFlowDefinition,
  readFlowState,
  runFlow,
} from "../../src/automation/flows.ts";

const roots: string[] = [];

function writeAction(dataRoot: string, id: string, expression: string): void {
  const directory = join(dataRoot, "PAI/ACTIONS", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "action.ts"), `const input = await new Response(Bun.stdin.stream()).json();\nconsole.log(JSON.stringify(${expression}));\n`);
  writeFileSync(join(directory, "action.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    entry: "action.ts",
    description: id,
    input: true,
    output: true,
    timeoutMs: 5_000,
  }));
}

function flowRoot(definition?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "omp-pai-flow-"));
  roots.push(root);
  const dataRoot = join(root, "pai");
  writeAction(dataRoot, "increment", "{ value: input.value + 1 }");
  writeAction(dataRoot, "double", "{ value: input.value * 2 }");
  const flowDirectory = join(dataRoot, "PAI/FLOWS");
  mkdirSync(flowDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(flowDirectory, "numbers.json"), JSON.stringify(definition ?? {
    schemaVersion: 1,
    id: "numbers",
    initial: "increment",
    states: {
      increment: { action: "increment", onSuccess: "double" },
      double: { action: "double", terminal: true },
    },
  }, null, 2));
  return dataRoot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Flows runtime", () => {
  test("executes deterministic transitions and persists completion", async () => {
    const dataRoot = flowRoot();
    expect(loadFlowDefinition(dataRoot, "numbers").sha256).toMatch(/^[a-f0-9]{64}$/u);
    const report = await runFlow(dataRoot, "numbers", { value: 2 });
    expect(report).toMatchObject({ status: "completed", output: { value: 6 }, steps: 2 });
    expect(readFlowState(dataRoot, "numbers")).toMatchObject({
      status: "completed",
      lastOutput: { value: 6 },
    });
    expect(await runFlow(dataRoot, "numbers", { value: 99 }, { resume: true }))
      .toMatchObject({ status: "completed", output: { value: 6 }, steps: 0 });
  });

  test("pauses and resumes only with the matching definition", async () => {
    const dataRoot = flowRoot({
      schemaVersion: 1,
      id: "numbers",
      initial: "increment",
      states: {
        increment: { action: "increment", onSuccess: "double", pause: true },
        double: { action: "double", terminal: true },
      },
    });
    expect(await runFlow(dataRoot, "numbers", { value: 2 })).toMatchObject({
      status: "paused",
      current: "double",
      output: { value: 3 },
    });
    writeAction(dataRoot, "increment", "{ value: input.value + 100 }");
    await expect(runFlow(dataRoot, "numbers", { value: 999 }, { resume: true }))
      .rejects.toThrow("action changed");
    writeAction(dataRoot, "increment", "{ value: input.value + 1 }");
    expect(await runFlow(dataRoot, "numbers", { value: 999 }, { resume: true }))
      .toMatchObject({ status: "completed", output: { value: 6 } });

    const definitionPath = join(dataRoot, "PAI/FLOWS/numbers.json");
    const changed = JSON.parse(await Bun.file(definitionPath).text()) as Record<string, unknown>;
    changed.note = "changed";
    writeFileSync(definitionPath, JSON.stringify(changed));
    await expect(runFlow(dataRoot, "numbers", {}, { resume: true }))
      .rejects.toThrow("definition");
  });

  test("persists typed action failures without automatic transition", async () => {
    const dataRoot = flowRoot();
    writeFileSync(
      join(dataRoot, "PAI/ACTIONS/increment/action.ts"),
      "console.error('failure'); process.exit(2);\n",
    );
    const report = await runFlow(dataRoot, "numbers", { value: 2 });
    expect(report.status).toBe("failed");
    expect(report.current).toBe("increment");
    expect(report.error).toContain("failure");
    expect(readFlowState(dataRoot, "numbers")?.lastInput).toEqual({ value: 2 });
  });

  test("validates graph invariants and step limits", async () => {
    expect(() => loadFlowDefinition(flowRoot({
      schemaVersion: 1,
      id: "numbers",
      initial: "missing",
      states: {},
    }), "numbers")).toThrow("invalid");
    expect(() => loadFlowDefinition(flowRoot({
      schemaVersion: 1,
      id: "numbers",
      initial: "loop",
      states: { loop: { action: "increment", onSuccess: "loop" } },
    }), "numbers")).not.toThrow();
    const cyclic = roots.at(-1)!;
    const cyclicDataRoot = join(cyclic, "pai");
    const report = await runFlow(cyclicDataRoot, "numbers", { value: 0 }, { maxSteps: 2 });
    expect(report).toMatchObject({ status: "failed", steps: 2 });
    expect(report.error).toContain("step limit");
    await expect(runFlow(cyclicDataRoot, "numbers", {}, { maxSteps: 0 }))
      .rejects.toThrow("maxSteps");
  });

  test("rejects malformed definitions and persisted state", async () => {
    const definitions: Array<{ value: unknown; message: string }> = [
      { value: null, message: "definition is invalid" },
      {
        value: { schemaVersion: 1, id: "numbers", initial: "bad", states: { bad: null } },
        message: "state is invalid",
      },
      {
        value: { schemaVersion: 1, id: "numbers", initial: "bad", states: {
          bad: { action: "increment", onSuccess: "bad", extra: true },
        } },
        message: "unknown fields",
      },
      {
        value: { schemaVersion: 1, id: "numbers", initial: "bad", states: {
          bad: { action: "increment", onSuccess: 1 },
        } },
        message: "transition is invalid",
      },
      {
        value: { schemaVersion: 1, id: "numbers", initial: "bad", states: {
          bad: { action: "increment", terminal: "yes" },
        } },
        message: "terminal flag",
      },
      {
        value: { schemaVersion: 1, id: "numbers", initial: "bad", states: {
          bad: { action: "increment", onSuccess: "bad", pause: "yes" },
        } },
        message: "pause flag",
      },
      {
        value: { schemaVersion: 1, id: "numbers", initial: "bad", states: {
          bad: { action: "increment", terminal: true, onSuccess: "bad" },
        } },
        message: "outgoing behavior",
      },
      {
        value: { schemaVersion: 1, id: "numbers", initial: "bad", states: {
          bad: { action: "increment", terminal: true, onSuccess: "" },
        } },
        message: "outgoing behavior",
      },
      {
        value: { schemaVersion: 1, id: "numbers", initial: "bad", states: {
          bad: { action: "increment" },
        } },
        message: "lacks onSuccess",
      },
      {
        value: { schemaVersion: 1, id: "numbers", initial: "bad", states: {
          bad: { action: "increment", onSuccess: "missing" },
        } },
        message: "Unknown flow transition",
      },
    ];
    for (const definition of definitions) {
      const dataRoot = flowRoot();
      writeFileSync(join(dataRoot, "PAI/FLOWS/numbers.json"), JSON.stringify(definition.value));
      expect(() => loadFlowDefinition(dataRoot, "numbers")).toThrow(definition.message);
    }
    const malformedRoot = flowRoot();
    writeFileSync(join(malformedRoot, "PAI/FLOWS/numbers.json"), "{");
    expect(() => loadFlowDefinition(malformedRoot, "numbers")).toThrow("invalid JSON");
    expect(() => loadFlowDefinition(malformedRoot, "../bad")).toThrow("Invalid flow id");

    const stateRoot = flowRoot();
    await runFlow(stateRoot, "numbers", { value: 1 });
    const statePath = join(stateRoot, "MEMORY/STATE/flows/numbers.json");
    const invalidCompleted = JSON.parse(await Bun.file(statePath).text()) as {
      completed: Record<string, unknown>;
    };
    invalidCompleted.completed.bad = { action: "increment", actionSha256: "bad" };
    writeFileSync(statePath, JSON.stringify(invalidCompleted));
    const mismatched = JSON.parse(await Bun.file(statePath).text()) as {
      completed: Record<string, { action: string; actionSha256: string }>;
    };
    delete mismatched.completed.bad;
    mismatched.completed.increment.action = "double";
    writeFileSync(statePath, JSON.stringify(mismatched));
    await expect(runFlow(stateRoot, "numbers", { value: 1 }, { resume: true }))
      .rejects.toThrow("saved action does not match");
    mismatched.completed.increment.action = "increment";
    mismatched.completed.bad = { action: "increment", actionSha256: "bad" };
    writeFileSync(statePath, JSON.stringify(mismatched));
    expect(() => readFlowState(stateRoot, "numbers")).toThrow("completed state is invalid");
    writeFileSync(statePath, "{");
    expect(() => readFlowState(stateRoot, "numbers")).toThrow("Flow state is invalid");
    writeFileSync(statePath, "{}");
    expect(() => readFlowState(stateRoot, "numbers")).toThrow("Flow state is invalid");
    expect(() => readFlowState(stateRoot, "../bad")).toThrow("Invalid flow id");
    await expect(runFlow(stateRoot, "numbers", Number.NaN)).rejects.toThrow("JSON-compatible");
  });
});
