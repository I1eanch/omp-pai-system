# Context Routing

Контекст загружается по необходимости, а не целиком. Все пути разрешаются относительно корней из plugin config.

| Тема | Источник |
|---|---|
| PAI modes, runtime gate, Algorithm | `${pluginRoot}/templates/PAI/README.md` и активный `${algorithmPath}` |
| Формат рабочих спецификаций | `${pluginRoot}/templates/PAI/PRDFORMAT.md` |
| Личные цели и решения | `${telosRoot}` |
| Текущее и долговременное состояние | `${memoryRoot}` |
| Actions | `${dataRoot}/PAI/ACTIONS` |
| Flows | `${dataRoot}/PAI/FLOWS` |
| Pipelines | `${dataRoot}/PAI/PIPELINES` |
| Project-specific инструкции | файлы активного проекта |

## Правила

1. Сначала читать индекс или schema нужного раздела, затем только релевантные записи.
2. Immutable package templates не используются для записи runtime state.
3. Персональный контекст не копируется в package directory, logs или release staging.
4. Project context имеет приоритет над общими defaults только внутри активного проекта.
5. Отсутствующий optional-контекст не заменяется выдуманными значениями.
