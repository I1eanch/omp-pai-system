# Best practices

## Установка и обновление

1. Запускайте `bun run typecheck` и `bun test` до сборки.
2. Собирайте staging только через `bun run build:staging`.
3. Проверяйте staging через `bun run audit:privacy`.
4. Устанавливайте artifact, затем запускайте `omp plugin doctor omp-pai-system --json` и `/pai-doctor`.
5. Перед обновлением экспортируйте private state в локальный путь вне `dataRoot`.

`/pai-init` идемпотентен: создаёт только отсутствующие starter files, не меняет существующие пользовательские файлы и создаёт новые paths с mode `0700`/`0600`.

## Runtime и skills

- Не добавляйте visible mode headers, `TASK` ritual, TTS или обязательное чтение монолитного prompt-файла.
- Mode routing должен оставаться deterministic и provider-independent.
- Thinking изменяется через `pi.setThinkingLevel()`, а не через raw provider payload.
- Сложная методика вызывается как OMP-native skill только когда нужна.
- Bounded retrieval предпочтительнее полного чтения TELOS/MEMORY.
- Короткая задача использует OMP todo/goal; PRD нужен только persistent workflow.

## Private state

- Храните runtime state в `OMP_PAI_DATA_DIR` или стандартном `~/.omp/agent/pai`.
- Не добавляйте реальные TELOS/MEMORY records в `templates/`.
- Не помещайте credentials, API keys или session traces в package или automation definitions.
- Считайте failure `/pai-doctor` по permissions/security blocking issue.
- Экспортируйте state только в локальный `.tar.gz` вне `dataRoot` и сохраняйте SHA-256.
- Импортируйте неполностью доверенный архив сначала в отдельный пустой профиль.

Importer лимитирует фактически скопированные compressed bytes и весь expanded tar stream, затем проверяет entry count, per-file/total payload, manifest size, canonical path containment, duplicate paths, file types, SHA-256 и destination conflicts. Запись начинается только после полной валидации. Import использует owner-only root temporaries, exclusive hard-link commit и inode-bound rollback, поэтому concurrent replacement не удаляется как собственный файл importer.

Все runtime state operations требуют symlink-free path components, владельца текущего процесса и mode `0700` для directories. Export дополнительно отклоняет hardlinked source files. Archive path канонизируется до проверки «вне `dataRoot`».

## Durable memory

- `fact` и `preference` записываются только при `userConfirmed: true`.
- Каждая запись обязана содержать `source` и `confidence`.
- Не превращайте transient chat content в durable memory автоматически.
- Retrieval result должен сохранять source path/record id.
- После ручного изменения JSONL выполните `/pai-memory-reindex`.

## Actions, Flows, Pipelines

- Action entry должен быть локальным basename `.js`/`.ts`, не symlink.
- Manifest содержит только schema/metadata, не credentials или host paths.
- Input/output schemas должны запрещать лишние поля там, где shape известен.
- Action обязан иметь bounded timeout; `exec` approval не понижается до `write/read`.
- Flow не имеет неявных error transitions или retries.
- Pipeline references указывают только на previous steps.
- Resume всегда явный. Definition, input, completed output и Action checksums должны совпасть.
- Definition change требует нового запуска, а не ручного исправления checkpoint.

## Release privacy

Release artifact намеренно не содержит `scripts/`, `tests/` и `tsconfig.json`.

Release surface задают:

- `privacy/allowlist.json` — разрешённые files;
- `privacy/exclusions.json` — запрещённые patterns;
- `privacy/provenance-manifest.json` — source/license/distributability;
- `scripts/release-lib.ts` — обязательные package files.

Проверка:

```bash
bun run build:staging
bun run audit:privacy
bun run release:pack
bun run test:lifecycle
bun run smoke:install
```

Не ослабляйте privacy patterns ради прохождения проверки. Исправляйте источник утечки или удаляйте файл из release surface.
