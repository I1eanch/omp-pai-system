# Flows

Flow — детерминированная state machine, где каждое состояние вызывает один Action.

## Definition

`${dataRoot}/PAI/FLOWS/<flowId>.json`:

```json
{
  "schemaVersion": 1,
  "id": "review",
  "initial": "classify",
  "states": {
    "classify": {
      "action": "classify-item",
      "onSuccess": "confirm",
      "pause": true
    },
    "confirm": {
      "action": "confirm-item",
      "onSuccess": "store"
    },
    "store": {
      "action": "store-item",
      "terminal": true
    }
  }
}
```

Формальная schema: `${pluginRoot}/contracts/flow.schema.json`.

## Invariants

- `initial` и каждый `onSuccess` указывают на существующий state.
- Non-terminal state обязан иметь `onSuccess`.
- Terminal state не имеет `onSuccess` и `pause`.
- `pause: true` сохраняет output как input следующего state и возвращает `paused`.
- Ошибка Action сохраняет `failed` на текущем state; автоматического перехода/retry нет.
- Checkpoint: `${dataRoot}/MEMORY/STATE/flows/<flowId>.json`.
- Resume выполняется только с `resume: true`, совпадающим SHA-256 definition и неизменным SHA-256 каждого Action, уже записанного в checkpoint.
- `maxSteps` ограничен `1..10000`; по умолчанию `100`.
- OMP cancellation завершает активный Action, сохраняет `failed` checkpoint и пробрасывается вызывающему runtime.
