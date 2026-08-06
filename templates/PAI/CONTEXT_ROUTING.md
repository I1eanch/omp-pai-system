# Context Routing

Контекст загружается по необходимости и с provenance; package templates не являются runtime memory.

| Нужен контекст | Источник / API |
|---|---|
| Режим turn и thinking | `contracts/runtime-gate.json`, `src/runtime/pai-runtime-contract.ts` |
| Сложная методика работы | OMP skill `pai-deep-work` через native skill discovery |
| Личные цели и решения | `pai_context` с source `telos` |
| Рабочие lessons/failures/notes | `pai_context` с source `memory` |
| Текущий persistent workflow | `pai_prd get/list` и `${dataRoot}/MEMORY/STATE/work.json` |
| Action contract | `${dataRoot}/PAI/ACTIONS/<id>/action.json` |
| Flow definition/state | `${dataRoot}/PAI/FLOWS/<id>.json`, `${dataRoot}/MEMORY/STATE/flows/<id>.json` |
| Pipeline definition/state | `${dataRoot}/PAI/PIPELINES/<id>.json`, `${dataRoot}/MEMORY/STATE/pipelines/<id>.json` |

## Правила

1. Начинать с минимального bounded query, затем расширять только при недостаточном результате.
2. Не читать весь TELOS/MEMORY corpus, если focused retrieval достаточен.
3. Каждый retrieved result сохраняет относительный source path.
4. Project-local инструкции и текущий user prompt приоритетнее общих memory records.
5. Отсутствующий optional context не заменяется выдуманными значениями.
6. Durable fact/preference требует explicit confirmation; transient session content не записывается автоматически.
7. Definition и persisted checkpoint должны иметь совпадающий checksum перед resume.
