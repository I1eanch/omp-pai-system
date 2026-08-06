import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPipelineDefinition,
  readPipelineState,
  runPipeline,
} from "../../src/automation/pipelines.ts";

const roots: string[] = [];

function writeAction(dataRoot: string, id: string, body: string): void {
  const directory = join(dataRoot, "PAI/ACTIONS", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "action.ts"), body);
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

function pipelineRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-pai-pipeline-"));
  roots.push(root);
  const dataRoot = join(root, "pai");
  writeAction(
    dataRoot,
    "normalize",
    "const input = await new Response(Bun.stdin.stream()).json(); console.log(JSON.stringify({title: input.title.trim().toLowerCase()}));\n",
  );
  writeAction(
    dataRoot,
    "format",
    "const input = await new Response(Bun.stdin.stream()).json(); console.log(JSON.stringify({result: input.value + '!'}));\n",
  );
  const directory = join(dataRoot, "PAI/PIPELINES");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "publish.json"), JSON.stringify({
    schemaVersion: 1,
    id: "publish",
    steps: [
      { id: "normalize", action: "normalize", input: "$pipeline.input" },
      {
        id: "format",
        action: "format",
        input: { value: "$steps.normalize.output.title" },
      },
    ],
  }, null, 2));
  return dataRoot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pipelines runtime", () => {
  test("executes ordered references and persists checksummed outputs", async () => {
    const dataRoot = pipelineRoot();
    expect(loadPipelineDefinition(dataRoot, "publish").sha256).toMatch(/^[a-f0-9]{64}$/u);
    const report = await runPipeline(dataRoot, "publish", { title: "  HELLO  " });
    expect(report).toEqual({
      pipelineId: "publish",
      status: "completed",
      completed: 2,
      output: { result: "hello!" },
    });
    expect(readPipelineState(dataRoot, "publish")).toMatchObject({
      status: "completed",
      completed: {
        normalize: { output: { title: "hello" } },
        format: { output: { result: "hello!" } },
      },
    });
    expect(await runPipeline(dataRoot, "publish", { title: "  HELLO  " }, { resume: true }))
      .toMatchObject({ status: "completed", completed: 2 });
    writeAction(dataRoot, "format", "console.log(JSON.stringify({result:'changed'}));\n");
    await expect(runPipeline(dataRoot, "publish", { title: "  HELLO  " }, { resume: true }))
      .rejects.toThrow("action changed");
  });

  test("resumes after a failed step without rerunning completed output", async () => {
    const dataRoot = pipelineRoot();
    const formatPath = join(dataRoot, "PAI/ACTIONS/format/action.ts");
    writeFileSync(formatPath, "console.error('broken'); process.exit(3);\n");
    expect(await runPipeline(dataRoot, "publish", { title: "Hi" })).toMatchObject({
      status: "failed",
      completed: 1,
      failedStep: "format",
    });
    const normalizeOutput = readPipelineState(dataRoot, "publish")?.completed.normalize?.output;
    const statePath = join(dataRoot, "MEMORY/STATE/pipelines/publish.json");
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as {
      completed: Record<string, { action: string }>;
    };
    saved.completed.normalize!.action = "format";
    writeFileSync(statePath, JSON.stringify(saved));
    await expect(runPipeline(dataRoot, "publish", { title: "Hi" }, { resume: true }))
      .rejects.toThrow("does not match definition");
    saved.completed.normalize!.action = "normalize";
    writeFileSync(statePath, JSON.stringify(saved));
    writeAction(dataRoot, "normalize", "console.log(JSON.stringify({title:'changed'}));\n");
    await expect(runPipeline(dataRoot, "publish", { title: "Hi" }, { resume: true }))
      .rejects.toThrow("action changed");
    writeAction(
      dataRoot,
      "normalize",
      "const input = await new Response(Bun.stdin.stream()).json(); console.log(JSON.stringify({title: input.title.trim().toLowerCase()}));\n",
    );
    writeAction(
      dataRoot,
      "format",
      "const input = await new Response(Bun.stdin.stream()).json(); console.log(JSON.stringify({result: input.value + '!'}));\n",
    );
    expect(await runPipeline(dataRoot, "publish", { title: "Hi" }, { resume: true }))
      .toMatchObject({ status: "completed", output: { result: "hi!" } });
    expect(readPipelineState(dataRoot, "publish")?.completed.normalize?.output).toEqual(normalizeOutput);
  });

  test("rejects forward references and changed resume inputs", async () => {
    const dataRoot = pipelineRoot();
    const definitionPath = join(dataRoot, "PAI/PIPELINES/publish.json");
    const definition = JSON.parse(readFileSync(definitionPath, "utf8")) as {
      steps: Array<{ input: unknown }>;
    };
    definition.steps[0]!.input = "$steps.format.output";
    writeFileSync(definitionPath, JSON.stringify({
      schemaVersion: 1,
      id: "publish",
      steps: definition.steps,
    }));
    expect(() => loadPipelineDefinition(dataRoot, "publish")).toThrow("unfinished step");

    const cleanRoot = pipelineRoot();
    await runPipeline(cleanRoot, "publish", { title: "one" });
    await expect(runPipeline(cleanRoot, "publish", { title: "two" }, { resume: true }))
      .rejects.toThrow("input changed");
  });

  test("detects tampered persisted outputs", async () => {
    const dataRoot = pipelineRoot();
    await runPipeline(dataRoot, "publish", { title: "hello" });
    const statePath = join(dataRoot, "MEMORY/STATE/pipelines/publish.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      completed: Record<string, { output: unknown }>;
    };
    state.completed.normalize!.output = { title: "tampered" };
    writeFileSync(statePath, JSON.stringify(state));
    expect(() => readPipelineState(dataRoot, "publish")).toThrow("completed step is invalid");
  });

  test("rejects unknown and non-prefix completed checkpoints", async () => {
    const dataRoot = pipelineRoot();
    await runPipeline(dataRoot, "publish", { title: "hello" });
    const statePath = join(dataRoot, "MEMORY/STATE/pipelines/publish.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      status: string;
      completed: Record<string, unknown>;
    };
    state.status = "failed";
    state.completed.extra = state.completed.normalize;
    writeFileSync(statePath, JSON.stringify(state));
    await expect(runPipeline(dataRoot, "publish", { title: "hello" }, { resume: true }))
      .rejects.toThrow("unknown step");
    delete state.completed.extra;
    delete state.completed.normalize;
    writeFileSync(statePath, JSON.stringify(state));
    await expect(runPipeline(dataRoot, "publish", { title: "hello" }, { resume: true }))
      .rejects.toThrow("completed prefix");
    state.status = "completed";
    state.completed.normalize = JSON.parse(readFileSync(statePath, "utf8")).completed?.normalize
      ?? state.completed.normalize;
    delete state.completed.format;
    writeFileSync(statePath, JSON.stringify(state));
    await expect(runPipeline(dataRoot, "publish", { title: "hello" }, { resume: true }))
      .rejects.toThrow("missing steps");
  });

  test("rejects malformed definitions, references, and persisted state", async () => {
    const malformedRoot = pipelineRoot();
    const malformedPath = join(malformedRoot, "PAI/PIPELINES/publish.json");
    writeFileSync(malformedPath, "{");
    expect(() => loadPipelineDefinition(malformedRoot, "publish")).toThrow("invalid JSON");
    writeFileSync(malformedPath, JSON.stringify({ schemaVersion: 1, id: "publish", steps: [] }));
    expect(() => loadPipelineDefinition(malformedRoot, "publish")).toThrow("definition is invalid");
    writeFileSync(malformedPath, JSON.stringify({
      schemaVersion: 1,
      id: "publish",
      steps: [null],
    }));
    expect(() => loadPipelineDefinition(malformedRoot, "publish")).toThrow("step is invalid");
    writeFileSync(malformedPath, JSON.stringify({
      schemaVersion: 1,
      id: "publish",
      steps: [
        { id: "same", action: "normalize", input: "$pipeline.input" },
        { id: "same", action: "normalize", input: "$pipeline.input" },
      ],
    }));
    expect(() => loadPipelineDefinition(malformedRoot, "publish")).toThrow("Duplicate");
    writeFileSync(malformedPath, JSON.stringify({
      schemaVersion: 1,
      id: "publish",
      steps: [{ id: "bad", action: "normalize", input: "$invalid" }],
    }));
    expect(() => loadPipelineDefinition(malformedRoot, "publish")).toThrow("reference is invalid");
    expect(() => loadPipelineDefinition(malformedRoot, "../bad")).toThrow("Invalid pipeline id");

    const nestedRoot = pipelineRoot();
    writeFileSync(join(nestedRoot, "PAI/PIPELINES/publish.json"), JSON.stringify({
      schemaVersion: 1,
      id: "publish",
      steps: [{
        id: "format",
        action: "format",
        input: { value: ["$pipeline.input.value"], literal: "ok" },
      }],
    }));
    expect(await runPipeline(nestedRoot, "publish", { value: "x" }))
      .toMatchObject({ status: "completed", output: { result: "x!" } });

    const unresolvedRoot = pipelineRoot();
    const unresolvedPath = join(unresolvedRoot, "PAI/PIPELINES/publish.json");
    writeFileSync(unresolvedPath, JSON.stringify({
      schemaVersion: 1,
      id: "publish",
      steps: [{
        id: "format",
        action: "format",
        input: { value: "$pipeline.input.missing" },
      }],
    }));
    expect(await runPipeline(unresolvedRoot, "publish", { value: "x" }))
      .toMatchObject({ status: "failed", failedStep: "format" });

    const stateRoot = pipelineRoot();
    await runPipeline(stateRoot, "publish", { title: "x" });
    const statePath = join(stateRoot, "MEMORY/STATE/pipelines/publish.json");
    writeFileSync(statePath, "{");
    expect(() => readPipelineState(stateRoot, "publish")).toThrow("state is invalid");
    writeFileSync(statePath, "{}");
    expect(() => readPipelineState(stateRoot, "publish")).toThrow("state is invalid");
    expect(() => readPipelineState(stateRoot, "../bad")).toThrow("Invalid pipeline id");
    await expect(runPipeline(stateRoot, "publish", Number.NaN)).rejects.toThrow("JSON-compatible");
  });

  test("rejects resume after a pipeline definition change", async () => {
    const dataRoot = pipelineRoot();
    writeFileSync(join(dataRoot, "PAI/ACTIONS/format/action.ts"), "process.exit(2);\n");
    await runPipeline(dataRoot, "publish", { title: "x" });
    const path = join(dataRoot, "PAI/PIPELINES/publish.json");
    const definition = readFileSync(path, "utf8");
    writeFileSync(path, `${definition}\n`);
    await expect(runPipeline(dataRoot, "publish", { title: "x" }, { resume: true }))
      .rejects.toThrow("definition changed");
  });
});
