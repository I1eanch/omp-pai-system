import assert from "node:assert/strict";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createPaiRuntimeGate } from "../../src/runtime/pai-runtime-gate.ts";

const algorithmPath = "/opt/omp/plugins/omp-pai-system/templates/Algorithm/v3.5.0.md";
type RuntimeHandler = (event: any) => any;
const handlers: Record<string, RuntimeHandler> = {};
createPaiRuntimeGate({
  algorithmPath,
  algorithmVersion: "3.5.0",
  dataRoot: "/tmp/fake-home/.omp/agent/pai",
  paiTemplateRoot: "/opt/omp/plugins/omp-pai-system/templates/PAI",
})({
  on: (name: string, handler: RuntimeHandler) => { handlers[name] = handler; },
} as unknown as ExtensionAPI);

const explicitRootHandlers: Record<string, RuntimeHandler> = {};
createPaiRuntimeGate({
  algorithmPath: "/Users/example/.claude/PAI/Algorithm/v3.7.0.md",
  algorithmVersion: "3.7.0",
  dataRoot: "/Users/example/.omp/agent/pai",
  memoryRoot: "/Users/example/.claude/MEMORY",
  telosRoot: "/Users/example/.claude/PAI/USER/TELOS",
  paiTemplateRoot: "/Users/example/.claude/PAI",
})({
  on: (name: string, handler: RuntimeHandler) => {
    explicitRootHandlers[name] = handler;
  },
} as unknown as ExtensionAPI);
const explicitRootStart = await explicitRootHandlers.before_agent_start({
  prompt: "Исправь production data-loss incident.",
  systemPrompt: ["base"],
});
const explicitRootContract = explicitRootStart.systemPrompt.join("\n");
assert.match(explicitRootContract, /MEMORY root: "\/Users\/example\/\.claude\/MEMORY"/);
assert.match(explicitRootContract, /TELOS root: "\/Users\/example\/\.claude\/PAI\/USER\/TELOS"/);

const mainSystem = "base";
const subSystem = "COOP\nYou are operating on a piece of work assigned to you by the main agent.";
const minimalHeader = "═══ PAI ═══════════════════════════";
const nativeHeader = "════ PAI | NATIVE MODE ═══════════════════════";
const algorithmHeader = "♻︎ Entering the PAI ALGORITHM… (v3.5.0) ═════════════";
const algorithmLightHeader = "♻︎ Entering the PAI ALGORITHM LIGHT ═════════════";
const safeTask = "🗒️ TASK: Восстанавливаю исходную схему выбора режимов для агентов OMP";
const recoveryTask =
  "🗒️ TASK: Выполняю запрос полностью и проверяю результат по критериям";
const assistantText = (text: string) => ({ message: { role: "assistant", content: [{ type: "text", text }] } });
const emitAssistant = async (text: string) => {
  const event = assistantText(text);
  if (handlers.message_start) await handlers.message_start(event);
  await handlers.message_update(event);
};
const tool = (toolName: string, toolCallId: string, input: Record<string, unknown> = {}) => ({ toolName, toolCallId, input });

