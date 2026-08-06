# FAQ

## Где хранится локальное состояние?

По умолчанию — `~/.omp/agent/pai`. Явный root задаётся через `OMP_PAI_DATA_DIR`; profile root — через `PI_CODING_AGENT_DIR`.

## Копирует ли package личные TELOS/MEMORY?

Нет. Package содержит только обезличенные starter templates. Реальные записи создаются внутри `dataRoot` и попадают в release только при ошибочном изменении allowlist, которую блокирует privacy audit.

## Нужен ли legacy Algorithm-файл?

Нет. Runtime использует компактный mode contract, нативный OMP thinking и skill `pai-deep-work`. Видимый preamble, строка `TASK` и чтение монолитного Algorithm удалены.

## Как выбирается режим?

Pure classifier `routePaiPrompt()` возвращает `minimal`, `native` или `algorithm` вместе с reason/confidence/needsTools. `before_agent_start` переводит mode в OMP thinking level: `minimal`, `low`, `high`.

## Почему контекст не загрузился автоматически целиком?

Это намеренно. `pai_context` делает bounded retrieval и возвращает provenance. Полное чтение TELOS/MEMORY увеличивает prompt overhead, privacy exposure и риск нерелевантного контекста.

## Когда создавать PRD?

Для persistent многошаговой работы, которую нужно продолжать между turns/sessions. Для короткой задачи используйте нативные OMP todo/goal.

## Почему MEMORY fact/preferences требуют confirmation?

Чтобы inference модели не становился durable personal fact. `fact` и `preference` требуют `userConfirmed: true`, source и confidence.

## Почему Action заблокирован?

Проверьте:

1. id и каталог `PAI/ACTIONS/<id>`;
2. `action.json` по `contracts/action.schema.json`;
3. basename `.js`/`.ts` entry без symlink;
4. input/output JSON Schema;
5. timeout, exit code и лимит stdout/stderr `1 MiB`;
6. OMP approval tier `exec`.

OMP cancellation передаётся в Action как `AbortSignal`: runtime завершает process tree и возвращает `Action aborted`. Для Flow/Pipeline текущий failure checkpoint сохраняется до проброса cancellation.

## Как продолжить Flow после pause/failure?

Вызовите `pai_flow_run` с `resume: true`. Definition SHA-256 и SHA-256 каждого уже выполненного Action должны совпадать с checkpoint. Не редактируйте checkpoint вручную.

## Как продолжить Pipeline?

Вызовите `pai_pipeline_run` с тем же input и `resume: true`. Runtime повторно проверит definition/input/checksums и пропустит только подтверждённые completed steps.

## Почему resume отклонён после изменения Action?

Это защита от смешивания результатов разных версий кода. Начните pipeline заново или восстановите исходное definition/action; shim/fallback отсутствует намеренно.

## Можно ли импортировать поверх существующего state?

Нет. Import сохраняет no-overwrite invariant и сообщает conflict до записи. Импортируйте в пустой profile или вручную разрешите конфликт вне importer.

## Почему `/pai-doctor` сообщает unsafe permissions?

Любой group/world bit в `dataRoot` считается unsafe. Используйте `0700` для directories и `0600` для files, затем повторите doctor.

## Какие проверки обязательны перед release?

```bash
bun run typecheck
bun test
bun run build:staging
bun run audit:privacy
bun run release:pack
bun run test:lifecycle
bun run smoke:install
```
