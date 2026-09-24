# FAQ

## Где хранится локальное состояние?

По умолчанию — `~/.omp/agent/pai`. Корень можно явно задать через `OMP_PAI_DATA_DIR`.

## Перезапишет ли `/pai-init` мои цели или память?

Нет. Команда создаёт только отсутствующие starter files. Существующие файлы учитываются как `skipped` и сохраняются.

## Почему обычный запрос попал в полный ALGORITHM?

По действующему контракту обычные исследования, объяснения и read-only проверки должны оставаться в `NATIVE`, а ограниченная умеренная многошаговая работа — в `ALGORITHM LIGHT`. Полный `ALGORITHM` нужен только для high-risk implementation/debugging: production incidents, data loss, migrations, security/auth, payments, destructive/irreversible или широких cross-system изменений. Если риск неоднозначен, выбирается более лёгкий соседний режим.

## Почему tool call заблокирован сразу после mode header?

Проверьте три условия:

1. Header видим и дословно совпадает с одним активным режимом.
2. Для `NATIVE`, `ALGORITHM LIGHT` и `ALGORITHM` следующая строка начинается с `🗒️ TASK:` и содержит ровно восемь слов после prefix.
3. `ALGORITHM LIGHT` не может читать Algorithm-файл; для полного `ALGORITHM` первый tool — `read` configured Algorithm path без selector.

Hidden reasoning не удовлетворяет этим условиям.

## Можно ли использовать Algorithm `v3.7.0`?

Да, если файл уже существует локально. Задайте абсолютный `OMP_PAI_ALGORITHM_PATH`. Версия выводится из имени `v3.7.0.md`; иначе задайте `OMP_PAI_ALGORITHM_VERSION=3.7.0`.

## Почему plugin не скачивает Algorithm автоматически?

Чтобы не смешивать runtime с недоказанным provenance/licensing и не отправлять данные во внешнюю сеть. Bundled `v3.5.0` имеет зафиксированный checksum и MIT notice; любой другой файл — явный local override пользователя.

## Можно ли экспортировать private state внутрь `OMP_PAI_DATA_DIR`?

Нет. Это создало бы рекурсивный архив и нарушило границу private state. Выберите соседний backup-каталог.

## Что происходит при конфликте импорта?

Импорт завершается ошибкой до commit. Существующий файл не перезаписывается. Архив также отклоняется при checksum/size mismatch, path traversal, symlink или неизвестной manifest schema.

## Почему в репозитории нет OpenAPI specification?

Plugin не предоставляет HTTP API. Его interface — OMP extension hooks и slash commands. Пустая OpenAPI spec создала бы ложный публичный контракт.

## Какие проверки обязательны перед release?
Запускайте их из source checkout. Установленный artifact намеренно не содержит maintainer-only `scripts/`, `tests/` и `tsconfig.json`.


```bash
bun run typecheck
bun test
bun run build:staging
bun run audit:privacy
bun run release:pack
bun run test:lifecycle
bun run smoke:install
```

Проверки покрывают отдельные контракты: типы, поведение, allowlist, privacy/provenance, воспроизводимый архив, lifecycle functions и реальный OMP install/upgrade/uninstall.