const mainStart = await handlers.before_agent_start({ prompt: "сложная задача", systemPrompt: [mainSystem] });
const mainContract = mainStart.systemPrompt.join("\n");
assert.doesNotMatch(
  mainContract,
  /This OMP turn requires (?:MINIMAL|NATIVE|ALGORITHM)/,
);
assert.match(mainContract, /select exactly one PAI mode/i);
assert.match(
  mainContract,
  /Any question, request, transformation, or action makes MINIMAL forbidden/,
);
assert.match(mainContract, /"ты здесь\?" and "как дела\?" are NATIVE, not MINIMAL/);
assert.match(mainContract, /ordinary research, explanations, and read-only checks use NATIVE/i);
assert.match(mainContract, /ALGORITHM LIGHT/i);
assert.match(mainContract, /high-risk implementation or debugging/i);
assert.match(
  mainContract,
  /copy that exact verified draft unchanged into line 2; never paraphrase it during output/,
);
assert.ok(mainContract.includes(recoveryTask));
const deterministicGemini = await handlers.before_provider_request({
  payload: {
    model: "gemini-3-flash-agent",
    contents: [],
    config: {
      systemInstruction: { role: "user", parts: [{ text: "base instruction" }] },
      maxOutputTokens: 1,
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: "HIGH",
        thinkingBudget: 16,
      },
    },
  },
});
assert.equal(deterministicGemini.config.temperature, 0);
assert.equal(deterministicGemini.config.thinkingConfig.thinkingLevel, "MINIMAL");
assert.equal("thinkingBudget" in deterministicGemini.config.thinkingConfig, false);
assert.equal(deterministicGemini.config.thinkingConfig.includeThoughts, false);
assert.equal(deterministicGemini.config.systemInstruction.parts[0].text, "base instruction");
assert.equal(deterministicGemini.config.systemInstruction.role, "user");
assert.match(deterministicGemini.config.systemInstruction.parts.at(-1).text, /select exactly one PAI mode/i);
assert.ok(deterministicGemini.config.systemInstruction.parts.at(-1).text.includes(algorithmHeader));
assert.ok(deterministicGemini.config.systemInstruction.parts.at(-1).text.includes(nativeHeader));
assert.ok(deterministicGemini.config.systemInstruction.parts.at(-1).text.includes(algorithmLightHeader));
const levelFlash38Gemini = await handlers.before_provider_request({
  payload: {
    model: "gemini-3.8-flash-high",
    contents: [],
    config: { thinkingConfig: { thinkingLevel: "HIGH", thinkingBudget: 16 } },
  },
});
assert.equal(levelFlash38Gemini.config.thinkingConfig.thinkingLevel, "LOW");
assert.equal("thinkingBudget" in levelFlash38Gemini.config.thinkingConfig, false);
const budgetGemini = await handlers.before_provider_request({
  payload: {
    model: "gemini-2.5-flash",
    contents: [],
    config: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16 } },
  },
});
assert.equal(budgetGemini.config.thinkingConfig.thinkingBudget, 0);
assert.equal("thinkingLevel" in budgetGemini.config.thinkingConfig, false);
const levelProGemini = await handlers.before_provider_request({
  payload: {
    model: "gemini-3-pro-preview",
    contents: [],
    config: { thinkingConfig: { thinkingLevel: "HIGH", thinkingBudget: 16 } },
  },
});
assert.equal(levelProGemini.config.thinkingConfig.thinkingLevel, "LOW");
assert.equal("thinkingBudget" in levelProGemini.config.thinkingConfig, false);
const budgetProGemini = await handlers.before_provider_request({
  payload: {
    model: "gemini-2.5-pro",
    contents: [],
    config: { thinkingConfig: { thinkingBudget: 8_192 } },
  },
});
assert.equal(budgetProGemini.config.thinkingConfig.thinkingBudget, 128);
assert.equal("thinkingLevel" in budgetProGemini.config.thinkingConfig, false);
const cliLevelProGemini = await handlers.before_provider_request({
  payload: {
    project: "offline",
    model: "gemini-3-pro-preview",
    request: {
      contents: [],
      systemInstruction: { role: "user", parts: [{ text: "cli base" }] },
      generationConfig: {
        thinkingConfig: { thinkingLevel: "HIGH", thinkingBudget: 16 },
      },
    },
  },
});
assert.equal(cliLevelProGemini.request.generationConfig.thinkingConfig.thinkingLevel, "LOW");
assert.equal("thinkingBudget" in cliLevelProGemini.request.generationConfig.thinkingConfig, false);
assert.equal(cliLevelProGemini.request.systemInstruction.parts[0].text, "cli base");
const cliBudgetProGemini = await handlers.before_provider_request({
  payload: {
    project: "offline",
    model: "gemini-2.5-pro",
    request: {
      contents: [],
      generationConfig: { thinkingConfig: { thinkingBudget: 8_192 } },
    },
  },
});
assert.equal(cliBudgetProGemini.request.generationConfig.thinkingConfig.thinkingBudget, 128);
assert.equal("thinkingLevel" in cliBudgetProGemini.request.generationConfig.thinkingConfig, false);
const synthesizedGemini = await handlers.before_provider_request({
  payload: { model: "gemini-3-flash-agent", contents: [], config: {} },
});
assert.equal(synthesizedGemini.config.systemInstruction.role, "user");
assert.equal((await handlers.tool_call(tool("glob", "g0"))).block, true);
await emitAssistant(`\uFEFF${algorithmHeader}\n${safeTask}`);
assert.equal((await handlers.tool_call(tool("read", "g-bom", { path: algorithmPath }))).block, true);
await emitAssistant(`${algorithmHeader} \n${safeTask}`);
assert.equal((await handlers.tool_call(tool("read", "g-trailing", { path: algorithmPath }))).block, true);
await emitAssistant(`${algorithmHeader}\n${safeTask}\n`);
assert.equal((await handlers.tool_call(tool("glob", "g1"))).block, true);
assert.equal(
  (
    await handlers.tool_call(
      tool("read", "r-narrow-initial", { path: algorithmPath, selector: "1-1" }),
    )
  ).block,
  true,
);
assert.equal(
  (
    await handlers.tool_call(
      tool("read", "r-narrow-inline-initial", { path: `${algorithmPath}:1-1` }),
    )
  ).block,
  true,
);
assert.equal(await handlers.tool_call(tool("read", "r1", { path: algorithmPath })), undefined);
assert.equal((await handlers.tool_call(tool("glob", "g2"))).block, true);
await handlers.tool_result({ toolCallId: "r1", isError: true });
assert.equal((await handlers.tool_call(tool("glob", "g3"))).block, true);
assert.equal(await handlers.tool_call(tool("read", "r2", { path: algorithmPath })), undefined);
await handlers.tool_result({
  toolCallId: "r2",
  isError: false,
  details: { truncation: { truncated: true, outputLines: 300, totalLines: 380 } },
});
assert.equal((await handlers.tool_call(tool("glob", "g4"))).block, true);
assert.equal(
  (
    await handlers.tool_call(
      tool("read", "r-short", { path: `${algorithmPath}:301-301` }),
    )
  ).block,
  true,
);
assert.equal(
  (
    await handlers.tool_call(
      tool("read", "r-wrong-start", { path: `${algorithmPath}:302-` }),
    )
  ).block,
  true,
);
assert.equal(
  await handlers.tool_call(tool("read", "r3", { path: algorithmPath, selector: "301-" })),
  undefined,
);
await handlers.tool_result({
  toolCallId: "r3",
  isError: false,
  details: { truncation: { truncated: false, outputLines: 80, totalLines: 80 } },
});
await emitAssistant("Продолжаю без повторного заголовка.");
assert.equal(await handlers.tool_call(tool("glob", "g5")), undefined);
await emitAssistant(`Продолжаю\n${safeTask}`);
assert.equal((await handlers.tool_call(tool("glob", "g-repeat-task"))).block, true);
assert.equal(await handlers.before_provider_request({ payload: { model: "gemini-3-flash-agent", request: { generationConfig: {} } } }), undefined);
const continuationContext = await handlers.context({ messages: [] });
assert.equal(continuationContext.messages.at(-1).customType, "pai-runtime-continuation");

