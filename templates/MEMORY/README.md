# MEMORY Starter

MEMORY хранит рабочее состояние Algorithm и локальные learning records. Package содержит только schema, layout и пустые registries; реальные PRD, signals, reflections, failures, raw events и session history создаются внутри `${memoryRoot}`.

## Ownership

- `init` создаёт отсутствующие директории и starter-файлы.
- Runtime может добавлять records только в configured `${memoryRoot}`.
- Upgrade не перезаписывает mutable registries.
- Uninstall удаляет только ownership-marked package artifacts и не удаляет пользовательские records без отдельного флага.
- Private export включается только явной локальной командой и записывает integrity manifest.

`layout.json` — декларативный список директорий. `STATE/work.json` — пустой registry активных и завершённых PRD sessions. JSONL starters имеют нулевую длину, чтобы исключить synthetic facts из долговременной памяти.
