import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export type PaiRuntimeGateOptions = {
  algorithmPath: string;
  algorithmVersion: string;
  dataRoot: string;
  memoryRoot?: string;
  telosRoot?: string;
  paiTemplateRoot: string;
};

const MINIMAL_HEADER = "═══ PAI ═══════════════════════════";
const NATIVE_HEADER = "════ PAI | NATIVE MODE ═══════════════════════";
const ALGORITHM_LIGHT_HEADER = "♻︎ Entering the PAI ALGORITHM LIGHT ═════════════";



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

type ReadToolInput = { path?: unknown; selector?: unknown };

function readInputForPath(
  input: ReadToolInput | undefined,
  expectedPath: string,
): { selector: unknown } | null {
  if (typeof input?.path !== "string") return null;
  if (input.path === expectedPath) {
    return { selector: input.selector };
  }
  const inlineSelectorPrefix = `${expectedPath}:`;
  if (
    input.selector === undefined
    && input.path.startsWith(inlineSelectorPrefix)
  ) {
    return { selector: input.path.slice(inlineSelectorPrefix.length) };
  }
  return null;
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
    const requiresLowFloor =
      /(?:^|[-.])pro(?:[-.]|$)/iu.test(model)
      || /^gemini-3\.(?:6|7|8)-flash(?:[-.]|$)/iu.test(model);
    return {
      ...rest,
      includeThoughts: false,
      thinkingLevel: requiresLowFloor ? "LOW" : "MINIMAL",
    };
  }
  return {
    ...rest,
    includeThoughts: false,
    thinkingBudget: /^gemini-2\.5-pro(?:[-.]|$)/iu.test(model) ? 128 : 0,
  };
}



