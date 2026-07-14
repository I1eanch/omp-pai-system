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

const mainSystem = "base";
const subSystem = "COOP\nYou are operating on a piece of work assigned to you by the main agent.";
const minimalHeader = "═══ PAI ═══════════════════════════";
const nativeHeader = "════ PAI | NATIVE MODE ═══════════════════════";
const algorithmHeader = "♻︎ Entering the PAI ALGORITHM… (v3.5.0) ═════════════";
const safeTask = "🗒️ TASK: Выполняю запрос полностью и проверяю результат по критериям";
const assistantText = (text: string) => ({ message: { role: "assistant", content: [{ type: "text", text }] } });
const emitAssistant = async (text: string) => {
  const event = assistantText(text);
  if (handlers.message_start) await handlers.message_start(event);
  await handlers.message_update(event);
};
const tool = (toolName: string, toolCallId: string, input: Record<string, unknown> = {}) => ({ toolName, toolCallId, input });

await handlers.before_agent_start({ prompt: "сложная задача", systemPrompt: [mainSystem] });
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
assert.match(deterministicGemini.config.systemInstruction.parts.at(-1).text, /This OMP turn requires ALGORITHM/);
assert.ok(deterministicGemini.config.systemInstruction.parts.at(-1).text.includes(`${algorithmHeader}\n${safeTask}`));
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
      tool("read", "r-short", { path: algorithmPath, selector: "301-301" }),
    )
  ).block,
  true,
);
assert.equal(
  (
    await handlers.tool_call(
      tool("read", "r-wrong-start", { path: algorithmPath, selector: "302-" }),
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

const algorithmRoutingCases = [
  ["troubleshooting", "Устрани неожиданный сбой авторизации."],
  ["debugging", "Отладь падение парсера."],
  ["building", "Собери новый модуль импорта."],
  ["designing", "Спроектируй архитектуру очереди."],
  ["investigating", "Исследуй проблему и найди причину."],
  ["refactoring", "Проведи рефакторинг слоя хранения."],
  ["planning", "Составь план миграции данных."],
  ["complex-or-difficult", "Реши сложную задачу согласования состояний."],
  ["multiple-files-or-steps", "Несколько модулей конфликтуют; исправь связанные файлы."],
];
for (const [category, prompt] of algorithmRoutingCases) {
  await handlers.before_agent_start({ prompt, systemPrompt: [mainSystem] });
  await emitAssistant(`${nativeHeader}\n${safeTask}\n`);
  assert.equal(
    (await handlers.tool_call(tool("glob", `route-${category}`))).block,
    true,
    category,
  );
  await emitAssistant(`${algorithmHeader}\n${safeTask}\n`);
  assert.equal(
    await handlers.tool_call(tool("read", `route-read-${category}`, { path: algorithmPath })),
    undefined,
    category,
  );
}

await handlers.before_agent_start({
  prompt: "Исправь опечатку в фразе: «Я хочю домой».",
  systemPrompt: [mainSystem],
});
await emitAssistant(`${algorithmHeader}\n${safeTask}\n`);
assert.equal((await handlers.tool_call(tool("glob", "atomic-algorithm"))).block, true);
await emitAssistant(`${nativeHeader}\n${safeTask}\n`);
assert.equal(await handlers.tool_call(tool("glob", "atomic-native")), undefined);

const nativeQuestionRoutingCases = [
  ["status", "ты завис?"],
  ["arithmetic", "Сколько будет 2+2?"],
  ["definition", "Что такое JSON?"],
  ["location", "Где файл?"],
  ["deadline", "Когда дедлайн?"],
  ["state", "Какой статус?"],
];
for (const [category, prompt] of nativeQuestionRoutingCases) {
  await handlers.before_agent_start({ prompt, systemPrompt: [mainSystem] });
  await emitAssistant(`${nativeHeader}\n${safeTask}\n`);
  assert.equal(
    await handlers.tool_call(tool("glob", `native-question-${category}`)),
    undefined,
    category,
  );
}

await handlers.before_agent_start({
  prompt: "Подготовь подробный обзор темы с примерами, рисками и рекомендациями.",
  systemPrompt: [mainSystem],
});
await emitAssistant(`${nativeHeader}\n${safeTask}\n`);
assert.equal((await handlers.tool_call(tool("glob", "unmatched-native"))).block, true);
await emitAssistant(`${algorithmHeader}\n${safeTask}\n`);
assert.equal(await handlers.tool_call(tool("read", "unmatched-algorithm", { path: algorithmPath })), undefined);

const minimalRoutingCases = [
  ["greeting", "Привет!"],
  ["formal-greeting", "Здравствуйте"],
  ["morning-greeting", "Доброе утро"],
  ["ack-yes", "Да"],
  ["ack-correct", "Верно"],
  ["ack-great", "Отлично"],
  ["ack-ready", "Готово"],
  ["ack-done", "Сделано"],
  ["thanks", "Спасибо"],
  ["rating-short", "9/10"],
  ["rating-natural", "Ставлю 9 из 10"],
];
for (const [category, prompt] of minimalRoutingCases) {
  await handlers.before_agent_start({ prompt, systemPrompt: [mainSystem] });
  await emitAssistant(`${minimalHeader}\n📃 CONTENT: ${prompt}`);
  assert.match(
    (await handlers.tool_call(tool("glob", `minimal-${category}`))).reason,
    /MINIMAL cannot call tools/,
    category,
  );
}

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
await emitAssistant(
  `${nativeHeader}\n🗒️ TASK: Выполняю другой запрос и проверяю результат по критериям\n`,
);
assert.equal((await handlers.tool_call(tool("glob", "t1"))).block, true);
await emitAssistant(`${safeTask}\n`);
assert.equal(await handlers.tool_call(tool("glob", "t2")), undefined);
await emitAssistant(`${nativeHeader}\n${safeTask}\n`);
assert.equal((await handlers.tool_call(tool("glob", "t3"))).block, true);

await handlers.before_agent_start({ prompt: "<pai-mode>ALGORITHM</pai-mode> проверь папку", systemPrompt: [subSystem] });
await emitAssistant(`${algorithmHeader}\n${safeTask}\n`);
assert.equal(await handlers.tool_call(tool("read", "s3", { path: algorithmPath })), undefined);

console.log("PASS: portable runtime gate assertions cover routing, exact output protocol, dual official Gemini payloads, model-specific thinking limits, Algorithm reads, continuation, truncation, message identity, and retry");
