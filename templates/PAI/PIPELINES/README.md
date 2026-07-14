# Pipelines

Pipeline — детерминированная последовательность actions. Пользовательские definitions хранятся в `${dataRoot}/PAI/PIPELINES/` и не входят в release artifact.

## Definition

```yaml
schemaVersion: 1
id: summarize-and-format
steps:
  - id: summarize
    action: summarize
    input: $pipeline.input
  - id: format
    action: format-markdown
    input: $steps.summarize.output
```

## Invariants

- `id` шага уникален, порядок выполнения совпадает с порядком в definition.
- Ссылка может указывать только на pipeline input или завершённый предыдущий шаг.
- Каждый step проходит input/output validation своего action manifest.
- Pipeline прекращается при первой ошибке и возвращает failed step без скрытого retry.
- Resume разрешён только при совпадении definition checksum и checksums завершённых outputs.
- Записи выполнения хранятся в `${memoryRoot}/STATE/pipelines/`; package templates остаются immutable.
- Definition не содержит credentials, персональные значения, host paths или inline executable code.