await handlers.before_agent_start({
  prompt: "Явно используй полный ALGORITHM для inline selector smoke.",
  systemPrompt: [mainSystem],
});
await emitAssistant(`${algorithmHeader}\n${safeTask}\n`);
assert.equal(
  await handlers.tool_call(tool("read", "inline-r1", { path: algorithmPath })),
  undefined,
);
await handlers.tool_result({
  toolCallId: "inline-r1",
  isError: false,
  details: { truncation: { truncated: true, outputLines: 300, totalLines: 380 } },
});
assert.equal(
  (
    await handlers.tool_call(
      tool("read", "inline-short", { path: `${algorithmPath}:301-301` }),
    )
  ).block,
  true,
);
assert.equal(
  await handlers.tool_call(
    tool("read", "inline-r2", { path: `${algorithmPath}:301-380` }),
  ),
  undefined,
);
await handlers.tool_result({
  toolCallId: "inline-r2",
  isError: false,
  details: { truncation: { truncated: false, outputLines: 80, totalLines: 80 } },
});

await handlers.before_agent_start({
  prompt: "Исследуй документацию Git и кратко объясни безопасный read-only workflow.",
  systemPrompt: [mainSystem],
});
await emitAssistant(`${nativeHeader}\n${safeTask}\n`);
assert.equal(
  await handlers.tool_call(tool("glob", "main-selected-native")),
  undefined,
);

const lightStart = await handlers.before_agent_start({
  prompt: "Реализуй умеренное многошаговое изменение без миграций.",
  systemPrompt: [mainSystem],
});
const lightContract = lightStart.systemPrompt.join("\n");
assert.match(lightContract, /scope → execute → verify/i);
assert.match(lightContract, /must not create a PAI run PRD or MEMORY\/WORK/i);
await emitAssistant(`${algorithmLightHeader}\n${safeTask}\n`);
assert.equal(await handlers.tool_call(tool("glob", "main-selected-light")), undefined);
assert.match(
  (await handlers.tool_call(tool("read", "light-algorithm-read", { path: algorithmPath }))).reason,
  /ALGORITHM LIGHT must never read the full Algorithm file/,
);
await emitAssistant(`${algorithmLightHeader}\n${safeTask}\n`);
assert.equal((await handlers.tool_call(tool("glob", "light-repeat"))).block, true);

