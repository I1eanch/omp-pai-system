# Pipelines

Pipeline — последовательность локальных Actions с checkpoint после каждого успешного шага.

## Definition

`${dataRoot}/PAI/PIPELINES/<pipelineId>.json`:

```json
{
  "schemaVersion": 1,
  "id": "publish",
  "steps": [
    {
      "id": "normalize",
      "action": "normalize-title",
      "input": "$pipeline.input"
    },
    {
      "id": "format",
      "action": "format-markdown",
      "input": {
        "title": "$steps.normalize.output.title"
      }
    }
  ]
}
```

Формальная schema: `${pluginRoot}/contracts/pipeline.schema.json`.

## References

- `$pipeline.input` / `$pipeline.input.<property.path>`;
- `$steps.<previous-step>.output` / `$steps.<previous-step>.output.<property.path>`.

Ссылки можно помещать в nested objects/arrays. Строка, начинающаяся с `$`, считается ссылкой. Forward reference и отсутствующее property блокируют запуск.

## Resume guarantees

Checkpoint: `${dataRoot}/MEMORY/STATE/pipelines/<pipelineId>.json`.

Runtime сохраняет для каждого completed step Action SHA-256, output и output SHA-256. Явный resume разрешён только при совпадении:

- pipeline definition SHA-256;
- initial input SHA-256;
- checksum каждого completed output;
- checksum каждого уже выполненного Action.
- Action id каждого checkpoint entry совпадает с Action текущего step, а completed entries образуют строгий prefix pipeline.

Pipeline прекращается на первой ошибке и возвращает `failedStep`; скрытого retry нет. OMP cancellation завершает активный Action, сохраняет failed checkpoint и пробрасывается вызывающему runtime.
