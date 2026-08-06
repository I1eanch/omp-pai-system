import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { executeAction } from "../automation/actions.ts";
import { runFlow } from "../automation/flows.ts";
import { runPipeline } from "../automation/pipelines.ts";
import { isJsonValue } from "../automation/json-schema.ts";
import {
  MEMORY_KINDS,
  queryMemory,
  rebuildMemoryIndex,
  recordMemory,
} from "../state/memory.ts";
import { listPrds, readPrd, syncPrdRegistry, writePrd } from "../state/prd.ts";
import { appendTelosEntry, queryTelos, TELOS_RECORD_TYPES } from "../state/telos.ts";

export type PaiToolsOptions = {
  dataRoot: string;
};

function resultContent(value: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/** Registers the complete typed OMP tool and command surface for local PAI state. */
export function registerPaiTools(pi: ExtensionAPI, options: PaiToolsOptions): void {
  const z = pi.zod;
  const jsonValue = z.json();

  pi.registerTool({
    name: "pai_context",
    label: "PAI Context",
    description: "Retrieve focused local TELOS and MEMORY context with source paths. Read-only and bounded.",
    approval: "read",
    parameters: z.object({
      query: z.string(),
      sources: z.array(z.enum(["telos", "memory"])).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async execute(_toolCallId, params) {
      const sources = params.sources ?? ["telos", "memory"];
      const limit = params.limit ?? 8;
      const result = {
        telos: sources.includes("telos") ? queryTelos(options.dataRoot, params.query, limit) : [],
        memory: sources.includes("memory") ? queryMemory(options.dataRoot, params.query, limit) : [],
      };
      return { content: resultContent(result), details: result };
    },
  });

  pi.registerTool({
    name: "pai_telos_append",
    label: "PAI TELOS Append",
    description: "Append an explicitly supplied durable goal, decision, belief, idea, challenge, project, or lesson to local TELOS.",
    approval: "write",
    parameters: z.object({
      recordType: z.enum(TELOS_RECORD_TYPES),
      text: z.string().min(1).max(32 * 1024),
    }),
    async execute(_toolCallId, params) {
      const record = appendTelosEntry(options.dataRoot, params.recordType, params.text);
      const details = {
        recordType: record.recordType,
        path: record.path,
        status: record.status,
        updated: record.updated,
      };
      return { content: resultContent(details), details };
    },
  });

  pi.registerTool({
    name: "pai_memory_record",
    label: "PAI Memory Record",
    description: "Record a validated local memory with provenance and explicit confirmation for personal facts or preferences.",
    approval: "write",
    parameters: z.object({
      kind: z.enum(MEMORY_KINDS),
      content: z.string().min(1).max(32 * 1024),
      source: z.string().min(1).max(1024),
      confidence: z.number().min(0).max(1),
      userConfirmed: z.boolean(),
    }),
    async execute(_toolCallId, params) {
      const record = recordMemory(options.dataRoot, params);
      return { content: resultContent(record), details: record };
    },
  });

  pi.registerTool({
    name: "pai_prd",
    label: "PAI PRD",
    description: "Write, retrieve, list, or resynchronize persistent PRD work records under the configured MEMORY root.",
    approval: "write",
    parameters: z.object({
      operation: z.enum(["write", "get", "list", "sync"]),
      slug: z.string().optional(),
      content: z.string().optional(),
    }),
    async execute(_toolCallId, params) {
      let result: unknown;
      if (params.operation === "write") {
        if (!params.content) throw new Error("pai_prd write requires content");
        result = writePrd(options.dataRoot, params.content);
      } else if (params.operation === "get") {
        if (!params.slug) throw new Error("pai_prd get requires slug");
        result = readPrd(options.dataRoot, params.slug);
      } else if (params.operation === "list") {
        result = listPrds(options.dataRoot).map(({ content: _content, ...prd }) => prd);
      } else {
        result = syncPrdRegistry(options.dataRoot);
      }
      return { content: resultContent(result), details: result };
    },
  });

  pi.registerTool({
    name: "pai_action_run",
    label: "PAI Action Run",
    description: "Execute a trusted local PAI action in an isolated subprocess with JSON input/output validation and a timeout.",
    approval: "exec",
    parameters: z.object({
      actionId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
      input: jsonValue,
    }),
    async execute(_toolCallId, params, signal) {
      if (!isJsonValue(params.input)) throw new Error("Action input must be JSON-compatible");
      const report = await executeAction(
        options.dataRoot,
        params.actionId,
        params.input,
        { signal },
      );
      return { content: resultContent(report), details: report };
    },
  });

  pi.registerTool({
    name: "pai_flow_run",
    label: "PAI Flow Run",
    description: "Run or explicitly resume a validated local PAI flow state machine.",
    approval: "exec",
    parameters: z.object({
      flowId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
      input: jsonValue,
      resume: z.boolean().optional(),
      maxSteps: z.number().int().min(1).max(10_000).optional(),
    }),
    async execute(_toolCallId, params, signal) {
      if (!isJsonValue(params.input)) throw new Error("Flow input must be JSON-compatible");
      const report = await runFlow(options.dataRoot, params.flowId, params.input, {
        resume: params.resume,
        maxSteps: params.maxSteps,
        signal,
      });
      return { content: resultContent(report), details: report };
    },
  });

  pi.registerTool({
    name: "pai_pipeline_run",
    label: "PAI Pipeline Run",
    description: "Run or explicitly resume a deterministic validated local PAI action pipeline.",
    approval: "exec",
    parameters: z.object({
      pipelineId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
      input: jsonValue,
      resume: z.boolean().optional(),
    }),
    async execute(_toolCallId, params, signal) {
      if (!isJsonValue(params.input)) throw new Error("Pipeline input must be JSON-compatible");
      const report = await runPipeline(options.dataRoot, params.pipelineId, params.input, {
        resume: params.resume,
        signal,
      });
      return { content: resultContent(report), details: report };
    },
  });

  pi.registerCommand("pai-memory-reindex", {
    description: "Rebuild the local PAI MEMORY retrieval index",
    handler: async (_args, context) => {
      const report = rebuildMemoryIndex(options.dataRoot);
      context.ui.notify(`PAI MEMORY index rebuilt: ${report.records} records`, "info");
    },
  });

  pi.registerCommand("pai-prd-sync", {
    description: "Validate persistent PRDs and synchronize the work registry",
    handler: async (_args, context) => {
      const report = syncPrdRegistry(options.dataRoot);
      context.ui.notify(`PAI PRD registry synchronized: ${report.sessions} sessions`, "info");
    },
  });
}
