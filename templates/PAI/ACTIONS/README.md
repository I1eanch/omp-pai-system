# Actions

Action — локальная атомарная операция с JSON input и JSON output. Пользовательские определения хранятся в `${dataRoot}/PAI/ACTIONS/{actionId}/`.

## Manifest

`action.json`:

```json
{
  "schemaVersion": 1,
  "id": "normalize-title",
  "entry": "action.ts",
  "description": "Нормализует заголовок",
  "input": { "type": "object", "required": ["title"] },
  "output": { "type": "object", "required": ["title"] }
}
```

## Execution contract

- `entry` обязан оставаться внутри каталога action; traversal и symlink escape запрещены.
- Input проверяется до запуска, output — перед передачей следующему шагу.
- Action не получает `${telosRoot}` или `${memoryRoot}` без явного capability grant.
- Ошибка возвращается как typed failure и не заменяется пустым успешным результатом.
- Один action выполняет одну ответственность; orchestration принадлежит pipeline.
- Секреты передаются через локальный credential provider, а не сохраняются в manifest.
