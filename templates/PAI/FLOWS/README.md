# Flows

Flow описывает выбор следующего состояния и допускает ветвление, паузу или возврат. Пользовательские flow definitions хранятся в `${dataRoot}/PAI/FLOWS/`.

## Definition

```json
{
  "schemaVersion": 1,
  "id": "inbox-review",
  "initial": "classify",
  "states": {
    "classify": { "action": "classify-item", "onSuccess": "store" },
    "store": { "action": "store-item", "terminal": true }
  }
}
```

## Invariants

- `initial` и все переходы ссылаются на существующие states.
- Terminal state не имеет исходящих переходов.
- Неизвестный action блокирует запуск до изменения состояния.
- Runtime state хранится отдельно в `${memoryRoot}/STATE/flows/{flowId}.json`.
- Повторный запуск использует сохранённый state только при совпадении schema version и definition checksum.
- Ошибка action сохраняет исходный input и state pointer; автоматический переход после ошибки запрещён.
- Flow definition не содержит credentials, персональные факты или абсолютные пути.
