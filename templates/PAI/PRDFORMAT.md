# PRD Format

Рабочая спецификация хранится в `${memoryRoot}/WORK/{YYYYMMDD-HHMMSS}_{slug}/PRD.md` и является единственным источником состояния Algorithm-сессии.

## Frontmatter

```yaml
task: Краткое описание задачи
slug: YYYYMMDD-HHMMSS_kebab-task
effort: standard
phase: observe
progress: 0/8
mode: interactive
started: 2026-01-01T10:00:00Z
updated: 2026-01-01T10:00:00Z
```

Обязательные поля: `task`, `slug`, `effort`, `phase`, `progress`, `mode`, `started`, `updated`. Поле `iteration` добавляется только при повторной работе над завершённой задачей.

## Разделы

- `## Context` — факты, ограничения и принятый scope.
- `## Criteria` — атомарные проверяемые критерии вида `- [ ] ISC-N: ...`.
- `## Decisions` — решения с причинами и датами.
- `## Verification` — команды, артефакты и наблюдённые результаты.

Пустые разделы не создаются. Критерий атомарен: он проверяется одним наблюдаемым условием и может завершиться независимо от соседних критериев. `progress` всегда равен числу отмеченных критериев и их общему количеству.
