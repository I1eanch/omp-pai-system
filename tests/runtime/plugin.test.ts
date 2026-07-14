import assert from "node:assert/strict";
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createPaiPlugin } from "../../src/index.ts";

const pluginRoot = "/opt/omp/plugins/omp-pai-system";
const overrideRoot = mkdtempSync(join(tmpdir(), "omp-pai-plugin-"));
const overridePath = join(overrideRoot, "v3.7.0.md");
writeFileSync(overridePath, "# Algorithm v3.7.0\n");
afterAll(() => rmSync(overrideRoot, { recursive: true, force: true }));

const algorithmPath = `${pluginRoot}/templates/Algorithm/v3.5.0.md`;
type RuntimeHandler = (event: any) => any;
type CommandDefinition = {
  description: string;
  handler: (args: string, context: unknown) => unknown;
};
const commands: Record<string, CommandDefinition> = {};
const handlers: Record<string, RuntimeHandler> = {};

function isBlocked(result: unknown): boolean {
  return result !== null
    && typeof result === "object"
    && "block" in result
    && result.block === true;
}

function systemPromptText(result: unknown): string {
  if (
    result !== null
    && typeof result === "object"
    && "systemPrompt" in result
    && Array.isArray(result.systemPrompt)
    && result.systemPrompt.every((part) => typeof part === "string")
  ) {
    return result.systemPrompt.join("\n\n");
  }
  return "";
}

createPaiPlugin({
  pluginRoot,
  env: { HOME: "/tmp/fake-home" },
})({
  on: (name: string, handler: RuntimeHandler) => { handlers[name] = handler; },
  registerCommand: (name: string, definition: CommandDefinition) => {
    commands[name] = definition;
  },
} as unknown as ExtensionAPI);
assert.equal(typeof commands["pai-init"]?.handler, "function");
assert.match(commands["pai-init"].description, /Initialize local PAI state/u);
assert.equal(typeof commands["pai-private-export"]?.handler, "function");
assert.equal(typeof commands["pai-private-import"]?.handler, "function");
assert.equal(typeof commands["pai-doctor"]?.handler, "function");

const startResult = await handlers.before_agent_start({
  prompt: "диагностируй сложный сбой",
  systemPrompt: ["base"],
});
const startSystemPrompt = systemPromptText(startResult);
assert.match(startSystemPrompt, /PORTABLE ROOT MAP/u);
assert.ok(startSystemPrompt.includes("/tmp/fake-home/.omp/agent/pai/MEMORY"));
assert.ok(startSystemPrompt.includes(`${pluginRoot}/templates/PAI`));
assert.doesNotMatch(startSystemPrompt, /\/Users\/|~\/\.claude/u);
const assistantEvent = {
  message: {
    role: "assistant",
    content: [{
      type: "text",
      text: "♻︎ Entering the PAI ALGORITHM… (v3.5.0) ═════════════\n🗒️ TASK: Выполняю запрос полностью и проверяю результат по критериям\n",
    }],
  },
};
await handlers.message_start(assistantEvent);
await handlers.message_update(assistantEvent);

assert.equal(
  await handlers.tool_call({
    toolName: "read",
    toolCallId: "portable-read",
    input: { path: algorithmPath },
  }),
  undefined,
);
assert.equal(
  isBlocked(await handlers.tool_call({
    toolName: "read",
    toolCallId: "personal-read",
    input: { path: "/home/example/.claude/PAI/Algorithm/v3.7.0.md" },
  })),
  true,
);

const overrideHandlers: Record<string, RuntimeHandler> = {};
createPaiPlugin({
  pluginRoot,
  env: {
    HOME: "/tmp/fake-home",
    OMP_PAI_ALGORITHM_PATH: overridePath,
  },
})({
  on: (name: string, handler: RuntimeHandler) => { overrideHandlers[name] = handler; },
  registerCommand: () => {},
} as unknown as ExtensionAPI);

await overrideHandlers.before_agent_start({
  prompt: "диагностируй сложный сбой",
  systemPrompt: ["base"],
});
const overrideAssistantEvent = {
  message: {
    role: "assistant",
    content: [{
      type: "text",
      text: "♻︎ Entering the PAI ALGORITHM… (v3.7.0) ═════════════\n🗒️ TASK: Выполняю запрос полностью и проверяю результат по критериям\n",
    }],
  },
};
await overrideHandlers.message_start(overrideAssistantEvent);
await overrideHandlers.message_update(overrideAssistantEvent);
assert.equal(
  await overrideHandlers.tool_call({
    toolName: "read",
    toolCallId: "override-read",
    input: { path: overridePath },
  }),
  undefined,
);

console.log("PASS: plugin resolves and enforces bundled Algorithm path");
