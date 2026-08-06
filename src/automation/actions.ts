import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, posix } from "node:path";
import { isUnknownRecord } from "../type-guards.ts";
import { readStateText, resolveStatePath } from "../state/safe-state.ts";
import {
  isJsonValue,
  validateJsonSchema,
  validateJsonSchemaDefinition,
  type JsonValue,
} from "./json-schema.ts";

export type ActionManifest = {
  schemaVersion: 1;
  id: string;
  entry: string;
  description: string;
  input: unknown;
  output: unknown;
  timeoutMs: number;
};

export type ActionExecutionReport = {
  actionId: string;
  output: JsonValue;
  definitionSha256: string;
  durationMs: number;
};
export type ExecuteActionOptions = {
  signal?: AbortSignal;
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ACTION_OUTPUT_BYTES = 1024 * 1024;

function validateActionEntry(entry: string): void {
  const normalized = posix.normalize(entry);
  if (
    !entry
    || entry.includes("\\")
    || entry.includes("\0")
    || isAbsolute(entry)
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized !== entry
    || basename(entry) !== entry
    || !/\.(?:js|ts)$/u.test(entry)
  ) {
    throw new Error(`Unsafe action entry: ${entry}`);
  }
}

/** Loads and strictly validates an Action manifest from owner-controlled state. */
export function loadActionManifest(dataRoot: string, actionId: string): ActionManifest {
  if (!ID_PATTERN.test(actionId)) throw new Error(`Invalid action id: ${actionId}`);
  const manifestPath = `PAI/ACTIONS/${actionId}/action.json`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readStateText(dataRoot, manifestPath, MAX_MANIFEST_BYTES));
  } catch (error) {
    throw new Error(`Action manifest is unreadable: ${actionId}`, { cause: error });
  }
  if (!isUnknownRecord(parsed)) throw new Error(`Action manifest is invalid: ${actionId}`);
  const keys = ["schemaVersion", "id", "entry", "description", "input", "output", "timeoutMs"];
  if (Object.keys(parsed).some((key) => !keys.includes(key))) {
    throw new Error(`Action manifest contains unknown fields: ${actionId}`);
  }
  if (
    parsed.schemaVersion !== 1
    || parsed.id !== actionId
    || typeof parsed.entry !== "string"
    || typeof parsed.description !== "string"
    || !parsed.description.trim()
    || !(isUnknownRecord(parsed.input) || typeof parsed.input === "boolean")
    || !(isUnknownRecord(parsed.output) || typeof parsed.output === "boolean")
    || typeof parsed.timeoutMs !== "number"
    || !Number.isSafeInteger(parsed.timeoutMs)
    || parsed.timeoutMs < 1
    || parsed.timeoutMs > 300_000
  ) {
    throw new Error(`Action manifest is invalid: ${actionId}`);
  }
  validateActionEntry(parsed.entry);
  validateJsonSchemaDefinition(parsed.input, `$action.${actionId}.input`);
  validateJsonSchemaDefinition(parsed.output, `$action.${actionId}.output`);
  return parsed as unknown as ActionManifest;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} byte limit`);
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/** Hashes the exact manifest and entry bytes used to bind execution checkpoints. */
export function actionDefinitionSha256(dataRoot: string, manifest: ActionManifest): string {
  const manifestPath = resolveStatePath(dataRoot, `PAI/ACTIONS/${manifest.id}/action.json`);
  const entryPath = resolveStatePath(dataRoot, `PAI/ACTIONS/${manifest.id}/${manifest.entry}`);
  for (const path of [manifestPath, entryPath]) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new Error(`Action definition contains an unsafe file: ${manifest.id}`);
    }
  }
  return createHash("sha256")
    .update(readFileSync(manifestPath))
    .update("\0")
    .update(readFileSync(entryPath))
    .digest("hex");
}

/** Executes one local Action with schema checks, bounded output, timeout, and cancellation. */
export async function executeAction(
  dataRoot: string,
  actionId: string,
  input: JsonValue,
  options: ExecuteActionOptions = {},
): Promise<ActionExecutionReport> {
  if (options.signal?.aborted) {
    throw new Error(`Action aborted before start: ${actionId}`, { cause: options.signal.reason });
  }
  if (!isJsonValue(input)) throw new Error("Action input must be JSON-compatible");
  const manifest = loadActionManifest(dataRoot, actionId);
  validateJsonSchema(manifest.input, input, "$input");
  const entryPath = resolveStatePath(dataRoot, `PAI/ACTIONS/${actionId}/${manifest.entry}`);
  const entryInfo = lstatSync(entryPath, { throwIfNoEntry: false });
  if (!entryInfo?.isFile() || entryInfo.isSymbolicLink()) {
    throw new Error(`Action entry is missing or unsafe: ${actionId}/${manifest.entry}`);
  }
  const definitionSha256 = actionDefinitionSha256(dataRoot, manifest);

  const startedAt = performance.now();
  const child = Bun.spawn([process.execPath, entryPath], {
    cwd: dirname(entryPath),
    env: {
      PATH: process.env.PATH ?? "",
      OMP_PAI_ACTION_ID: actionId,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  const killTree = (): void => {
    try {
      // Windows has no POSIX process groups.
      if (process.platform === "win32") {
        Bun.spawn(["taskkill", "/pid", String(child.pid), "/t", "/f"], {
          stdout: "ignore",
          stderr: "ignore",
        });
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      // Fall back to terminating the direct child if process-group termination fails.
      try {
        child.kill(9);
      } catch {
        // The process already exited.
      }
    }
  };
  let aborted = false;
  const abort = (): void => {
    aborted = true;
    killTree();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  let timeout: NodeJS.Timeout | undefined;
  try {
    child.stdin.write(`${JSON.stringify(input)}\n`);
    child.stdin.end();
    let timedOut = false;
    timeout = setTimeout(() => {
      timedOut = true;
      killTree();
    }, manifest.timeoutMs);
    const stdoutPromise = readBoundedStream(child.stdout, MAX_ACTION_OUTPUT_BYTES, "Action stdout")
      .catch((error) => {
        killTree();
        throw error;
      });
    const stderrPromise = readBoundedStream(child.stderr, MAX_ACTION_OUTPUT_BYTES, "Action stderr")
      .catch((error) => {
        killTree();
        throw error;
      });
    const [stdout, stderr, exitCode] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      child.exited,
    ]);
    if (aborted) throw new Error(`Action aborted: ${actionId}`, { cause: options.signal?.reason });
    if (timedOut) throw new Error(`Action timed out after ${manifest.timeoutMs}ms: ${actionId}`);
    if (exitCode !== 0) {
      throw new Error(`Action failed (${exitCode}): ${stderr.toString("utf8").trim() || actionId}`);
    }

    let output: unknown;
    try {
      output = JSON.parse(stdout.toString("utf8"));
    } catch (error) {
      throw new Error(`Action output is not valid JSON: ${actionId}`, { cause: error });
    }
    validateJsonSchema(manifest.output, output, "$output");
    return {
      actionId,
      output,
      definitionSha256,
      durationMs: performance.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
