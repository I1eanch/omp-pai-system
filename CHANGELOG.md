# Changelog

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии следуют [Semantic Versioning](https://semver.org/lang/ru/).

## Unreleased

### Fixed

- Runtime gate снова делегирует выбор режима main-agent активному PAI contract, принимает динамическое восьмисловное `TASK`-описание, требует пересчитать и без перефразирования вывести проверенный финальный draft и не подменяет финальные поля PAI фиксированным текстом.
- Advisor отделён от PAI executor: profile-level `WATCHDOG.yml` запрещает Advisor входить в Algorithm и запускать post-hoc user-facing продолжения; `/pai-init`, `/pai-doctor`, staging и lifecycle smoke сохраняют этот contract переносимым.
- Добавлен `ALGORITHM LIGHT` для ограниченной умеренной многошаговой работы: inline `scope → execute → verify`, без чтения полного Algorithm, run PRD, ISC и reflection; исследования, объяснения и read-only проверки остаются в `NATIVE`, полный `ALGORITHM` ограничен high-risk implementation/debugging.
- Advisor scheduling пропускает WIP snapshots при `willContinue:true`, отправляет один накопленный review-turn после финального ответа и принимает пустой `stop` как штатное отсутствие замечаний без трёх retries; source checkout применяет host fix через Bun `patchedDependency`, а release archive включает patch для явного host-side применения.
- Full ALGORITHM continuation принимает оба фактических формата `read`: legacy `{ path, selector }` и inline selector в `path` (`…v3.7.0.md:301-386`), сохраняя строгую проверку полного чтения.
- Direct-loader установка регистрирует `/pai-doctor` без второго runtime gate; active doctor проверяет Algorithm v3.7, PAI templates, split-root `MEMORY`, vault-backed `TELOS` и Advisor boundary.
- Gemini 3.8 Flash wire-модели получают минимально поддерживаемый `thinkingLevel: LOW` до подтверждения PAI header вместо отклоняемого Cloud Code Assist значения `MINIMAL`.

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

