import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zod, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import defaultPaiPlugin, { createPaiPlugin } from "../../src/index.ts";

const packageRoot = resolve(import.meta.dir, "../..");
const roots: string[] = [];

type RuntimeHandler = (event: Record<string, unknown>) => unknown;
type CommandDefinition = {
  description: string;
  handler: (args: string, context: unknown) => unknown;
};
type ToolDefinition = {
  name: string;
  execute: (...args: unknown[]) => unknown;
};

function pluginHarness(plugin?: (pi: ExtensionAPI) => void): {
  handlers: Record<string, RuntimeHandler[]>;
  commands: Record<string, CommandDefinition>;
  tools: Record<string, ToolDefinition>;
  thinking: string[];
  entries: Array<{ type: string; data?: unknown }>;
  dataRoot: string;
  root: string;
  notifications: string[];
} {
  const handlers: Record<string, RuntimeHandler[]> = {};
  const commands: Record<string, CommandDefinition> = {};
  const tools: Record<string, ToolDefinition> = {};
  const thinking: string[] = [];
  const entries: Array<{ type: string; data?: unknown }> = [];
  const notifications: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "omp-pai-plugin-"));
  const dataRoot = join(root, "pai");
  roots.push(root);
  const activate = plugin ?? createPaiPlugin({
    pluginRoot: packageRoot,
    env: { OMP_PAI_DATA_DIR: dataRoot },
  });
  activate({
    zod,
    on: (name: string, handler: RuntimeHandler) => {
      (handlers[name] ??= []).push(handler);
    },
    registerCommand: (name: string, definition: CommandDefinition) => {
      commands[name] = definition;
    },
    registerTool: (definition: ToolDefinition) => {
      tools[definition.name] = definition;
    },
    appendEntry: (type: string, data?: unknown) => {
      entries.push({ type, data });
    },
    setThinkingLevel: (level: string) => {
      thinking.push(level);
    },
    logger: { warn: () => {} },
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionAPI);
  return { handlers, commands, tools, thinking, entries, dataRoot, root, notifications };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PAI plugin", () => {
  test("registers native runtime hooks, tools, and commands", () => {
    const harness = pluginHarness();
    expect(Object.keys(pluginHarness(defaultPaiPlugin).tools)).toContain("pai_action_run");
    expect(Object.keys(harness.commands).sort()).toEqual([
      "pai-doctor",
      "pai-init",
      "pai-memory-reindex",
      "pai-prd-sync",
      "pai-private-export",
      "pai-private-import",
    ]);
    expect(Object.keys(harness.tools).sort()).toEqual([
      "pai_action_run",
      "pai_context",
      "pai_flow_run",
      "pai_memory_record",
      "pai_pipeline_run",
      "pai_prd",
      "pai_telos_append",
    ]);
    expect(harness.handlers.before_agent_start).toHaveLength(1);
    expect(harness.handlers.turn_end).toHaveLength(1);
    expect(harness.handlers.tool_result).toHaveLength(1);
  });

  test("routes a turn with native thinking and compact hidden policy", async () => {
    const harness = pluginHarness();
    const result = await harness.handlers.before_agent_start![0]!({
      turnIndex: 4,
      prompt: "Спроектируй и реализуй сложную многофайловую миграцию",
      systemPrompt: ["base"],
    }) as { systemPrompt: string[] };
    expect(result.systemPrompt[0]).toBe("base");
    expect(result.systemPrompt.at(-1)).toContain("Internal mode: ALGORITHM");
    expect(result.systemPrompt.join("\n")).not.toContain("TASK:");
    expect(harness.thinking).toEqual(["high"]);
    await harness.handlers.turn_end![0]!({ turnIndex: 4 });
    expect(harness.entries.at(-1)).toMatchObject({
      type: "pai-runtime-route",
      data: { schemaVersion: 1, turnIndex: 4, mode: "algorithm" },
    });
  });

  test("executes the registered tools and command handlers end to end", async () => {
    const harness = pluginHarness();
    const context = {
      ui: {
        notify: (message: string) => {
          harness.notifications.push(message);
        },
      },
    };
    await harness.commands["pai-init"]!.handler("", context);
    writeFileSync(join(harness.dataRoot, "MEMORY/STATE/work.json"), "{}\n");
    await harness.commands["pai-doctor"]!.handler("", context);
    await harness.commands["pai-memory-reindex"]!.handler("", context);
    await harness.commands["pai-prd-sync"]!.handler("", context);

    const invoke = async (
      name: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<{ details: unknown }> =>
      await harness.tools[name]!.execute("call", params, signal) as { details: unknown };
    expect((await invoke("pai_telos_append", {
      recordType: "goals",
      text: "Ship the OMP-native runtime",
    })).details).toMatchObject({ recordType: "goals", status: "active" });
    expect((await invoke("pai_memory_record", {
      kind: "lesson",
      content: "Prefer native OMP APIs",
      source: "test",
      confidence: 1,
      userConfirmed: false,
    })).details).toMatchObject({ kind: "lesson" });
    expect((await invoke("pai_context", {
      query: "OMP",
      sources: ["telos", "memory"],
      limit: 5,
    })).details).toMatchObject({ telos: [{}], memory: [{}] });
    expect((await invoke("pai_context", {
      query: "",
      sources: ["memory"],
    })).details).toMatchObject({ telos: [], memory: [{}] });

    const prd = `---\ntask: Tool integration\nslug: tool-integration\neffort: standard\nphase: build\nprogress: 0/1\nmode: interactive\nstarted: 2026-08-05T12:00:00Z\nupdated: 2026-08-05T12:00:00Z\n---\n\n## Criteria\n- [ ] ISC-1: Tools execute\n`;
    await invoke("pai_prd", { operation: "write", content: prd });
    expect((await invoke("pai_prd", { operation: "get", slug: "tool-integration" })).details)
      .toMatchObject({ slug: "tool-integration" });
    expect((await invoke("pai_prd", { operation: "list" })).details).toMatchObject([
      { slug: "tool-integration" },
    ]);
    expect((await invoke("pai_prd", { operation: "sync" })).details).toMatchObject({ sessions: 1 });
    await expect(invoke("pai_prd", { operation: "write" })).rejects.toThrow("requires content");
    await expect(invoke("pai_prd", { operation: "get" })).rejects.toThrow("requires slug");

    const actionDirectory = join(harness.dataRoot, "PAI/ACTIONS/echo");
    mkdirSync(actionDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(actionDirectory, "action.ts"), "const input = await new Response(Bun.stdin.stream()).json(); console.log(JSON.stringify(input));\n");
    writeFileSync(join(actionDirectory, "action.json"), JSON.stringify({
      schemaVersion: 1,
      id: "echo",
      entry: "action.ts",
      description: "echo",
      input: true,
      output: true,
      timeoutMs: 5000,
    }));
    expect((await invoke("pai_action_run", { actionId: "echo", input: { ok: true } })).details)
      .toMatchObject({ output: { ok: true } });

    writeFileSync(join(harness.dataRoot, "PAI/FLOWS/echo.json"), JSON.stringify({
      schemaVersion: 1,
      id: "echo",
      initial: "done",
      states: { done: { action: "echo", terminal: true } },
    }));
    expect((await invoke("pai_flow_run", { flowId: "echo", input: { flow: true } })).details)
      .toMatchObject({ status: "completed", output: { flow: true } });

    writeFileSync(join(harness.dataRoot, "PAI/PIPELINES/echo.json"), JSON.stringify({
      schemaVersion: 1,
      id: "echo",
      steps: [{ id: "echo", action: "echo", input: "$pipeline.input" }],
    }));
    expect((await invoke("pai_pipeline_run", {
      pipelineId: "echo",
      input: { pipeline: true },
    })).details).toMatchObject({ status: "completed", output: { pipeline: true } });

    const waitDirectory = join(harness.dataRoot, "PAI/ACTIONS/wait");
    mkdirSync(waitDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(waitDirectory, "action.ts"),
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
    );
    writeFileSync(join(waitDirectory, "action.json"), JSON.stringify({
      schemaVersion: 1,
      id: "wait",
      entry: "action.ts",
      description: "wait",
      input: true,
      output: true,
      timeoutMs: 5000,
    }));
    writeFileSync(join(harness.dataRoot, "PAI/FLOWS/wait.json"), JSON.stringify({
      schemaVersion: 1,
      id: "wait",
      initial: "wait",
      states: { wait: { action: "wait", terminal: true } },
    }));
    writeFileSync(join(harness.dataRoot, "PAI/PIPELINES/wait.json"), JSON.stringify({
      schemaVersion: 1,
      id: "wait",
      steps: [{ id: "wait", action: "wait", input: "$pipeline.input" }],
    }));
    for (const [name, params] of [
      ["pai_action_run", { actionId: "wait", input: {} }],
      ["pai_flow_run", { flowId: "wait", input: {} }],
      ["pai_pipeline_run", { pipelineId: "wait", input: {} }],
    ] as const) {
      const controller = new AbortController();
      const running = invoke(name, params, controller.signal);
      controller.abort("tool cancelled");
      await expect(running).rejects.toThrow("Action aborted");
    }

    const archive = join(harness.root, "private.tar.gz");
    await harness.commands["pai-private-export"]!.handler(`"${archive}"`, context);
    await harness.commands["pai-private-export"]!.handler(
      join(harness.root, "private-unquoted.tar.gz"),
      context,
    );
    await expect(harness.commands["pai-private-export"]!.handler("", context))
      .rejects.toThrow("Usage");
    const imported = pluginHarness();
    const importedContext = {
      ui: {
        notify: (message: string) => {
          imported.notifications.push(message);
        },
      },
    };
    await imported.commands["pai-private-import"]!.handler(`'${archive}'`, importedContext);
    expect(imported.notifications.at(-1)).toContain("imported");
    expect(harness.notifications.some((message) => message.includes("PAI doctor"))).toBe(true);
  });
});
