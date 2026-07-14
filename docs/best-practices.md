# Best practices

## Установка и обновление

1. Запускайте `bun run typecheck` и `bun test` до сборки.
2. Собирайте staging только через `bun run build:staging`; не копируйте рабочее дерево вручную.
3. Проверяйте staging через `bun run audit:privacy`.
4. Устанавливайте `dist/staging`, затем запускайте `omp plugin doctor omp-pai-system --json` и `/pai-doctor`.
5. Перед обновлением экспортируйте private state в локальный путь вне `dataRoot`.

`/pai-init` идемпотентен: создаёт только отсутствующие starter files и сохраняет существующие данные.

## Algorithm

Bundled `templates/Algorithm/v3.5.0.md` — clean-install default. Для другой версии задайте абсолютный локальный путь:

```bash
export OMP_PAI_ALGORITHM_PATH="/absolute/path/Algorithm/v3.7.0.md"
```

Если имя файла не содержит SemVer, дополнительно задайте:

```bash
export OMP_PAI_ALGORITHM_VERSION="3.7.0"
```

Не указывайте URL или относительный путь. Runtime намеренно не загружает Algorithm из сети и не ищет legacy host paths.

## Private state

- Храните runtime state в `OMP_PAI_DATA_DIR` или стандартном `~/.omp/agent/pai`.
- Не добавляйте реальные TELOS/MEMORY records в `templates/`.
- Не помещайте credentials, API keys или session traces в release-allowlisted пути.
- Экспортируйте private state только в локальный `.tar.gz` вне `dataRoot`.
- Сохраняйте SHA-256 из отчёта экспорта рядом с резервной копией.
- Импортируйте сначала в отдельный пустой профиль, если источник архива не полностью доверен.

Importer сначала проверяет manifest, размеры, SHA-256, path traversal, symlinks и конфликты. При ошибке целевой state не должен частично измениться.

## Runtime gate

- Не дублируйте PAI mode header или фиксированную строку `TASK` после первого tool result.
- Для сложного запроса первый tool call после ALGORITHM preamble — полное чтение configured Algorithm path.
- Если `read` сообщает truncation, продолжайте с первого непрочитанного номера строки до конца.
- Не подменяйте сложный запрос несколькими атомарными NATIVE turns ради обхода Algorithm.
- Subagent работает в NATIVE, если main agent явно не передал `<pai-mode>ALGORITHM</pai-mode>`.

## Release privacy
Следующие maintainer checks запускаются из source checkout; release artifact намеренно не содержит `scripts/`, `tests/` и `tsconfig.json`.


Release surface задают три независимых контракта:

- `privacy/allowlist.json` — что разрешено копировать;
- `privacy/exclusions.json` — что запрещено даже при широком include;
- `privacy/provenance-manifest.json` — источник, лицензия и distributability каждого staged файла.

Новый release-файл должен присутствовать во всех применимых контрактах. Проверка:

```bash
bun run build:staging
bun run audit:privacy
bun run release:pack
bun run test:lifecycle
bun run smoke:install
```

Не ослабляйте privacy patterns ради прохождения теста. Исправляйте источник утечки или убирайте файл из release surface.
