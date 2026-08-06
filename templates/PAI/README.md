# Portable PAI Core

Этот каталог — immutable package contract. Пользовательское состояние хранится только в `${dataRoot}`.

## Roots

- `${pluginRoot}` — установленный package, read-only.
- `${dataRoot}` — локальные TELOS, MEMORY, PRD и automation state.
- `${pluginRoot}/skills` — OMP-native skills, обнаруживаемые через `resources_discover`.
- `${dataRoot}/PAI/ACTIONS` — локальные Action definitions.
- `${dataRoot}/PAI/FLOWS` — Flow definitions.
- `${dataRoot}/PAI/PIPELINES` — Pipeline definitions.

Host-specific пути, credentials, персональные данные и runtime state не входят в package templates.

## Runtime invariants

1. Каждый main-agent turn получает ровно один mode: `MINIMAL`, `NATIVE` или `ALGORITHM`.
2. Mode управляет нативным OMP thinking level и короткой hidden policy; видимые ritual headers не требуются.
3. Сложная работа использует OMP-native skill `pai-deep-work` по необходимости.
4. Контекст загружается bounded retrieval через `pai_context`, а не полным чтением TELOS/MEMORY.
5. Durable personal memory записывается только через validated tool с provenance и confirmation rules.
6. Активная многошаговая работа использует OMP todo/goal; PRD создаётся для действительно persistent workflow.
7. Actions, Flows и Pipelines являются локальными declarative contracts с validation, approval tiers и checkpoint.
8. Import никогда не перезаписывает существующий private state.

См. `CONTEXT_ROUTING.md`, `PRDFORMAT.md` и каталоги automation ниже.
