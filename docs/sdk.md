# Extension SDK

`omp-pai-system` — OMP extension package, а не HTTP API.

## Entrypoint

OMP обнаруживает extension через `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

Default export уже сконфигурирован относительно package root. Для embedded integration:

```ts
import { createPaiPlugin } from "omp-pai-system/src/index.ts";

export default createPaiPlugin({
  pluginRoot: "/opt/omp/plugins/omp-pai-system",
  env: {
    OMP_PAI_DATA_DIR: "/srv/private/pai"
  }
});
```

## Config API

```ts
resolvePaiConfig({ pluginRoot, env? }): PaiConfig
```

Результат:

```ts
type PaiConfig = {
  pluginRoot: string;
  dataRoot: string;
};
```

`pluginRoot` и `dataRoot` нормализуются через `resolve()`. Data root выбирается из `OMP_PAI_DATA_DIR`, затем `PI_CODING_AGENT_DIR/pai`, затем `~/.omp/agent/pai`.

## Runtime API

`src/runtime/pai-runtime-contract.ts`:

- `routePaiPrompt(prompt, isSubagent): PaiRoute` — pure deterministic classifier; delegated work по умолчанию получает `NATIVE`, явный ALGORITHM marker имеет приоритет.
- `thinkingLevelForMode(mode)` — OMP thinking level.
- `buildTurnPolicy(route, dataRoot)` — compact hidden turn-policy.
- `isSubagentSystemPrompt(systemPrompt)` — определение subagent marker.

`src/runtime/pai-runtime-gate.ts`:

- `createPaiRuntime({ dataRoot, skillRoot })` — регистрирует `before_agent_start` и `turn_end`.

Runtime использует только документированные OMP result shapes: replacement `systemPrompt`, `pi.setThinkingLevel()` и `pi.appendEntry()`.

## State APIs

### TELOS

```ts
parseTelosRecord(content, path): TelosDocument
readTelosRecords(dataRoot): TelosDocument[]
queryTelos(dataRoot, query, limit?): TelosSearchResult[]
appendTelosEntry(dataRoot, recordType, text, updated?): TelosDocument
```

### MEMORY

```ts
parseMemoryRecord(value, line): MemoryRecord
readMemoryRecords(dataRoot): MemoryRecord[]
recordMemory(dataRoot, input): MemoryRecord
rebuildMemoryIndex(dataRoot): { records; path }
queryMemory(dataRoot, query, limit?): MemorySearchResult[]
```

### PRD

```ts
parsePrd(content, path): PrdDocument
readPrd(dataRoot, slug): PrdDocument
listPrds(dataRoot): PrdDocument[]
writePrd(dataRoot, content): PrdDocument
syncPrdRegistry(dataRoot): { sessions; path }
registerPrdSyncHook(pi, dataRoot): void
```

Все state paths проходят lexical containment, полный ancestor symlink check и descriptor-based bounded reads/owner-only atomic writes через `src/state/safe-state.ts`.

## Automation APIs

### Action

```ts
loadActionManifest(dataRoot, actionId): ActionManifest
actionDefinitionSha256(dataRoot, manifest): string
executeAction(dataRoot, actionId, input, { signal? }): Promise<ActionExecutionReport>
```

### Flow

```ts
loadFlowDefinition(dataRoot, flowId): FlowDefinition & { sha256 }
readFlowState(dataRoot, flowId): FlowRunState | null
runFlow(dataRoot, flowId, input, { resume?, maxSteps?, signal? }): Promise<FlowRunReport>
```

### Pipeline

```ts
loadPipelineDefinition(dataRoot, pipelineId): PipelineDefinition & { sha256 }
readPipelineState(dataRoot, pipelineId): PipelineRunState | null
runPipeline(dataRoot, pipelineId, input, { resume?, signal? }): Promise<PipelineRunReport>
```

Formal JSON Schemas Draft 2020-12 находятся в `contracts/`; Action schema отдельно описывает весь fail-closed runtime subset. OMP tool handlers передают свой `AbortSignal` в Action, Flow и Pipeline без адаптеров.

## Registered OMP surface

Tools:

- `pai_context`
- `pai_telos_append`
- `pai_memory_record`
- `pai_prd`
- `pai_action_run`
- `pai_flow_run`
- `pai_pipeline_run`

Commands:

- `/pai-init`
- `/pai-doctor`
- `/pai-memory-reindex`
- `/pai-prd-sync`
- `/pai-private-export <local-path>`
- `/pai-private-import <local-path>`

## Compatibility

- Runtime: Bun `>=1.3.0`.
- Peer dependency: `@oh-my-pi/pi-coding-agent ^16.4.8`.
- Проверенный development runtime: `16.5.x`.
- Strict TypeScript, ESM и `.ts` imports.
