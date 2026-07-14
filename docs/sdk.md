# Extension SDK

`omp-pai-system` — OMP extension package, а не HTTP service. Public extension entrypoint находится в `src/index.ts`.

## Default extension

OMP обнаруживает extension через `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

Default export уже сконфигурирован относительно установленного package root:

```ts
export default createPaiPlugin({ pluginRoot });
```

Для обычной установки программная конфигурация не нужна.

## `createPaiPlugin`

```ts
type CreatePaiPluginInput = {
  pluginRoot: string;
  env?: Record<string, string | undefined>;
};

function createPaiPlugin(
  input: CreatePaiPluginInput,
): (pi: ExtensionAPI) => void;
```

Пример source-level integration внутри доверенного OMP package:

```ts
import { createPaiPlugin } from "./src/index.ts";

export default createPaiPlugin({
  pluginRoot: "/opt/omp/plugins/omp-pai-system",
  env: {
    HOME: "/absolute/profile-home",
    OMP_PAI_DATA_DIR: "/absolute/pai-data",
  },
});
```

`pluginRoot` нормализуется через `resolve()`. `env` полезен для изолированных tests; в production по умолчанию используется `process.env`.

## Configuration result

Внутренний resolver формирует:

```ts
type PaiConfig = {
  pluginRoot: string;
  dataRoot: string;
  algorithmPath: string;
  algorithmVersion: string;
  algorithmSource: "bundled-mit-v3.5.0" | "local-override";
};
```

Приоритет `dataRoot`:

1. `OMP_PAI_DATA_DIR`;
2. `${PI_CODING_AGENT_DIR}/pai`;
3. `${HOME}/.omp/agent/pai` или `${USERPROFILE}/.omp/agent/pai`.

Algorithm override обязан быть абсолютным local filesystem path. Версия обязана быть SemVer и берётся из `OMP_PAI_ALGORITHM_VERSION` либо имени файла.

## Зарегистрированные команды

`createPaiPlugin` регистрирует четыре OMP slash commands:

| Command | Args | Side effects |
|---|---|---|
| `pai-init` | нет | Создаёт отсутствующие starter files |
| `pai-doctor` | нет | Нет; read-only diagnostics |
| `pai-private-export` | local archive path | Создаёт проверяемый archive |
| `pai-private-import` | local archive path | Импортирует только новые files после полной validation |

Command handlers сообщают краткий результат через `context.ui.notify`.

## Runtime hook contract

Extension подписывается на:

- `before_agent_start` — выбирает режим и chain-ит `string[]` system prompt без потери ранее добавленных блоков;
- `before_provider_request` — для official Google и Gemini CLI payload shapes фиксирует deterministic preamble и минимально допустимый thinking mode модели;
- `context` — добавляет скрытое continuation state без повторного header;
- `message_start` / `message_update` — отслеживает видимый assistant text;
- `tool_call` — блокирует нарушение mode/Algorithm protocol;
- `tool_result` — подтверждает полное чтение Algorithm с учётом truncation metadata.

Hooks возвращают только documented OMP result shapes: `string[]` replacement system prompt, raw provider payload, replacement messages либо `{ block: true, reason }` для запрещённого tool call.

## Совместимость

- Runtime: Bun `>=1.3.0`.
- Peer dependency: `@oh-my-pi/pi-coding-agent` `^16.4.8`; minimum `16.4.8` и current `16.5.1` проверены strict TypeScript gate, runtime suite и реальным `ExtensionRunner`.
- HTTP endpoints отсутствуют, поэтому OpenAPI contract неприменим.
- Отдельный compiled JavaScript SDK пока не публикуется; OMP загружает TypeScript entrypoint напрямую.
