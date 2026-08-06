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

export type FlowStateDefinition = {
  action: string;
  onSuccess?: string;
  terminal?: boolean;
  pause?: boolean;
};

export type FlowDefinition = {
  schemaVersion: 1;
  id: string;
  initial: string;
  states: Record<string, FlowStateDefinition>;
};

export type CompletedFlowState = {
  action: string;
  actionSha256: string;
};

export type FlowRunState = {
  schemaVersion: 1;
  flowId: string;
  definitionSha256: string;
  current: string;
  status: "running" | "paused" | "failed" | "completed";
  initialInput: JsonValue;
  lastInput: JsonValue;
  lastOutput?: JsonValue;
  completed: Record<string, CompletedFlowState>;
  error?: string;
  updated: string;
};

export type FlowRunReport = {
  flowId: string;
  status: FlowRunState["status"];
  current: string;
  output?: JsonValue;
  error?: string;
  steps: number;
};
export type RunFlowOptions = {
  resume?: boolean;
  maxSteps?: number;
  signal?: AbortSignal;
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

function definitionDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Loads a Flow definition and validates its complete transition graph. */
export function loadFlowDefinition(dataRoot: string, flowId: string): FlowDefinition & { sha256: string } {
  if (!ID_PATTERN.test(flowId)) throw new Error(`Invalid flow id: ${flowId}`);
  const path = `PAI/FLOWS/${flowId}.json`;
  const content = readStateText(dataRoot, path, 2 * 1024 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Flow definition is invalid JSON: ${flowId}`, { cause: error });
  }
  if (!isUnknownRecord(parsed) || !isUnknownRecord(parsed.states)) {
    throw new Error(`Flow definition is invalid: ${flowId}`);
  }
  if (
    parsed.schemaVersion !== 1
    || parsed.id !== flowId
    || typeof parsed.initial !== "string"
    || !(parsed.initial in parsed.states)
  ) {
    throw new Error(`Flow definition is invalid: ${flowId}`);
  }

  const states: Record<string, FlowStateDefinition> = {};
  for (const [name, value] of Object.entries(parsed.states)) {
    if (!ID_PATTERN.test(name) || !isUnknownRecord(value) || typeof value.action !== "string") {
      throw new Error(`Flow state is invalid: ${flowId}/${name}`);
    }
    const keys = ["action", "onSuccess", "terminal", "pause"];
    if (Object.keys(value).some((key) => !keys.includes(key))) {
      throw new Error(`Flow state contains unknown fields: ${flowId}/${name}`);
    }
    if (value.onSuccess !== undefined && typeof value.onSuccess !== "string") {
      throw new Error(`Flow transition is invalid: ${flowId}/${name}`);
    }
    if (value.terminal !== undefined && typeof value.terminal !== "boolean") {
      throw new Error(`Flow terminal flag is invalid: ${flowId}/${name}`);
    }
    if (value.pause !== undefined && typeof value.pause !== "boolean") {
      throw new Error(`Flow pause flag is invalid: ${flowId}/${name}`);
    }
    const state = value as unknown as FlowStateDefinition;
    if (state.terminal && (state.onSuccess !== undefined || state.pause === true)) {
      throw new Error(`Terminal flow state has outgoing behavior: ${flowId}/${name}`);
    }
    if (!state.terminal && !state.onSuccess) {
      throw new Error(`Non-terminal flow state lacks onSuccess: ${flowId}/${name}`);
    }
    states[name] = state;
  }
  for (const [name, state] of Object.entries(states)) {
    if (state.onSuccess && !(state.onSuccess in states)) {
      throw new Error(`Unknown flow transition ${state.onSuccess}: ${flowId}/${name}`);
    }
  }
  return {
    schemaVersion: 1,
    id: flowId,
    initial: parsed.initial,
    states,
    sha256: definitionDigest(content),
  };
}

function flowStatePath(flowId: string): string {
  return `MEMORY/STATE/flows/${flowId}.json`;
}

function writeFlowState(dataRoot: string, state: FlowRunState): void {
  atomicWriteStateText(dataRoot, flowStatePath(state.flowId), `${JSON.stringify(state, null, 2)}\n`);
}

/** Reads and validates a persisted Flow checkpoint, or returns null when absent. */
export function readFlowState(dataRoot: string, flowId: string): FlowRunState | null {
  if (!ID_PATTERN.test(flowId)) throw new Error(`Invalid flow id: ${flowId}`);
  const path = flowStatePath(flowId);
  const absolute = resolveStatePath(dataRoot, path);
  if (!lstatSync(absolute, { throwIfNoEntry: false })) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readStateText(dataRoot, path));
  } catch (error) {
    throw new Error(`Flow state is invalid: ${flowId}`, { cause: error });
  }
  if (
    !isUnknownRecord(parsed)
    || parsed.schemaVersion !== 1
    || parsed.flowId !== flowId
    || typeof parsed.definitionSha256 !== "string"
    || typeof parsed.current !== "string"
    || !["running", "paused", "failed", "completed"].includes(String(parsed.status))
    || !isJsonValue(parsed.initialInput)
    || !isJsonValue(parsed.lastInput)
    || (parsed.lastOutput !== undefined && !isJsonValue(parsed.lastOutput))
    || !isUnknownRecord(parsed.completed)
    || (parsed.error !== undefined && typeof parsed.error !== "string")
    || typeof parsed.updated !== "string"
    || Number.isNaN(Date.parse(parsed.updated))
  ) {
    throw new Error(`Flow state is invalid: ${flowId}`);
  }
  for (const [stateName, completed] of Object.entries(parsed.completed)) {
    if (
      !ID_PATTERN.test(stateName)
      || !isUnknownRecord(completed)
      || typeof completed.action !== "string"
      || !ID_PATTERN.test(completed.action)
      || typeof completed.actionSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(completed.actionSha256)
      || Object.keys(completed).some((key) => !["action", "actionSha256"].includes(key))
    ) {
      throw new Error(`Flow completed state is invalid: ${flowId}/${stateName}`);
    }
  }
  return parsed as unknown as FlowRunState;
}

/** Runs or resumes a Flow, persisting every successful transition and failure. */
export async function runFlow(
  dataRoot: string,
  flowId: string,
  input: JsonValue,
  options: RunFlowOptions = {},
): Promise<FlowRunReport> {
  if (!isJsonValue(input)) throw new Error("Flow input must be JSON-compatible");
  const definition = loadFlowDefinition(dataRoot, flowId);
  const maxSteps = options.maxSteps ?? 100;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 10_000) {
    throw new Error("Flow maxSteps must be an integer from 1 to 10000");
  }

  const saved = options.resume ? readFlowState(dataRoot, flowId) : null;
  if (saved && saved.definitionSha256 !== definition.sha256) {
    throw new Error(`Flow definition changed since saved state: ${flowId}`);
  }
  if (saved) {
    for (const [stateName, completed] of Object.entries(saved.completed)) {
      const stateDefinition = definition.states[stateName];
      if (!stateDefinition || stateDefinition.action !== completed.action) {
        throw new Error(`Flow saved action does not match definition: ${flowId}/${stateName}`);
      }
      const currentSha256 = actionDefinitionSha256(
        dataRoot,
        loadActionManifest(dataRoot, completed.action),
      );
      if (currentSha256 !== completed.actionSha256) {
        throw new Error(`Flow action changed since saved state: ${flowId}/${stateName}`);
      }
    }
  }
  if (saved?.status === "completed") {
    return {
      flowId,
      status: "completed",
      current: saved.current,
      output: saved.lastOutput,
      steps: 0,
    };
  }

  let state: FlowRunState = saved ?? {
    schemaVersion: 1,
    flowId,
    definitionSha256: definition.sha256,
    current: definition.initial,
    status: "running",
    initialInput: input,
    lastInput: input,
    completed: {},
    updated: new Date().toISOString(),
  };
  state = { ...state, status: "running", error: undefined, updated: new Date().toISOString() };
  writeFlowState(dataRoot, state);

  for (let steps = 1; steps <= maxSteps; steps += 1) {
    const currentDefinition = definition.states[state.current];
    if (!currentDefinition) throw new Error(`Flow state is missing: ${flowId}/${state.current}`);
    try {
      const action = await executeAction(
        dataRoot,
        currentDefinition.action,
        state.lastInput,
        { signal: options.signal },
      );
      const output = action.output;
      const completed = {
        ...state.completed,
        [state.current]: {
          action: currentDefinition.action,
          actionSha256: action.definitionSha256,
        },
      };
      if (currentDefinition.terminal) {
        state = {
          ...state,
          status: "completed",
          lastOutput: output,
          completed,
          updated: new Date().toISOString(),
        };
        writeFlowState(dataRoot, state);
        return { flowId, status: "completed", current: state.current, output, steps };
      }
      const next = currentDefinition.onSuccess!;
      state = {
        ...state,
        current: next,
        status: currentDefinition.pause ? "paused" : "running",
        lastInput: output,
        lastOutput: output,
        completed,
        updated: new Date().toISOString(),
      };
      writeFlowState(dataRoot, state);
      if (state.status === "paused") {
        return { flowId, status: "paused", current: next, output, steps };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = {
        ...state,
        status: "failed",
        error: message,
        updated: new Date().toISOString(),
      };
      writeFlowState(dataRoot, state);
      if (options.signal?.aborted) throw error;
      return { flowId, status: "failed", current: state.current, error: message, steps };
    }
  }

  const error = `Flow exceeded ${maxSteps} step limit`;
  state = { ...state, status: "failed", error, updated: new Date().toISOString() };
  writeFlowState(dataRoot, state);
  return { flowId, status: "failed", current: state.current, error, steps: maxSteps };
}