export function createPaiRuntimeGate(options: PaiRuntimeGateOptions) {
  const ALGORITHM_HEADER = `♻︎ Entering the PAI ALGORITHM… (v${options.algorithmVersion}) ═════════════`;
  const ALGORITHM_PATH = options.algorithmPath;
  const memoryRoot = options.memoryRoot ?? join(options.dataRoot, "MEMORY");
  const telosRoot = options.telosRoot ?? join(options.dataRoot, "TELOS");
  const portableRootMap = [
    "PORTABLE ROOT MAP — overrides legacy path examples in the upstream Algorithm:",
    `MEMORY root: ${JSON.stringify(memoryRoot)}`,
    `TELOS root: ${JSON.stringify(telosRoot)}`,
    `PAI template root: ${JSON.stringify(options.paiTemplateRoot)}`,
    "Never resolve runtime state outside these configured roots unless the user explicitly supplies another local path.",
  ].join("\n");
  const validPrimaryHeaders: Record<string, true> = {
    [MINIMAL_HEADER]: true,
    [NATIVE_HEADER]: true,
    [ALGORITHM_LIGHT_HEADER]: true,
    [ALGORITHM_HEADER]: true,
  };
  const advisorTools: Record<string, true> = {
    advise: true,
    glob: true,
    grep: true,
    read: true,
  };

  return function paiRuntimeGate(pi: ExtensionAPI): void {
  let requiresNative = false;
  let requiresAlgorithmLight = false;
  let requiresAlgorithm = false;
  let visibleText = "";
  
  let approvedHeader = "";
  
  
  let algorithmReadStarted = false;
  let algorithmReadApproved = false;
  let nextAlgorithmLine = 1;
  let algorithmTotalLines: number | null = null;
  let pendingAlgorithmReadToolCallId: string | null = null;
  let pendingAlgorithmReadStartLine: number | null = null;
  let providerTailInstruction = "";
  let isAdvisorTurn = false;
  let advisorAlgorithmViolation = false;
  

  pi.on("before_agent_start", (event) => {
    isAdvisorTurn =
      event.prompt.trimStart().startsWith("### Session update")
      && event.prompt.includes("**agent**:");
    const isSubagent = event.systemPrompt.some((part) =>
      part.includes("You are operating on a piece of work assigned to you by the main agent.")
    );
    const hasExplicitAlgorithm = event.prompt.includes(
      "<pai-mode>ALGORITHM</pai-mode>",
    );
    const hasExplicitAlgorithmLight = event.prompt.includes(
      "<pai-mode>ALGORITHM_LIGHT</pai-mode>",
    );
    requiresNative =
      !isAdvisorTurn
      && isSubagent
      && !hasExplicitAlgorithm
      && !hasExplicitAlgorithmLight;
    requiresAlgorithm =
      !isAdvisorTurn
      && isSubagent
      && hasExplicitAlgorithm;
    requiresAlgorithmLight =
      !isAdvisorTurn
      && isSubagent
      && !hasExplicitAlgorithm
      && hasExplicitAlgorithmLight;
    visibleText = "";
    
    approvedHeader = "";
    
    
    algorithmReadStarted = false;
    algorithmReadApproved = false;
    nextAlgorithmLine = 1;
    algorithmTotalLines = null;
    pendingAlgorithmReadToolCallId = null;
    pendingAlgorithmReadStartLine = null;
    advisorAlgorithmViolation = false;

    const displayGuidance = "Mode headers and TASK summaries are optional presentation. Tool calls must never be blocked by header spelling, Unicode decoration, TASK word count, or repeated preamble text.";
    const algorithmLightContract = `ALGORITHM LIGHT contract: scope → execute → verify. Scope the bounded change and its concrete risks, execute directly, then run focused verification. Do not read ${ALGORITHM_PATH} at any point in this turn. You must not create a PAI run PRD or MEMORY/WORK tracking artifact. Do not create ISC, perform seven phase edits, or append an Algorithm reflection. After the initial header and TASK line, use concise progress only when it carries evidence; finish with the active NATIVE CONTENT, CHANGE, VERIFY, and PAI fields.`;
    const advisorRequirement = `This is an internal OMP Advisor turn triggered by a synthetic "### Session update". Advisor is review-only and must never enter ALGORITHM or ALGORITHM LIGHT, emit a PAI mode header or TASK line, read the Algorithm file, create a PRD, or answer the user. Concise OMP MINIMAL output is valid. Use read, grep, or glob only when inspection is needed, then invoke advise for a genuine defect; otherwise return no text. Never request post-hoc continuation solely to rewrite PAI formatting.`;
    const requirement = isAdvisorTurn
          ? advisorRequirement
          : requiresNative
            ? `This OMP subagent turn requires NATIVE. Do not enter ALGORITHM LIGHT or ALGORITHM unless the delegated instruction explicitly contains the matching <pai-mode> marker. ${displayGuidance}`
            : requiresAlgorithmLight
              ? `This delegated OMP subagent turn explicitly selects ALGORITHM LIGHT. ${algorithmLightContract} ${displayGuidance}`
              : requiresAlgorithm
                ? `This delegated OMP subagent turn explicitly selects ALGORITHM. Immediately call read with exact path ${ALGORITHM_PATH}, no selector, before any other tool. Complete every truncated continuation before any other tool. ${displayGuidance}\n${portableRootMap}`
                : `This is an OMP main-agent turn. Apply the active PAI contract and select one mode by task risk: MINIMAL only for pure acknowledgements, NATIVE for quick or read-only work, ALGORITHM LIGHT for bounded multi-step implementation, and full ALGORITHM only for high-risk work. ${algorithmLightContract} Full ALGORITHM must fully read ${ALGORITHM_PATH} before any other tool. ${displayGuidance}\n${portableRootMap}`;

    const finalLiteralContract = isAdvisorTurn
          ? `OMP ADVISOR TRANSPORT CONTRACT:\n- Advisor is an internal review-only role, not a PAI main agent.\n- Advisor must never enter ALGORITHM or ALGORITHM LIGHT, or read ${ALGORITHM_PATH}.\n- Advisor emits no PRD ceremony or user-facing answer.\n- Advisor may inspect with read, grep, and glob, and uses advise only for a genuine defect.`
          : `PAI RUNTIME TRANSPORT CONTRACT:\n- Mode selection follows the active PAI contract and task risk.\n- Mode headers and TASK summaries are optional presentation and never gate tools.\n- ALGORITHM LIGHT follows scope → execute → verify and must never read ${ALGORITHM_PATH}.\n- Full ALGORITHM must fully read ${ALGORITHM_PATH} before any other tool.\n- Preserve the active PAI template's CONTENT, CHANGE, VERIFY, SUMMARY, and PAI fields when used.`;
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
    const activeProviderInstruction = providerTailInstruction;
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
            activeProviderInstruction,
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
            activeProviderInstruction,
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

  

  pi.on("message_start", (event) => {
      if (event.message?.role !== "assistant") return;
      visibleText = "";
    });

  pi.on("message_update", (event, ctx) => {
    const text = assistantText(event.message);
    if (text) visibleText = text;
    if (
      isAdvisorTurn
      && text.split(/\r?\n/).some((line) => {
        const header = line.trimEnd();
        return header === ALGORITHM_HEADER || header === ALGORITHM_LIGHT_HEADER;
      })
    ) {
      advisorAlgorithmViolation = true;
      ctx?.abort();
    }
  });

  pi.on("tool_call", (event) => {
    const input = event.input as ReadToolInput | undefined;
    const algorithmReadInput = event.toolName === "read"
      ? readInputForPath(input, ALGORITHM_PATH)
      : null;
    if (isAdvisorTurn) {
      if (advisorAlgorithmViolation) {
        return {
          block: true,
          reason: "OMP Advisor gate: Advisor must never emit an ALGORITHM header.",
        };
      }
      if (algorithmReadInput) {
        return {
          block: true,
          reason: `OMP Advisor gate: Advisor must never enter ALGORITHM or read ${ALGORITHM_PATH}.`,
        };
      }
      if (advisorTools[event.toolName] === true) return;
      return {
        block: true,
        reason: "OMP Advisor gate: Advisor is review-only; use read, grep, glob, or advise.",
      };
    }
    const lines = visibleText.split(/\r?\n/);
    if (!approvedHeader) {
      const presentedHeader = (lines[0] ?? "").trimEnd();
      if (requiresAlgorithm) {
        approvedHeader = ALGORITHM_HEADER;
      } else if (requiresAlgorithmLight) {
        approvedHeader = ALGORITHM_LIGHT_HEADER;
      } else if (requiresNative) {
        approvedHeader = NATIVE_HEADER;
      } else if (validPrimaryHeaders[presentedHeader] === true) {
        approvedHeader = presentedHeader;
      } else {
        approvedHeader = NATIVE_HEADER;
      }
    }

    if (approvedHeader === MINIMAL_HEADER) {
      approvedHeader = NATIVE_HEADER;
    }

    if (
      approvedHeader === ALGORITHM_LIGHT_HEADER
      && algorithmReadInput
    ) {
      return {
        block: true,
        reason: `PAI runtime gate: ALGORITHM LIGHT must never read the full Algorithm file ${ALGORITHM_PATH}. Continue with the inline scope → execute → verify contract.`,
      };
    }

    if (approvedHeader === ALGORITHM_HEADER && !algorithmReadApproved) {
      if (pendingAlgorithmReadToolCallId) {
        return {
          block: true,
          reason: `PAI runtime gate: wait for the required Algorithm read result before calling another tool.`,
        };
      }

      const isAlgorithmRead = algorithmReadInput !== null;
      if (!isAlgorithmRead) {
        return {
          block: true,
          reason: `PAI runtime gate: the next ALGORITHM tool call must be read with exact path ${ALGORITHM_PATH}. Retry that read before any other tool.`,
        };
      }

      if (!algorithmReadStarted && algorithmReadInput.selector !== undefined) {
        return {
          block: true,
          reason: `PAI runtime gate: the initial Algorithm read must use exact path ${ALGORITHM_PATH} without a selector.`,
        };
      }

      if (algorithmReadStarted) {
        const continuation = selectorRange(algorithmReadInput.selector);
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
            reason: `PAI runtime gate: continue the truncated Algorithm read with read path ${ALGORITHM_PATH}:${expectedSelector}. A shorter bounded range cannot complete Algorithm.`,
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
