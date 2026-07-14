# omp-pai-system

Portable runtime для PAI, Algorithm, TELOS и MEMORY в Oh My Pi (OMP).

Текущая версия: `0.1.0`.

## Возможности

- Инициализирует локальные `TELOS`, `MEMORY` и PAI-шаблоны без перезаписи пользовательских файлов.
- Принудительно маршрутизирует каждый основной запрос в `MINIMAL`, `NATIVE` или `ALGORITHM`.
- Для `ALGORITHM` требует точный mode header, фиксированную строку `TASK` и полное чтение bundled Algorithm до других tool calls.
- Поддерживает локальный override Algorithm без сетевой загрузки.
- Проверяет состояние установки read-only командой `pai-doctor`.
- Экспортирует и импортирует приватные `TELOS`/`MEMORY` архивы с SHA-256, проверкой путей и запретом перезаписи.
- Поставляется через allowlisted staging и проверяемый release archive.


## Архитектура и Схема работы

Рантайм работает как расширение для Oh My Pi (OMP), перехватывая события жизненного цикла агента через официальный Hook Contract.

### Схема взаимодействия компонентов

```mermaid
graph TD
    U[Пользователь] -->|Запрос| A[OMP-агент (Oh My Pi)]
    A -->|1. before_agent_start| G[omp-pai-system]
    G -->|Внедрение системных инструкций| A
    A -->|2. before_provider_request| P[Провайдер API Gemini]
    G -->|Установка thinking & temperature| P
    A -->|3. Вызов инструментов| T[tool_call]
    T -->|Валидация запуска и Algorithm Gate| G
    G -->|Разрешить / Заблокировать| T
```

### Полный список хуков жизненного цикла OMP:

1. **`before_agent_start`**:
   - Классифицирует входящий запрос пользователя на `MINIMAL`, `NATIVE` или `ALGORITHM`.
   - Внедряет управляющие PAI-инструкции в системный промпт (`systemPrompt`), поддерживая цепочечное объединение промптов (`string[]` chaining).

2. **`before_provider_request`**:
   - Модифицирует низкоуровневый payload провайдера (Google Generative AI и Gemini CLI).
   - Применяет нулевую температуру (`temperature: 0`) и выставляет безопасный уровень `thinkingConfig` (в зависимости от модели и режима).

3. **`context`**:
   - Внедряет скрытое сообщение `pai-runtime-continuation` в историю контекста, предотвращая повторный вывод заголовков режимов и строк `TASK` при многошаговых итерациях в пределах одного хода.

4. **`message_start`**:
   - Отслеживает начало ответа ассистента, инкрементирует счётчик сообщений и сбрасывает буфер выводимого текста.

5. **`message_update`**:
   - Аккумулирует стриминговый текст ответа ассистента для последующей проверки в `tool_call`.

6. **`tool_call`**:
   - Контролирует вызовы инструментов. Требует наличия обязательного заголовка режима и строки `TASK` в выводе ассистента (разрешён только один экземпляр за ход).
   - В режиме `ALGORITHM` блокирует вызов любых других инструментов до тех пор, пока не будет выполнен полный последовательный запуск чтения файла Алгоритма.
   - Проверяет путь и селектор первого чтения Алгоритма, отклоняя попытки обхода (Path-Bypass Protection).

7. **`tool_result`**:
   - Валидирует результат чтения Алгоритма, отслеживает маркеры усечения контекста (`truncation`) и переводит состояние плагина в `algorithmReadApproved = true` после полного прочтения файла.
## Границы безопасности

Пакет не поставляет пользовательские цели, контакты, историю сессий, credentials или содержимое приватного MEMORY. В release входят только исходный код, контракты и sanitized starter templates. Подробности: [`docs/best-practices.md`](docs/best-practices.md).

## Локальная установка из source checkout

Требования: Bun `>=1.3.0`, установленный `omp` и OMP Extension SDK `@oh-my-pi/pi-coding-agent` `^16.4.8`.

```bash
bun install
bun run typecheck
bun test
bun run build:staging
omp plugin install "$PWD/dist/staging" --force --json
```

После установки в OMP:

```text
/pai-init
/pai-doctor
```

Нативная проверка plugin lifecycle:

```bash
omp plugin doctor omp-pai-system --json
```

## Команды OMP

| Команда | Назначение |
|---|---|
| `/pai-init` | Создать отсутствующие starter files; существующие файлы сохранить |
| `/pai-doctor` | Выполнить read-only health checks PAI runtime и private state |
| `/pai-private-export <local-path>` | Экспортировать `TELOS` и `MEMORY` в локальный `.tar.gz` |
| `/pai-private-import <local-path>` | Проверить и импортировать архив без перезаписи файлов |

Пути с пробелами можно заключать в одинарные или двойные кавычки.

## Режимы PAI

- `MINIMAL` — приветствия, подтверждения, оценки; tool calls запрещены.
- `NATIVE` — один короткий атомарный запрос или subagent без явного Algorithm opt-in.
- `ALGORITHM` — сложные, многошаговые и неоднозначные запросы; также безопасный fallback для нераспознанных запросов основного агента.

Runtime gate проверяет видимый первый text block, а не hidden reasoning. После принятия mode header повторный header или `TASK` в tool loop блокируется.

## Конфигурация

| Переменная | Назначение |
|---|---|
| `PI_CODING_AGENT_DIR` | Корень профиля OMP; по умолчанию `~/.omp/agent` |
| `OMP_PAI_DATA_DIR` | Явный корень локального PAI state |
| `OMP_PAI_ALGORITHM_PATH` | Абсолютный путь к локальному Algorithm override |
| `OMP_PAI_ALGORITHM_VERSION` | SemVer override, если версия не выводится из имени файла |

`OMP_PAI_ALGORITHM_PATH` принимает только существующий локальный filesystem path. URL и относительные пути отклоняются. Пакет ничего не скачивает автоматически.

## Проверка и release из source checkout
Эти maintainer commands требуют `scripts/`, `tests/` и `tsconfig.json` из репозитория. Они намеренно недоступны внутри установленного release artifact.


```bash
bun run typecheck
bun test
bun run build:staging
bun run audit:privacy
bun run release:pack
bun run test:lifecycle
bun run smoke:install
```

`build:staging` копирует только allowlisted файлы. `audit:privacy` проверяет provenance, exclusions, secrets и host-specific traces. `release:pack` создаёт архив и manifest с SHA-256. `test:lifecycle` проверяет lifecycle functions, а `smoke:install` выполняет реальный install/list/doctor/upgrade/uninstall в изолированном OMP profile.

## Документация

- [Best practices и security model](docs/best-practices.md)
- [FAQ](docs/faq.md)
- [Extension SDK](docs/sdk.md)
- [История изменений](CHANGELOG.md)

OpenAPI specification отсутствует намеренно: plugin не поднимает HTTP API.

## Лицензия и provenance

Исходный код пакета распространяется по Apache-2.0. Bundled Algorithm `v3.5.0` является производной от The Algorithm и сохраняет MIT notice. Точные источники и ограничения описаны в `privacy/provenance-manifest.json` и `THIRD_PARTY_NOTICES.md`.
