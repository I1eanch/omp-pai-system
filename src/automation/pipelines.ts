import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isUnknownRecord } from "../type-guards.ts";
import { atomicWriteStateText, readStateText, resolveStatePath } from "../state/safe-state.ts";
import {
  actionDefinitionSha256,
  executeAction,
  loadActionManifest,
} from "./actions.ts";
import { isJsonValue, type JsonValue } from "./json-schema.ts";

export type PipelineStep = {
  id: string;
  action: string;
  input: JsonValue;
};

export type PipelineDefinition = {
  schemaVersion: 1;
  id: string;
  steps: PipelineStep[];
};

export type CompletedPipelineStep = {
  action: string;
  actionSha256: string;
  output: JsonValue;
  outputSha256: string;
};

export type PipelineRunState = {
  schemaVersion: 1;
  pipelineId: string;
  definitionSha256: string;
  inputSha256: string;
  status: "running" | "failed" | "completed";
  completed: Record<string, CompletedPipelineStep>;
  failedStep?: string;
  error?: string;
  updated: string;
};

export type PipelineRunReport = {
  pipelineId: string;
  status: PipelineRunState["status"];
  completed: number;
  output?: JsonValue;
  failedStep?: string;
  error?: string;
};
export type RunPipelineOptions = {
  resume?: boolean;
  signal?: AbortSignal;
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const REFERENCE_PATTERN = /^\$(pipeline\.input|steps\.([a-z0-9][a-z0-9-]{0,63})\.output)(?:\.([A-Za-z0-9_.-]+))?$/u;

function digestJson(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function validateReferences(
  template: JsonValue,
  previous: ReadonlySet<string>,
  stepId: string,
): void {
  if (typeof template === "string" && template.startsWith("$")) {
    const match = template.match(REFERENCE_PATTERN);
    if (!match) throw new Error(`Pipeline reference is invalid: ${template}`);
    const referenced = match[2];
    if (referenced && !previous.has(referenced)) {
      throw new Error(`Pipeline step references unfinished step ${referenced}: ${stepId}`);
    }
    return;
  }
  if (Array.isArray(template)) {
    for (const item of template) validateReferences(item, previous, stepId);
    return;
  }
  if (isUnknownRecord(template)) {
    for (const value of Object.values(template)) validateReferences(value, previous, stepId);
  }
}


/** Loads an ordered Pipeline and rejects duplicates or unsafe forward references. */
export function loadPipelineDefinition(
  dataRoot: string,
  pipelineId: string,
): PipelineDefinition & { sha256: string } {
  if (!ID_PATTERN.test(pipelineId)) throw new Error(`Invalid pipeline id: ${pipelineId}`);
  const path = `PAI/PIPELINES/${pipelineId}.json`;
  const content = readStateText(dataRoot, path, 2 * 1024 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Pipeline definition is invalid JSON: ${pipelineId}`, { cause: error });
  }
  if (
    !isUnknownRecord(parsed)
    || parsed.schemaVersion !== 1
    || parsed.id !== pipelineId
    || !Array.isArray(parsed.steps)
    || parsed.steps.length === 0
    || parsed.steps.length > 1_000
  ) {
    throw new Error(`Pipeline definition is invalid: ${pipelineId}`);
  }

  const steps: PipelineStep[] = [];
  const previous = new Set<string>();
  for (const raw of parsed.steps) {
    if (
      !isUnknownRecord(raw)
      || typeof raw.id !== "string"
      || !ID_PATTERN.test(raw.id)
      || typeof raw.action !== "string"
      || !ID_PATTERN.test(raw.action)
      || !isJsonValue(raw.input)
      || Object.keys(raw).some((key) => !["id", "action", "input"].includes(key))
    ) {
      throw new Error(`Pipeline step is invalid: ${pipelineId}`);
    }
    if (previous.has(raw.id)) throw new Error(`Duplicate pipeline step id: ${raw.id}`);
    validateReferences(raw.input, previous, raw.id);
    previous.add(raw.id);
    steps.push({ id: raw.id, action: raw.action, input: raw.input });
  }
  return {
    schemaVersion: 1,
    id: pipelineId,
    steps,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function propertyAt(value: JsonValue, propertyPath: string | undefined, reference: string): JsonValue {
  if (!propertyPath) return value;
  let current: JsonValue = value;
  for (const part of propertyPath.split(".")) {
    if (!isUnknownRecord(current) || !(part in current) || !isJsonValue(current[part])) {
      throw new Error(`Pipeline reference is unresolved: ${reference}`);
    }
    current = current[part];
  }
  return current;
}

function resolveStepInput(
  template: JsonValue,
  pipelineInput: JsonValue,
  completed: Record<string, CompletedPipelineStep>,
): JsonValue {
  if (typeof template === "string" && template.startsWith("$")) {
    const match = template.match(REFERENCE_PATTERN);
    if (!match) throw new Error(`Pipeline reference is invalid: ${template}`);
    if (match[1] === "pipeline.input") {
      return propertyAt(pipelineInput, match[3], template);
    }
    const stepId = match[2]!;
    const step = completed[stepId];
    if (!step) throw new Error(`Pipeline reference is unresolved: ${template}`);
    return propertyAt(step.output, match[3], template);
  }
  if (Array.isArray(template)) {
    return template.map((item) => resolveStepInput(item, pipelineInput, completed));
  }
  if (isUnknownRecord(template)) {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [
      key,
      resolveStepInput(value, pipelineInput, completed),
    ]));
  }
  return template;
}

function pipelineStatePath(pipelineId: string): string {
  return `MEMORY/STATE/pipelines/${pipelineId}.json`;
}

function writePipelineState(dataRoot: string, state: PipelineRunState): void {
  atomicWriteStateText(
    dataRoot,
    pipelineStatePath(state.pipelineId),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

/** Reads and verifies a Pipeline checkpoint, including stored output digests. */
export function readPipelineState(dataRoot: string, pipelineId: string): PipelineRunState | null {
  if (!ID_PATTERN.test(pipelineId)) throw new Error(`Invalid pipeline id: ${pipelineId}`);
  const path = pipelineStatePath(pipelineId);
  if (!lstatSync(resolveStatePath(dataRoot, path), { throwIfNoEntry: false })) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readStateText(dataRoot, path, 16 * 1024 * 1024));
  } catch (error) {
    throw new Error(`Pipeline state is invalid: ${pipelineId}`, { cause: error });
  }
  if (
    !isUnknownRecord(parsed)
    || parsed.schemaVersion !== 1
    || parsed.pipelineId !== pipelineId
    || typeof parsed.definitionSha256 !== "string"
    || typeof parsed.inputSha256 !== "string"
    || !["running", "failed", "completed"].includes(String(parsed.status))
    || !isUnknownRecord(parsed.completed)
    || typeof parsed.updated !== "string"
    || Number.isNaN(Date.parse(parsed.updated))
  ) {
    throw new Error(`Pipeline state is invalid: ${pipelineId}`);
  }
  for (const [stepId, raw] of Object.entries(parsed.completed)) {
    if (
      !ID_PATTERN.test(stepId)
      || !isUnknownRecord(raw)
      || typeof raw.action !== "string"
      || !ID_PATTERN.test(raw.action)
      || typeof raw.actionSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(raw.actionSha256)
      || !isJsonValue(raw.output)
      || typeof raw.outputSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(raw.outputSha256)
      || Object.keys(raw).some((key) =>
        !["action", "actionSha256", "output", "outputSha256"].includes(key)
      )
      || digestJson(raw.output) !== raw.outputSha256
    ) {
      throw new Error(`Pipeline completed step is invalid: ${pipelineId}/${stepId}`);
    }
  }
  return parsed as unknown as PipelineRunState;
}

/** Runs or resumes a checksum-bound Pipeline and persists each completed prefix. */
export async function runPipeline(
  dataRoot: string,
  pipelineId: string,
  input: JsonValue,
  options: RunPipelineOptions = {},
): Promise<PipelineRunReport> {
  if (!isJsonValue(input)) throw new Error("Pipeline input must be JSON-compatible");
  const definition = loadPipelineDefinition(dataRoot, pipelineId);
  const inputSha256 = digestJson(input);
  const saved = options.resume ? readPipelineState(dataRoot, pipelineId) : null;
  if (saved && saved.definitionSha256 !== definition.sha256) {
    throw new Error(`Pipeline definition changed since saved state: ${pipelineId}`);
  }
  if (saved && saved.inputSha256 !== inputSha256) {
    throw new Error(`Pipeline input changed since saved state: ${pipelineId}`);
  }

  let state: PipelineRunState = saved ?? {
    schemaVersion: 1,
    pipelineId,
    definitionSha256: definition.sha256,
    inputSha256,
    status: "running",
    completed: {},
    updated: new Date().toISOString(),
  };
  const expectedStepIds = new Set(definition.steps.map(({ id }) => id));
  if (Object.keys(state.completed).some((stepId) => !expectedStepIds.has(stepId))) {
    throw new Error(`Pipeline saved state contains an unknown step: ${pipelineId}`);
  }
  let sawIncomplete = false;
  for (const step of definition.steps) {
    const completed = state.completed[step.id];
    if (!completed) {
      sawIncomplete = true;
      continue;
    }
    if (sawIncomplete) {
      throw new Error(`Pipeline saved steps are not a completed prefix: ${pipelineId}/${step.id}`);
    }
    if (completed.action !== step.action) {
      throw new Error(`Pipeline saved action does not match definition: ${step.id}`);
    }
    const currentActionSha = actionDefinitionSha256(
      dataRoot,
      loadActionManifest(dataRoot, step.action),
    );
    if (currentActionSha !== completed.actionSha256) {
      throw new Error(`Pipeline action changed since saved state: ${step.id}`);
    }
  }
  if (state.status === "completed" && Object.keys(state.completed).length !== definition.steps.length) {
    throw new Error(`Completed pipeline state is missing steps: ${pipelineId}`);
  }
  if (state.status === "completed") {
    const last = definition.steps.at(-1)!;
    return {
      pipelineId,
      status: "completed",
      completed: definition.steps.length,
      output: state.completed[last.id]?.output,
    };
  }

  for (const step of definition.steps) {
    const completed = state.completed[step.id];
    if (completed) continue;

    try {
      const stepInput = resolveStepInput(step.input, input, state.completed);
      const action = await executeAction(
        dataRoot,
        step.action,
        stepInput,
        { signal: options.signal },
      );
      state = {
        ...state,
        status: "running",
        failedStep: undefined,
        error: undefined,
        completed: {
          ...state.completed,
          [step.id]: {
            action: step.action,
            actionSha256: action.definitionSha256,
            output: action.output,
            outputSha256: digestJson(action.output),
          },
        },
        updated: new Date().toISOString(),
      };
      writePipelineState(dataRoot, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = {
        ...state,
        status: "failed",
        failedStep: step.id,
        error: message,
        updated: new Date().toISOString(),
      };
      writePipelineState(dataRoot, state);
      if (options.signal?.aborted) throw error;
      return {
        pipelineId,
        status: "failed",
        completed: Object.keys(state.completed).length,
        failedStep: step.id,
        error: message,
      };
    }
  }

  state = { ...state, status: "completed", updated: new Date().toISOString() };
  writePipelineState(dataRoot, state);
  const finalStep = definition.steps.at(-1)!;
  return {
    pipelineId,
    status: "completed",
    completed: definition.steps.length,
    output: state.completed[finalStep.id]?.output,
  };
}
