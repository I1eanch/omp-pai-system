# Changelog

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии следуют [Semantic Versioning](https://semver.org/lang/ru/).

## Устарело — 2026-09-25

- Проект больше не используется в харнесе OMP: обвязка PAI снята, её заменил Algorithm 4.1-omp в [I1eanch/skills](https://github.com/I1eanch/skills/tree/main/algorithm).
- Состояние runtime, которое работало в OMP до перехода, сохранено в ветке `archive/final-runtime-20260924`.
- Изменения из раздела Unreleased ниже в харнес не устанавливались.

## Unreleased

### Added

- OMP-native TELOS, MEMORY и PRD runtime: validation, indexed retrieval, safe mutation и registry synchronization.
- Declarative Actions, resumable Flows и checksum-bound Pipelines с native tools `pai_action_run`, `pai_flow_run` и `pai_pipeline_run`.
- Unified runtime contract, persisted route metadata и discoverable `pai-deep-work` skill.
- Machine-readable JSON Schemas для Action, Flow, Pipeline и MEMORY record contracts.
- Сквозная OMP cancellation для Action, Flow и Pipeline через `AbortSignal` с process-tree cleanup.

### Changed

- Routing переведён на native OMP hooks и model thinking levels; видимые mode headers, `TASK:` ritual, обязательное полное чтение Algorithm и TTS удалены.
- `pai-doctor` теперь проверяет package metadata, skill/templates, ownership, schemas, automation definitions, state permissions и private paths.
- Документация и starter contracts описывают portable roots, context routing, approvals, resumability и local-only private state.
- Public runtime APIs документированы JSDoc; SDK и routing docs синхронизированы с фактическим subagent `NATIVE` default.

### Security

- Private export использует snapshot regular-file handles и atomic no-overwrite commit.
- Private import стал bounded streaming pipeline с fail-closed archive validation, checksums, no-overwrite linking и rollback без удаления конкурентных записей.
- Persisted MEMORY records теперь fail-closed отклоняют unknown fields, oversized text и неподтверждённые personal facts/preferences.
- Release allowlist и provenance включают только distributable native skill и machine-readable contracts.

### Verification

- Source test coverage: 100% functions и 100% lines.
- Полный typecheck/test/release gate и реальный OMP install/list/doctor/upgrade/uninstall lifecycle проходят.

## 0.1.0 - 2026-07-14

### Added

- Production `typecheck` gate для `src`, release scripts и test harnesses.
- Корневая документация, best practices, FAQ и Extension SDK reference.
- Fail-fast validation для missing/directory Algorithm override; symlink на regular file поддерживается.
- Portable OMP plugin с командами `pai-init`, `pai-doctor`, `pai-private-export` и `pai-private-import`.
- Runtime enforcement режимов `MINIMAL`, `NATIVE` и `ALGORITHM`.
- Bundled path-portable Algorithm `v3.5.0` и явный local override.
- Sanitized starter templates для PAI, TELOS и MEMORY.
- Checksum-verified private state export/import без перезаписи существующих файлов.
- Allowlisted staging, privacy/provenance audit, release manifest и isolated lifecycle smoke.
- Role-profile routing holdouts для `actualModel`, `piSubagentModel`, `piSlowModel` и `piPlanModel`.
- Official `@oh-my-pi/pi-coding-agent` peer contract, `string[]` prompt chaining и integration test через реальный `ExtensionRunner`.
- Поддержка raw Google Generative AI и Gemini CLI payload shapes с model-valid thinking limits.
- Release manifest получает package name/version из `package.json`, без отдельного version hardcode.

### Security

- Закрыты symlink traversal, archive path traversal, destination overwrite и host-path leakage.
- Private TELOS/MEMORY state исключён из distributable release.

