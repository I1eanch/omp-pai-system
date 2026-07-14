# Changelog

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии следуют [Semantic Versioning](https://semver.org/lang/ru/).

## Unreleased

Пока нет.

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

