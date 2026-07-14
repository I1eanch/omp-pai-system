import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export type PaiRuntimeGateOptions = {
  algorithmPath: string;
  algorithmVersion: string;
  dataRoot: string;
  paiTemplateRoot: string;
};

const MINIMAL_HEADER = "═══ PAI ═══════════════════════════";
const NATIVE_HEADER = "════ PAI | NATIVE MODE ═══════════════════════";
const SAFE_TASK_LINE =
  "🗒️ TASK: Выполняю запрос полностью и проверяю результат по критериям";
const SAFE_TASK_TEXT = SAFE_TASK_LINE.slice("🗒️ TASK:".length).trim();
const MINIMAL_SUMMARY_BULLETS = [
  "- Запрос пользователя получен и корректно классифицирован системой PAI",
  "- Режим MINIMAL выбран для краткого ответа без инструментов",
  "- Изменения файлов и внешние действия здесь не требуются",
  "- Ответ сформирован полностью согласно активному контракту текущего режима",
].join("\n");
const MINIMAL_PAI_LINE =
  "🗣️ PAI: Система готова продолжить работу по следующему запросу пользователя";
const NATIVE_PAI_LINE =
  "🗣️ PAI: Запрос выполнен полностью результат проверен по заданным критериям";

const ALGORITHM_ROUTE_RULES = [
  { category: "troubleshooting", pattern: /troubleshoot|диагност|устран.{0,24}(?:сбой|ошиб|проблем)|исправ.{0,16}(?:сбой|баг|проблем)|разбер.{0,24}проблем/iu },
  { category: "debugging", pattern: /debug|отлад/iu },
  { category: "building", pattern: /\bbuild\b|собер.{0,24}(?:проект|систем|прилож|модул|компонент)|реализ/iu },
  { category: "investigating", pattern: /investigat|исслед|расслед|найд.{0,16}причин/iu },
  { category: "designing", pattern: /\bdesign|дизайн|спроектир/iu },
  { category: "refactoring", pattern: /refactor|рефактор/iu },
  { category: "planning", pattern: /\bplan(?:ning)?\b|планир|состав.{0,16}план|разработ.{0,16}план/iu },
  { category: "complex-or-difficult", pattern: /complex|difficult|сложн/iu },
  { category: "multiple-files-or-steps", pattern: /многошаг|multi[- ]?step|multiple.{0,24}(?:files?|modules?|components?|steps?)|нескольк.{0,40}(?:файл|модул|компонент|шаг)|связанн.{0,20}файл/iu },
];

const MINIMAL_ROUTE_PATTERN =
  /^(?:привет|здравствуйте|добр(?:ый|ое) (?:день|вечер|утро)|hello|hi|спасибо|благодарю|ок|хорошо|понял|понятно|принято|да|верно|точно|отлично|готово|сделано|согласен|подтверждаю|yes|correct|great|done|[0-9]+(?:\s*(?:\/|из)\s*10)?|(?:ставлю|оценка)\s+[0-9]+(?:\s*(?:\/|из)\s*10)?)[!.]?$/iu;
const NATIVE_ROUTE_PATTERN =
  /^(?:исправ|поправ|перевед|переимен|замен|удал|добав|покаж|посчит|объясн|проверь|найд|открой|прочитай|напиши|fix|translate|rename|replace|delete|add|show|count|explain|check|find|open|read|write)\p{L}*/iu;
const NATIVE_QUESTION_PATTERN =
  /^(?:ты\s+\p{L}+|сколько|котор(?:ый|ая|ое)|какой|какая|какое|что (?:значит|такое)|кто (?:такой|такая)|где|когда)(?=$|[\s?!.,:;])/iu;

type GeminiConfig = Record<string, unknown> & {
  systemInstruction?: unknown;
  thinkingConfig?: Record<string, unknown>;
};

type GeminiCliRequest = Record<string, unknown> & {
  systemInstruction?: unknown;
  generationConfig?: Record<string, unknown> & {
    thinkingConfig?: Record<string, unknown>;
  };
};

type ProviderPayload = {
  model?: unknown;
  config?: GeminiConfig;
  request?: GeminiCliRequest;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function assistantText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((part): part is { type: "text"; text: string } =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("");
}

function selectorRange(selector: unknown): { start: number; end: number | null } | null {
  if (typeof selector !== "string") return null;
  const match = selector.match(/^(\d+)-(\d*)$/);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: match[2] ? Number(match[2]) : null,
  };
}