await handlers.before_agent_start({
  prompt: "Диагностируй production data-loss incident и реализуй multi-file migration fix.",
  systemPrompt: [mainSystem],
});
await emitAssistant(`${algorithmHeader}\n${safeTask}\n`);
assert.equal(
  await handlers.tool_call(tool("read", "main-selected-algorithm", { path: algorithmPath })),
  undefined,
);

await handlers.before_agent_start({
  prompt: "Привет!",
  systemPrompt: [mainSystem],
});
await emitAssistant(`${minimalHeader}\n📃 CONTENT: Привет!`);
assert.match(
  (await handlers.tool_call(tool("glob", "main-selected-minimal"))).reason,
  /MINIMAL cannot call tools/,
);

await handlers.before_agent_start({ prompt: "проверь папку", systemPrompt: [subSystem] });
await emitAssistant(`${algorithmHeader}\n${safeTask}\n`);
assert.equal((await handlers.tool_call(tool("glob", "s1"))).block, true);
await emitAssistant(`${nativeHeader}\n${safeTask}\n`);
assert.equal(await handlers.tool_call(tool("glob", "s2")), undefined);
await emitAssistant(`${nativeHeader}\n${safeTask}\n`);
assert.equal((await handlers.tool_call(tool("glob", "s-repeat"))).block, true);

await handlers.before_agent_start({ prompt: "проверь папку", systemPrompt: [subSystem] });
await emitAssistant(`${nativeHeader}\n${safeTask}`);
assert.equal(await handlers.tool_call(tool("glob", "s-no-final-newline")), undefined);

await handlers.before_agent_start({ prompt: "проверь папку", systemPrompt: [subSystem] });
await emitAssistant(`${nativeHeader}\n${safeTask}\n[READ]\n`);
assert.equal((await handlers.tool_call(tool("glob", "s-status"))).block, true);

await handlers.before_agent_start({ prompt: "проверь папку", systemPrompt: [subSystem] });
const sevenWordTask =
  "🗒️ TASK: Восстанавливаю схему выбора режимов для агентов OMP";
await emitAssistant(`${nativeHeader}\n${sevenWordTask}\n`);
const rejectedTask = await handlers.tool_call(tool("glob", "t-rejected"));
assert.equal(rejectedTask.block, true);
assert.ok(rejectedTask.reason.includes(recoveryTask));

assert.equal(
  await handlers.before_provider_request({
    payload: { model: "claude-opus-4-6", config: {} },
  }),
  undefined,
);
const recoveryContext = await handlers.context({ messages: [] });
assert.equal(recoveryContext.messages.at(-1).customType, "pai-runtime-task-recovery");
assert.ok(recoveryContext.messages.at(-1).content.includes(recoveryTask));
assert.ok(!recoveryContext.messages.at(-1).content.includes(nativeHeader));

const recoveryProvider = await handlers.before_provider_request({
  payload: {
    model: "gemini-3-flash-agent",
    config: {
      systemInstruction: { role: "user", parts: [{ text: "base" }] },
    },
  },
});
const recoveryProviderTail =
  recoveryProvider.config.systemInstruction.parts.at(-1).text;
assert.ok(recoveryProviderTail.includes(recoveryTask));
assert.ok(!recoveryProviderTail.includes(nativeHeader));

const recoveryCliProvider = await handlers.before_provider_request({
  payload: {
    model: "gemini-3-pro-preview",
    request: {
      systemInstruction: { role: "user", parts: [{ text: "cli base" }] },
      generationConfig: {},
    },
  },
});
const recoveryCliTail =
  recoveryCliProvider.request.systemInstruction.parts.at(-1).text;
assert.ok(recoveryCliTail.includes(recoveryTask));
assert.ok(!recoveryCliTail.includes(nativeHeader));

await emitAssistant(`${recoveryTask}\n`);
assert.equal(await handlers.tool_call(tool("glob", "t-recovered")), undefined);

await handlers.before_agent_start({ prompt: "проверь повтор", systemPrompt: [subSystem] });
await emitAssistant(`${nativeHeader}\n${sevenWordTask}\n`);
assert.equal(
  (await handlers.tool_call(tool("glob", "repeat-initial"))).block,
  true,
);
await emitAssistant(`${nativeHeader}\n${recoveryTask}\n`);
const repeatedHeaderRecovery =
  await handlers.tool_call(tool("glob", "repeat-header"));
assert.equal(repeatedHeaderRecovery.block, true);
assert.ok(repeatedHeaderRecovery.reason.includes(recoveryTask));
await emitAssistant(`${recoveryTask}\n`);
assert.equal(
  await handlers.tool_call(tool("glob", "repeat-recovered")),
  undefined,
);

