import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  buildTurnPolicy,
  createPaiRuntime,
  isSubagentSystemPrompt,
  thinkingLevelForMode,
} from "../../src/runtime/pai-runtime-gate.ts";
import {
  PAI_RUNTIME_CONTRACT,
  routePaiPrompt,
} from "../../src/runtime/pai-runtime-contract.ts";

type RuntimeHandler = (event: Record<string, unknown>) => unknown;

function runtimeHarness(options: { throwThinking?: boolean } = {}) {
  const handlers: Record<string, RuntimeHandler> = {};
  const thinking: string[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const warnings: unknown[] = [];
  createPaiRuntime({
    dataRoot: "/tmp/profile/pai",
    skillRoot: "/opt/plugin/skills",
  })({
    on: (name: string, handler: RuntimeHandler) => { handlers[name] = handler; },
    setThinkingLevel: (level: string) => {
      if (options.throwThinking) throw new Error("unsupported");
      thinking.push(level);
    },
    appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
    logger: { warn: (...args: unknown[]) => { warnings.push(args); } },
  } as unknown as ExtensionAPI);
  return { handlers, thinking, entries, warnings };
}

describe("PAI runtime contract", () => {
  test("routes minimal, atomic, complex, fallback, and subagent prompts", () => {
    expect(routePaiPrompt("спасибо", false)).toEqual({
      mode: "minimal",
      reason: "minimal-message",
    });
    expect(routePaiPrompt("Исправь опечатку", false)).toEqual({
      mode: "native",
      reason: "short-atomic-task",
    });
    expect(routePaiPrompt("Реализуй сложный многофайловый проект", false)).toEqual({
      mode: "algorithm",
      reason: "complex-task",
    });
    expect(routePaiPrompt("Неопознанный содержательный запрос", false)).toEqual({
      mode: "algorithm",
      reason: "safe-fallback",
    });
    expect(routePaiPrompt("Проверь папку", true)).toEqual({
      mode: "native",
      reason: "subagent-default",
    });
    expect(routePaiPrompt("<pai-mode>ALGORITHM</pai-mode> Проверь папку", true)).toEqual({
      mode: "algorithm",
      reason: "explicit-algorithm",
    });
  });

  test("declares a hidden provider-independent protocol", () => {
    expect(PAI_RUNTIME_CONTRACT.schemaVersion).toBe(2);
    expect(PAI_RUNTIME_CONTRACT.output).toEqual({
      visibleProtocol: false,
      headersRequired: false,
      taskLineRequired: false,
    });
    expect(String(thinkingLevelForMode("minimal"))).toBe("minimal");
    expect(String(thinkingLevelForMode("native"))).toBe("low");
    expect(String(thinkingLevelForMode("algorithm"))).toBe("high");
  });

  test("recognizes supported subagent markers", () => {
    expect(isSubagentSystemPrompt(["base"])).toBe(false);
    expect(isSubagentSystemPrompt([
      "You are operating on a piece of work assigned to you by the main agent.",
    ])).toBe(true);
    expect(isSubagentSystemPrompt(["<subagent>worker</subagent>"])).toBe(true);
  });

  test("builds a compact policy without visible or voice rituals", () => {
    const policy = buildTurnPolicy(
      { mode: "algorithm", reason: "complex-task" },
      "/tmp/profile/pai",
    );
    expect(policy).toContain("Use the pai-deep-work skill");
    expect(policy).toContain("/tmp/profile/pai/TELOS");
    expect(policy).toContain("Do not print mode headers");
    expect(policy).toContain("Never contact voice, TTS");
    expect(policy).not.toContain("localhost:8888");
    expect(buildTurnPolicy(
      { mode: "native", reason: "short-atomic-task" },
      "/tmp/profile/pai",
    )).toContain("normal OMP workflow");
  });

  test("registers native hooks, resources, thinking, and route persistence", async () => {
    const { handlers, thinking, entries } = runtimeHarness();
    expect(Object.keys(handlers).sort()).toEqual([
      "before_agent_start",
      "resources_discover",
      "turn_end",
    ]);
    expect(await handlers.resources_discover({ type: "resources_discover" })).toEqual({
      skillPaths: ["/opt/plugin/skills"],
    });

    const result = await handlers.before_agent_start({
      prompt: "Реализуй проект",
      systemPrompt: ["base"],
    }) as { systemPrompt: string[] };
    expect(result.systemPrompt[0]).toBe("base");
    expect(result.systemPrompt.at(-1)).toContain("Internal mode: ALGORITHM");
    expect(thinking).toEqual(["high"]);

    await handlers.turn_end({ turnIndex: 3 });
    expect(entries).toEqual([{
      type: "pai-runtime-route",
      data: {
        schemaVersion: 1,
        turnIndex: 3,
        mode: "algorithm",
        reason: "complex-task",
      },
    }]);
  });

  test("ignores turn_end before routing and logs unsupported thinking", async () => {
    const { handlers, entries, warnings } = runtimeHarness({ throwThinking: true });
    await handlers.turn_end({ turnIndex: 0 });
    expect(entries).toEqual([]);
    await handlers.before_agent_start({ prompt: "спасибо", systemPrompt: [] });
    expect(warnings).toHaveLength(1);
  });
});