function exactTextBlock(value: unknown, exact: string): boolean {
  return value === exact || value === `${exact}\n`;
}

function appendProviderInstruction(systemInstruction: unknown, text: string) {
  const tailPart = { text };
  if (
    isRecord(systemInstruction)
    && Array.isArray(systemInstruction.parts)
  ) {
    return {
      ...systemInstruction,
      parts: [...systemInstruction.parts, tailPart],
    };
  }
  if (typeof systemInstruction === "string" && systemInstruction.length > 0) {
    return {
      role: "user",
      parts: [{ text: systemInstruction }, tailPart],
    };
  }
  return { role: "user", parts: [tailPart] };
}

function deterministicGeminiThinking(
  model: string,
  value: unknown,
): Record<string, unknown> {
  const current = isRecord(value) ? value : {};
  const {
    thinkingBudget: _thinkingBudget,
    thinkingLevel: _thinkingLevel,
    ...rest
  } = current;
  const usesThinkingLevel =
    typeof current.thinkingLevel === "string" || /^gemini-3(?:[.-]|$)/iu.test(model);
  if (usesThinkingLevel) {
    return {
      ...rest,
      includeThoughts: false,
      thinkingLevel: /(?:^|[-.])pro(?:[-.]|$)/iu.test(model) ? "LOW" : "MINIMAL",
    };
  }
  return {
    ...rest,
    includeThoughts: false,
    thinkingBudget: /^gemini-2\.5-pro(?:[-.]|$)/iu.test(model) ? 128 : 0,
  };
}

function isComplexMainPrompt(prompt: unknown): prompt is string {
  return typeof prompt === "string"
    && ALGORITHM_ROUTE_RULES.some(({ pattern }) => pattern.test(prompt));
}

function isMinimalMainPrompt(prompt: unknown): prompt is string {
  return typeof prompt === "string" && MINIMAL_ROUTE_PATTERN.test(prompt.trim());
}

function isNativeMainPrompt(prompt: unknown): prompt is string {
  if (typeof prompt !== "string") return false;
  const text = prompt.trim();
  const wordCount = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const hasMultipleActions = /[;\n]|\s(?:и|затем|потом|после этого|and|then)\s/iu.test(text);
  return wordCount > 0
    && wordCount <= 16
    && !hasMultipleActions
    && (
      NATIVE_ROUTE_PATTERN.test(text)
      || NATIVE_QUESTION_PATTERN.test(text)
    );
}