await handlers.before_agent_start({ prompt: "проверь пустой task", systemPrompt: [subSystem] });
await emitAssistant(`${nativeHeader}\n🗒️ TASK:\n`);
const emptyTaskRecovery = await handlers.tool_call(tool("glob", "empty-task"));
assert.equal(emptyTaskRecovery.block, true);
assert.ok(emptyTaskRecovery.reason.includes(recoveryTask));

await handlers.before_agent_start({ prompt: "проверь tool retry", systemPrompt: [subSystem] });
await emitAssistant(`${nativeHeader}\n${sevenWordTask}\n`);
assert.equal(
  (await handlers.tool_call(tool("glob", "tool-only-initial"))).block,
  true,
);
await emitAssistant("");
const toolOnlyRecovery =
  await handlers.tool_call(tool("glob", "tool-only-retry"));
assert.equal(toolOnlyRecovery.block, true);
assert.ok(toolOnlyRecovery.reason.includes(recoveryTask));

await handlers.before_agent_start({ prompt: "<pai-mode>ALGORITHM</pai-mode> проверь папку", systemPrompt: [subSystem] });
await emitAssistant(`${algorithmHeader}\n${safeTask}\n`);
assert.equal(await handlers.tool_call(tool("read", "s3", { path: algorithmPath })), undefined);

await handlers.before_agent_start({
  prompt: "<pai-mode>ALGORITHM_LIGHT</pai-mode> проверь папку",
  systemPrompt: [subSystem],
});
await emitAssistant(`${algorithmLightHeader}\n${safeTask}\n`);
assert.equal(await handlers.tool_call(tool("glob", "s-light")), undefined);
assert.match(
  (await handlers.tool_call(tool("read", "s-light-algorithm", { path: algorithmPath }))).reason,
  /ALGORITHM LIGHT must never read the full Algorithm file/,
);
assert.match(
  (
    await handlers.tool_call(
      tool("read", "s-light-inline-algorithm", { path: `${algorithmPath}:1-8` }),
    )
  ).reason,
  /ALGORITHM LIGHT must never read the full Algorithm file/,
);

const advisorPrompt = "### Session update\n\n**agent**:\n═══ PAI ═══════════════════════════\n🗣️ PAI: Привет!";
const advisorStart = await handlers.before_agent_start({
  prompt: advisorPrompt,
  systemPrompt: [mainSystem],
});
const advisorContract = advisorStart.systemPrompt.join("\n");
assert.equal(advisorStart.systemPrompt[0], mainSystem);
assert.match(advisorContract, /OMP ADVISOR TRANSPORT CONTRACT/);
assert.match(advisorContract, /Advisor must never enter ALGORITHM/);
assert.doesNotMatch(advisorContract, /selected mode header must be the first visible line/i);
assert.equal(
  await handlers.tool_call(tool("read", "advisor-read", { path: "/tmp/evidence.txt" })),
  undefined,
);
assert.equal(await handlers.tool_call(tool("grep", "advisor-grep")), undefined);
assert.equal(await handlers.tool_call(tool("glob", "advisor-glob")), undefined);
assert.equal(await handlers.tool_call(tool("advise", "advisor-advise")), undefined);
assert.match(
  (await handlers.tool_call(tool("read", "advisor-algorithm", { path: algorithmPath }))).reason,
  /must never enter ALGORITHM/,
);
assert.match(
  (
    await handlers.tool_call(
      tool("read", "advisor-inline-algorithm", { path: `${algorithmPath}:301-` }),
    )
  ).reason,
  /must never enter ALGORITHM/,
);
assert.match(
  (await handlers.tool_call(tool("bash", "advisor-bash"))).reason,
  /review-only/,
);
await emitAssistant(`${algorithmHeader}\n${safeTask}\n`);
assert.match(
  (await handlers.tool_call(tool("advise", "advisor-algorithm-header"))).reason,
  /must never emit an ALGORITHM header/,
);

await handlers.before_agent_start({
  prompt: advisorPrompt,
  systemPrompt: [mainSystem],
});
await emitAssistant(`${algorithmLightHeader}\n${safeTask}\n`);
assert.match(
  (await handlers.tool_call(tool("advise", "advisor-light-header"))).reason,
  /must never emit an ALGORITHM header/,
);

console.log("PASS: portable runtime gate assertions cover routing, exact output protocol, dual official Gemini payloads, model-specific thinking limits, Algorithm reads, continuation, truncation, message identity, and retry");
