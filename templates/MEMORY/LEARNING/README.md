# Learning Records

Learning state разделён по назначению:

- `REFLECTIONS/algorithm-reflections.jsonl` — append-only выводы после завершённых Algorithm runs.
- `SIGNALS/ratings.jsonl` — явные пользовательские оценки и связанный session identifier.
- `FAILURES/` — диагностические captures без credentials и необработанных secrets.
- `SYNTHESIS/` — агрегированные устойчивые уроки, полученные из локальных records.

Starter JSONL-файлы пусты. Writer обязан добавлять одну валидную JSON object на строку, использовать UTC timestamp и выполнять atomic append. Неизвестная schema version блокирует запись. Raw provider payload, system prompt, credentials и персональные TELOS records не копируются в learning state автоматически.