export function createPaiRuntimeGate(options: PaiRuntimeGateOptions) {
  const ALGORITHM_HEADER = `♻︎ Entering the PAI ALGORITHM… (v${options.algorithmVersion}) ═════════════`;
  const ALGORITHM_PATH = options.algorithmPath;
  const portableRootMap = [
    "PORTABLE ROOT MAP — overrides legacy path examples in the upstream Algorithm:",
    `MEMORY root: ${JSON.stringify(join(options.dataRoot, "MEMORY"))}`,
    `TELOS root: ${JSON.stringify(join(options.dataRoot, "TELOS"))}`,
    `PAI template root: ${JSON.stringify(options.paiTemplateRoot)}`,
    "Never resolve runtime state outside these configured roots unless the user explicitly supplies another local path.",
  ].join("\n");
  const validPrimaryHeaders = new Set([
    MINIMAL_HEADER,
    NATIVE_HEADER,
    ALGORITHM_HEADER,
  ]);

  return function paiRuntimeGate(pi: ExtensionAPI): void {
  let requiresNative = false;
  let requiresMinimal = false;
  let requiresAlgorithm = false;
  let visibleText = "";
  let seenHeader = "";
  let approvedHeader = "";
  let assistantMessageSequence = 0;
  let approvedAssistantMessageSequence: number | null = null;
  let algorithmReadStarted = false;
  let algorithmReadApproved = false;
  let nextAlgorithmLine = 1;
  let algorithmTotalLines: number | null = null;
  let pendingAlgorithmReadToolCallId: string | null = null;
  let pendingAlgorithmReadStartLine: number | null = null;
  let providerTailInstruction = "";

  pi.on("before_agent_start", (event) => {
    const isSubagent = event.systemPrompt.some((part) =>
      part.includes("You are operating on a piece of work assigned to you by the main agent.")
    );
    const hasExplicitAlgorithm = event.prompt.includes(
      "<pai-mode>ALGORITHM</pai-mode>",
    );
    const mainRequiresMinimal =
      !isSubagent && isMinimalMainPrompt(event.prompt);
    const mainRequiresNative =
      !isSubagent
      && !mainRequiresMinimal
      && !isComplexMainPrompt(event.prompt)
      && isNativeMainPrompt(event.prompt);
    const mainRequiresAlgorithm =
      !isSubagent && !mainRequiresMinimal && !mainRequiresNative;
    requiresMinimal = mainRequiresMinimal;
    requiresNative =
      (isSubagent && !hasExplicitAlgorithm) || mainRequiresNative;
    requiresAlgorithm =
      (isSubagent && hasExplicitAlgorithm) || mainRequiresAlgorithm;
    visibleText = "";
    seenHeader = "";
    approvedHeader = "";
    assistantMessageSequence = 0;
    approvedAssistantMessageSequence = null;
    algorithmReadStarted = false;
    algorithmReadApproved = false;
    nextAlgorithmLine = 1;
    algorithmTotalLines = null;
    pendingAlgorithmReadToolCallId = null;
    pendingAlgorithmReadStartLine = null;

    const taskRequirement = `The next line must be exactly:\n${SAFE_TASK_LINE}\nIt is a fixed protocol line, not a task description: copy it character-for-character and never paraphrase it. Never append prose, status text, HTML, symbols, tool labels such as [READ], or tool intent on the TASK line. Put tool intent only in the tool call's i field.`;
    const requirement = requiresMinimal
      ? `This OMP turn requires MINIMAL. Emit the complete active MINIMAL template exactly once, beginning with exact first line "${MINIMAL_HEADER}". Use exactly these four SUMMARY bullets:\n${MINIMAL_SUMMARY_BULLETS}\nUse exactly this final line:\n${MINIMAL_PAI_LINE}\nDo not call tools.`
      : requiresNative
        ? `This OMP turn requires NATIVE. Exactly once at the start of this user turn, emit visible text whose exact first line is:\n${NATIVE_HEADER}\n${taskRequirement}\nDo not place the header only in hidden reasoning. If you will call a tool, the complete first text content block must equal exactly "${NATIVE_HEADER}\n${SAFE_TASK_LINE}" with only an optional terminal newline and no other characters; immediately call the tool with no intervening narrative or status. If no tool is needed, emit the complete required NATIVE template in the same assistant message. Use exactly this final line:\n${NATIVE_PAI_LINE}\nLater tool-loop messages must not repeat the mode header. FINAL LITERAL CHECK: line 2 must be exactly "${SAFE_TASK_LINE}"; if you drafted any other TASK, replace it before emitting text.`
        : `This OMP turn requires ALGORITHM. Exactly once at the start of this user turn, emit visible text whose exact first line is:\n${ALGORITHM_HEADER}\n${taskRequirement}\nThe complete first text content block must equal exactly "${ALGORITHM_HEADER}\n${SAFE_TASK_LINE}" with only an optional terminal newline and no other characters. Copy the fixed TASK literally; do not summarize or personalize it. Immediately call read with exact path ${ALGORITHM_PATH}, no selector, and no intervening narrative or status. Complete every truncated continuation before any other tool. Later tool-loop messages must not repeat the mode header. FINAL LITERAL CHECK: line 2 must be exactly "${SAFE_TASK_LINE}"; if you drafted any other TASK, replace it before emitting text.\n${portableRootMap}`;

    const finalLiteralContract = `FINAL PAI OUTPUT CONTRACT — CHECK IMMEDIATELY BEFORE EMITTING TEXT:\n- MINIMAL: first line is exactly "${MINIMAL_HEADER}", emit every active-template field, use exactly these SUMMARY lines:\n${MINIMAL_SUMMARY_BULLETS}\nThen use exactly this final line:\n${MINIMAL_PAI_LINE}\n- NATIVE: first line is exactly "${NATIVE_HEADER}"; second line is exactly "${SAFE_TASK_LINE}". Never replace this fixed TASK with a description or append text on that line. Emit every active-template field, keep CONTENT at or below 128 lines, and use exactly this final line:\n${NATIVE_PAI_LINE}\n- ALGORITHM: the entire first text block is exactly "${ALGORITHM_HEADER}\n${SAFE_TASK_LINE}" with only an optional terminal newline, then immediately invoke the real read tool for ${ALGORITHM_PATH}. Emit no ordinary text before that invocation; use the actual tool-call protocol.\nAfter the first emission, never output any PAI mode header or TASK line again during this user turn.`;
    providerTailInstruction = `${requirement}\n${finalLiteralContract}`;
    return {
      systemPrompt: [
        ...event.systemPrompt,
        `OMP PAI RUNTIME GATE\n${requirement}`,
        finalLiteralContract,
      ],
    };
  });

  pi.on("before_provider_request", (event) => {
    if (approvedHeader) return;
    const payload = event.payload as ProviderPayload | undefined;
    if (
      !isRecord(payload)
      || typeof payload.model !== "string"
      || !payload.model.includes("gemini")
    ) {
      return;
    }
    if (isRecord(payload.config)) {
      return {
        ...payload,
        config: {
          ...payload.config,
          systemInstruction: appendProviderInstruction(
            payload.config.systemInstruction,
            providerTailInstruction,
          ),
          temperature: 0,
          thinkingConfig: deterministicGeminiThinking(
            payload.model,
            payload.config.thinkingConfig,
          ),
        },
      };
    }
    if (isRecord(payload.request)) {
      const generationConfig = isRecord(payload.request.generationConfig)
        ? payload.request.generationConfig
        : {};
      return {
        ...payload,
        request: {
          ...payload.request,
          systemInstruction: appendProviderInstruction(
            payload.request.systemInstruction,
            providerTailInstruction,
          ),
          generationConfig: {
            ...generationConfig,
            temperature: 0,
            thinkingConfig: deterministicGeminiThinking(
              payload.model,
              generationConfig.thinkingConfig,
            ),
          },
        },
      };
    }
    return;
  });

  pi.on("context", (event) => {
    if (!approvedHeader) return;
    const messages = event.messages ?? [];
    const lastMessage = messages.at(-1) as { customType?: unknown } | undefined;
    if (lastMessage?.customType === "pai-runtime-continuation") return;
    return {
      messages: [
        ...messages,
        {
          role: "custom",
          customType: "pai-runtime-continuation",
          content: `<system-directive>PAI continuation state: ${approvedHeader} and ${SAFE_TASK_LINE} were already emitted for this user turn. Do not emit any PAI mode header or TASK line again, including after tool results, custom or advisor messages, compaction, retry, or continuation. Continue directly with the required next tool or the remaining final template fields.</system-directive>`,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("message_start", (event) => {
    if (event.message?.role !== "assistant") return;
    assistantMessageSequence += 1;
    visibleText = "";
  });

  pi.on("message_update", (event) => {
    const text = assistantText(event.message);
    if (text) visibleText = text;
  });

  pi.on("tool_call", (event) => {
    const input = event.input as { path?: unknown; selector?: unknown } | undefined;
    const lines = visibleText.split(/\r?\n/);

    if (!approvedHeader) {
      let taskText = "";
      let preambleExact = false;

      if (!seenHeader) {
        const header = lines[0] ?? "";
        const validHeader = requiresMinimal
          ? header === MINIMAL_HEADER
          : requiresNative
            ? header === NATIVE_HEADER
            : header === ALGORITHM_HEADER;
        const expected = requiresMinimal
          ? MINIMAL_HEADER
          : requiresNative
            ? NATIVE_HEADER
            : ALGORITHM_HEADER;

        if (!validHeader) {
          return {
            block: true,
            reason: `PAI runtime gate: emit visible assistant text first. Its exact first line must be ${expected}. Hidden thinking does not satisfy this gate. Then retry the tool call.`,
          };
        }

        if (header === MINIMAL_HEADER) {
          return {
            block: true,
            reason: `PAI runtime gate: MINIMAL cannot call tools. Reclassify this request as NATIVE or ALGORITHM and begin a new visible response with the matching exact header.`,
          };
        }

        seenHeader = header;
        taskText = lines[1]?.startsWith("🗒️ TASK:")
          ? lines[1].slice("🗒️ TASK:".length).trim()
          : "";
        preambleExact = exactTextBlock(visibleText, `${header}\n${SAFE_TASK_LINE}`);
      } else {
        const repeatedHeader = lines.some(
          (line) => validPrimaryHeaders.has(line.trimEnd()),
        );
        if (repeatedHeader) {
          return {
            block: true,
            reason: `PAI runtime gate: the mode header was already accepted for this turn. Emit only the corrected TASK line, without repeating any mode header, then retry the tool call.`,
          };
        }
        taskText = lines[0]?.startsWith("🗒️ TASK:")
          ? lines[0].slice("🗒️ TASK:".length).trim()
          : "";
        preambleExact = exactTextBlock(visibleText, SAFE_TASK_LINE);
      }

      if (taskText !== SAFE_TASK_TEXT || !preambleExact) {
        return {
          block: true,
          reason: `PAI runtime gate: emit only the corrected line "${SAFE_TASK_LINE}" with no following text; a terminal newline is optional. Do not repeat the mode header or append status/tool labels, then retry the tool call.`,
        };
      }

      approvedHeader = seenHeader;
      approvedAssistantMessageSequence = assistantMessageSequence;
    } else if (assistantMessageSequence !== approvedAssistantMessageSequence) {
      const repeatedHeader = lines.some(
        (line) => validPrimaryHeaders.has(line.trimEnd()),
      );
      const repeatedTask = lines.some((line) => line === SAFE_TASK_LINE);
      if (repeatedHeader || repeatedTask) {
        return {
          block: true,
          reason: `PAI runtime gate: the mode header and TASK line may each appear only once per turn. Remove the repeated preamble line and retry the tool call.`,
        };
      }
      approvedAssistantMessageSequence = assistantMessageSequence;
    }

    if (approvedHeader === ALGORITHM_HEADER && !algorithmReadApproved) {
      if (pendingAlgorithmReadToolCallId) {
        return {
          block: true,
          reason: `PAI runtime gate: wait for the required Algorithm read result before calling another tool.`,
        };
      }

      const isAlgorithmRead =
        event.toolName === "read" && input?.path === ALGORITHM_PATH;
      if (!isAlgorithmRead) {
        return {
          block: true,
          reason: `PAI runtime gate: the next ALGORITHM tool call must be read with exact path ${ALGORITHM_PATH}. Retry that read before any other tool.`,
        };
      }

      if (!algorithmReadStarted && input?.selector !== undefined) {
        return {
          block: true,
          reason: `PAI runtime gate: the initial Algorithm read must use exact path ${ALGORITHM_PATH} without a selector.`,
        };
      }

      if (algorithmReadStarted) {
        const continuation = selectorRange(input?.selector);
        const coversRemainder =
          continuation?.start === nextAlgorithmLine &&
          (continuation.end === null ||
            (algorithmTotalLines !== null &&
              continuation.end >= algorithmTotalLines));
        if (!coversRemainder) {
          const expectedSelector = algorithmTotalLines !== null
            ? `${nextAlgorithmLine}- or ${nextAlgorithmLine}-${algorithmTotalLines}`
            : `${nextAlgorithmLine}-`;
          return {
            block: true,
            reason: `PAI runtime gate: continue the truncated Algorithm read with exact path ${ALGORITHM_PATH} and selector ${expectedSelector}. A shorter bounded range cannot complete Algorithm.`,
          };
        }
      }

      pendingAlgorithmReadStartLine = algorithmReadStarted
        ? nextAlgorithmLine
        : 1;
      pendingAlgorithmReadToolCallId = event.toolCallId;
    }
  });

  pi.on("tool_result", (event) => {
    const readStart = pendingAlgorithmReadStartLine;
    if (event.toolCallId !== pendingAlgorithmReadToolCallId || readStart === null) return;

    if (event.isError === false) {
      const details = event.details as {
        truncation?: {
          truncated?: unknown;
          outputLines?: unknown;
          totalLines?: unknown;
          lastLinePartial?: unknown;
        };
      } | undefined;
      const truncation = details?.truncation;
      if (truncation?.truncated === true) {
        const outputLines = Number(truncation.outputLines);
        if (Number.isInteger(outputLines) && outputLines > 0) {
          const totalLines = Number(truncation.totalLines);
          if (
            readStart === 1 &&
            Number.isInteger(totalLines) &&
            totalLines > 0
          ) {
            algorithmTotalLines = totalLines;
          }
          algorithmReadStarted = true;
          nextAlgorithmLine =
            readStart +
            outputLines -
            (truncation.lastLinePartial ? 1 : 0);
        }
      } else {
        algorithmReadApproved = true;
      }
    }

    pendingAlgorithmReadToolCallId = null;
    pendingAlgorithmReadStartLine = null;
  });
}
}
