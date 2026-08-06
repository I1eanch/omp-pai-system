export type PaiMode = "minimal" | "native" | "algorithm";

export type PaiRouteReason =
  | "explicit-algorithm"
  | "subagent-default"
  | "minimal-message"
  | "complex-task"
  | "short-atomic-task"
  | "safe-fallback";

export type PaiRoute = {
  mode: PaiMode;
  reason: PaiRouteReason;
};

export const PAI_RUNTIME_CONTRACT = {
  schemaVersion: 2,
  modes: {
    minimal: {
      toolsExpected: false,
      thinking: "minimal",
    },
    native: {
      toolsExpected: true,
      thinking: "low",
    },
    algorithm: {
      toolsExpected: true,
      thinking: "high",
      skill: "pai-deep-work",
    },
  },
  output: {
    visibleProtocol: false,
    headersRequired: false,
    taskLineRequired: false,
  },
} as const;

const EXPLICIT_ALGORITHM_MARKER = "<pai-mode>ALGORITHM</pai-mode>";
const MINIMAL_PATTERN =
  /^(?:привет|здравствуйте|добр(?:ый|ое) (?:день|вечер|утро)|hello|hi|спасибо|благодарю|ок|хорошо|понял|понятно|принято|да|нет|верно|точно|отлично|готово|сделано|согласен|подтверждаю|yes|no|correct|great|done|[0-9]+(?:\s*(?:\/|из)\s*10)?|(?:ставлю|оценка)\s+[0-9]+(?:\s*(?:\/|из)\s*10)?)[!.]?$/iu;
const NATIVE_ACTION_PATTERN =
  /^(?:исправ|поправ|перевед|переимен|замен|удал|добав|покаж|посчит|объясн|проверь|найд|открой|прочитай|напиши|fix|translate|rename|replace|delete|add|show|count|explain|check|find|open|read|write)\p{L}*/iu;
const NATIVE_QUESTION_PATTERN =
  /^(?:ты\s+\p{L}+|сколько|котор(?:ый|ая|ое)|какой|какая|какое|что (?:значит|такое)|кто (?:такой|такая)|где|когда)(?=$|[\s?!.,:;])/iu;
const COMPLEX_PATTERNS = [
  /troubleshoot|диагност|устран.{0,24}(?:сбой|ошиб|проблем)|исправ.{0,16}(?:сбой|баг|проблем)|разбер.{0,24}проблем/iu,
  /debug|отлад/iu,
  /\bbuild\b|собер.{0,24}(?:проект|систем|прилож|модул|компонент)|реализ/iu,
  /investigat|исслед|расслед|найд.{0,16}причин/iu,
  /\bdesign|дизайн|спроектир/iu,
  /refactor|рефактор/iu,
  /\bplan(?:ning)?\b|планир|состав.{0,16}план|разработ.{0,16}план/iu,
  /complex|difficult|сложн/iu,
  /многошаг|multi[- ]?step|multiple.{0,24}(?:files?|modules?|components?|steps?)|нескольк.{0,40}(?:файл|модул|компонент|шаг)|связанн.{0,20}файл/iu,
];

/** Classifies a prompt deterministically; ambiguous main-agent work fails safe to ALGORITHM. */
export function routePaiPrompt(prompt: string, isSubagent: boolean): PaiRoute {
  if (prompt.includes(EXPLICIT_ALGORITHM_MARKER)) {
    return { mode: "algorithm", reason: "explicit-algorithm" };
  }
  if (isSubagent) {
    return { mode: "native", reason: "subagent-default" };
  }

  const text = prompt.trim();
  if (MINIMAL_PATTERN.test(text)) {
    return { mode: "minimal", reason: "minimal-message" };
  }
  if (COMPLEX_PATTERNS.some((pattern) => pattern.test(text))) {
    return { mode: "algorithm", reason: "complex-task" };
  }

  const wordCount = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const hasMultipleActions = /[;\n]|\s(?:и|затем|потом|после этого|and|then)\s/iu.test(text);
  if (
    wordCount > 0
    && wordCount <= 16
    && !hasMultipleActions
    && (NATIVE_ACTION_PATTERN.test(text) || NATIVE_QUESTION_PATTERN.test(text))
  ) {
    return { mode: "native", reason: "short-atomic-task" };
  }
  return { mode: "algorithm", reason: "safe-fallback" };
}
