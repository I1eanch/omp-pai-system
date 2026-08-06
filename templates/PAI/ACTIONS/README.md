# Actions

Action — локальная атомарная операция с JSON input/output.

## Layout

```text
${dataRoot}/PAI/ACTIONS/<actionId>/
├── action.json
└── action.ts
```

`actionId`: `^[a-z0-9][a-z0-9-]{0,63}$`. Entry — basename одного `.js`/`.ts` файла; абсолютные пути, `..`, backslash и symlink запрещены.

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "normalize-title",
  "entry": "action.ts",
  "description": "Normalize a title",
  "input": {
    "type": "object",
    "required": ["title"],
    "additionalProperties": false,
    "properties": { "title": { "type": "string", "minLength": 1 } }
  },
  "output": {
    "type": "object",
    "required": ["title"],
    "additionalProperties": false,
    "properties": { "title": { "type": "string" } }
  },
  "timeoutMs": 5000
}
```

Формальная schema: `${pluginRoot}/contracts/action.schema.json`.

Runtime поддерживает fail-closed subset JSON Schema: `type`, `const`, `enum`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `minItems`, `maxItems`, `items`, `properties`, `required`, `additionalProperties`. Неизвестные keywords и malformed keyword values отклоняются при загрузке manifest.

## Process contract

- Action читает ровно один JSON value из stdin.
- Успех: exit code `0` и ровно один JSON result в stdout.
- Диагностика пишется в stderr.
- Runtime проверяет input до запуска и output до передачи вызывающему.
- Timeout: `1..300000 ms`, после deadline runtime принудительно завершает всю process group; stdout/stderr: максимум `1 MiB` каждый. OMP cancellation через `AbortSignal` использует тот же process-tree cleanup и возвращает `Action aborted`.
- Runtime передаёт только `PATH` и `OMP_PAI_ACTION_ID`; manifest не содержит credentials.
- Approval tier OMP tool `pai_action_run` — `exec`.
- SHA-256 manifest+entry входит в report и checkpoint вызывающих Flow/Pipeline.
