import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createPaiRuntimeGate } from "../../src/runtime/pai-runtime-gate.ts";

const algorithmPath = "/opt/omp/plugins/omp-pai-system/templates/Algorithm/v3.5.0.md";
const algorithmHeader = "♻︎ Entering the PAI ALGORITHM… (v3.5.0) ═════════════";
const nativeHeader = "════ PAI | NATIVE MODE ═══════════════════════";
const safeTask = "🗒️ TASK: Выполняю запрос полностью и проверяю результат по критериям";
const roles = [
  ["actualModel", "openai-codex/gpt-5.6-sol"],
  ["piSubagentModel", "google/gemini-3-flash-preview"],
  ["piSlowModel", "anthropic/claude-opus-4-6"],
  ["piPlanModel", "anthropic/claude-sonnet-4-6"],
] as const;

type RuntimeHandler = (event: any) => any;

function runtimeHarness(): {
  handlers: Record<string, RuntimeHandler>;
  emitAssistant: (text: string) => Promise<void>;
} {
  const handlers: Record<string, RuntimeHandler> = {};
  createPaiRuntimeGate({
    algorithmPath,
    algorithmVersion: "3.5.0",
    dataRoot: "/tmp/portable-profile/.omp/agent/pai",
    paiTemplateRoot: "/opt/omp/plugins/omp-pai-system/templates/PAI",
  })({
    on: (name: string, handler: RuntimeHandler) => { handlers[name] = handler; },
  } as unknown as ExtensionAPI);
  return {
    handlers,
    emitAssistant: async (text: string) => {
      const event = { message: { role: "assistant", content: [{ type: "text", text }] } };
      if (handlers.message_start) await handlers.message_start(event);
      await handlers.message_update(event);
    },
  };
}

function tool(toolName: string, toolCallId: string, input: Record<string, unknown> = {}) {
  return { toolName, toolCallId, input };
}

describe("OMP role natural holdouts", () => {
  for (const [role, model] of roles) {
    test(`${role} routes a natural one-line edit to NATIVE`, async () => {
      const { handlers, emitAssistant } = runtimeHarness();
      const result = await handlers.before_agent_start({
        prompt: "Исправь одну опечатку в заголовке заметки.",
        systemPrompt: [`provider=${model}`],
      });

      const promptText = result.systemPrompt.join("\n\n");
      expect(promptText).toContain("OMP PAI RUNTIME GATE");
      expect(promptText).toContain(`provider=${model}`);
      await emitAssistant(`${nativeHeader}\n${safeTask}\n`);
      expect(await handlers.tool_call(tool("glob", `${role}-simple`))).toBeUndefined();
    });

    test(`${role} routes a natural multi-file build to ALGORITHM`, async () => {
      const { handlers, emitAssistant } = runtimeHarness();
      const result = await handlers.before_agent_start({
        prompt: "Собери многофайловый Astro/Tilda лендинг, сохрани текущую аналитику и проверь связанные шаблоны.",
        systemPrompt: [`provider=${model}`],
      });

      expect(result.systemPrompt.join("\n\n")).toContain("OMP PAI RUNTIME GATE");
      expect((await handlers.tool_call(tool("glob", `${role}-blocked`))).block).toBe(true);
      await emitAssistant(`${algorithmHeader}\n${safeTask}\n`);
      expect(await handlers.tool_call(tool("read", `${role}-read`, { path: algorithmPath })))
        .toBeUndefined();
      await handlers.tool_result({
        toolCallId: `${role}-read`,
        isError: false,
        details: { truncation: { truncated: false, outputLines: 338, totalLines: 338 } },
      });
      await emitAssistant("Продолжаю после полной загрузки Algorithm.");
      expect(await handlers.tool_call(tool("glob", `${role}-complex`))).toBeUndefined();
    });
  }
});
