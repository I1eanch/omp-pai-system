import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  actionDefinitionSha256,
  executeAction,
  loadActionManifest,
  type ActionManifest,
} from "../../src/automation/actions.ts";
import {
  validateJsonSchema,
  validateJsonSchemaDefinition,
} from "../../src/automation/json-schema.ts";

const roots: string[] = [];

function actionRoot(
  id = "normalize-title",
  script = `const input = await new Response(Bun.stdin.stream()).json();\nconsole.log(JSON.stringify({ title: input.title.trim().toLowerCase() }));\n`,
): string {
  const root = mkdtempSync(join(tmpdir(), "omp-pai-action-"));
  roots.push(root);
  const dataRoot = join(root, "pai");
  const directory = join(dataRoot, "PAI/ACTIONS", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "action.ts"), script);
  writeFileSync(join(directory, "action.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    entry: "action.ts",
    description: "Normalize a title",
    input: {
      type: "object",
      required: ["title"],
      additionalProperties: false,
      properties: { title: { type: "string", minLength: 1 } },
    },
    output: {
      type: "object",
      required: ["title"],
      additionalProperties: false,
      properties: { title: { type: "string" } },
    },
    timeoutMs: 5_000,
  }, null, 2));
  return dataRoot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Actions runtime", () => {
  test("loads, validates, executes, and checksums a local action", async () => {
    const dataRoot = actionRoot();
    const manifest = loadActionManifest(dataRoot, "normalize-title");
    expect(actionDefinitionSha256(dataRoot, manifest)).toMatch(/^[a-f0-9]{64}$/u);
    const report = await executeAction(dataRoot, "normalize-title", { title: "  HELLO  " });
    expect(report.output).toEqual({ title: "hello" });
    expect(report.actionId).toBe("normalize-title");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("rejects invalid input, unsafe manifests, and unsafe entries", async () => {
    const dataRoot = actionRoot();
    await expect(executeAction(dataRoot, "normalize-title", { title: "" }))
      .rejects.toThrow("shorter");
    expect(() => loadActionManifest(dataRoot, "../escape")).toThrow("Invalid action id");
    const manifestPath = join(dataRoot, "PAI/ACTIONS/normalize-title/action.json");
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>;
    manifest.entry = "../escape.ts";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => loadActionManifest(dataRoot, "normalize-title")).toThrow("Unsafe action entry");

    manifest.entry = "action.ts";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const entryPath = join(dirname(manifestPath), "action.ts");
    rmSync(entryPath);
    const outside = join(roots[0]!, "outside.ts");
    writeFileSync(outside, "console.log('{}')");
    symlinkSync(outside, entryPath);
    await expect(executeAction(dataRoot, "normalize-title", { title: "x" }))
      .rejects.toThrow("missing or unsafe");
    expect(() => actionDefinitionSha256(dataRoot, manifest as unknown as ActionManifest))
      .toThrow("unsafe file");
  });

  test("returns typed failures for process and output errors", async () => {
    await expect(executeAction(
      actionRoot("failure", "console.error('broken'); process.exit(7);\n"),
      "failure",
      { title: "x" },
    )).rejects.toThrow("Action failed (7): broken");
    await expect(executeAction(
      actionRoot("invalid-json", "console.log('not-json');\n"),
      "invalid-json",
      { title: "x" },
    )).rejects.toThrow("not valid JSON");
    await expect(executeAction(
      actionRoot("invalid-output", "console.log(JSON.stringify({wrong:true}));\n"),
      "invalid-output",
      { title: "x" },
    )).rejects.toThrow("title is required");
  });

  test("cancels before spawn and terminates an active action", async () => {
    const dataRoot = actionRoot(
      "cancel",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
    );
    const beforeStart = new AbortController();
    beforeStart.abort("before start");
    await expect(executeAction(
      dataRoot,
      "cancel",
      { title: "x" },
      { signal: beforeStart.signal },
    )).rejects.toThrow("aborted before start");

    const active = new AbortController();
    const running = executeAction(
      dataRoot,
      "cancel",
      { title: "x" },
      { signal: active.signal },
    );
    active.abort("user cancelled");
    await expect(running).rejects.toThrow("Action aborted");
  });

  test("rejects malformed manifests, timeouts, and bounded stream overflow", async () => {
    const malformedRoot = actionRoot("malformed");
    writeFileSync(join(malformedRoot, "PAI/ACTIONS/malformed/action.json"), "{");
    expect(() => loadActionManifest(malformedRoot, "malformed")).toThrow("unreadable");

    const unknownRoot = actionRoot("unknown");
    const unknownPath = join(unknownRoot, "PAI/ACTIONS/unknown/action.json");
    const unknown = JSON.parse(await Bun.file(unknownPath).text()) as Record<string, unknown>;
    unknown.extra = true;
    writeFileSync(unknownPath, JSON.stringify(unknown));
    expect(() => loadActionManifest(unknownRoot, "unknown")).toThrow("unknown fields");

    const invalidRoot = actionRoot("invalid");
    const invalidPath = join(invalidRoot, "PAI/ACTIONS/invalid/action.json");
    const invalid = JSON.parse(await Bun.file(invalidPath).text()) as Record<string, unknown>;
    invalid.timeoutMs = 0;
    writeFileSync(invalidPath, JSON.stringify(invalid));
    expect(() => loadActionManifest(invalidRoot, "invalid")).toThrow("invalid");

    const unsupportedRoot = actionRoot("unsupported-schema");
    const unsupportedPath = join(unsupportedRoot, "PAI/ACTIONS/unsupported-schema/action.json");
    const unsupported = JSON.parse(await Bun.file(unsupportedPath).text()) as Record<string, unknown>;
    unsupported.input = { type: "object", minProperties: 1 };
    writeFileSync(unsupportedPath, JSON.stringify(unsupported));
    expect(() => loadActionManifest(unsupportedRoot, "unsupported-schema"))
      .toThrow("unsupported keyword");

    const timeoutRoot = actionRoot(
      "timeout",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
    );
    const timeoutPath = join(timeoutRoot, "PAI/ACTIONS/timeout/action.json");
    const timeout = JSON.parse(await Bun.file(timeoutPath).text()) as Record<string, unknown>;
    timeout.timeoutMs = 100;
    writeFileSync(timeoutPath, JSON.stringify(timeout));
    await expect(executeAction(timeoutRoot, "timeout", { title: "x" })).rejects.toThrow("timed out");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      const windowsRoot = actionRoot(
        "windows-timeout",
        "setTimeout(() => process.exit(0), 150);\n",
      );
      const windowsPath = join(windowsRoot, "PAI/ACTIONS/windows-timeout/action.json");
      const windowsManifest = JSON.parse(await Bun.file(windowsPath).text()) as Record<string, unknown>;
      windowsManifest.timeoutMs = 100;
      writeFileSync(windowsPath, JSON.stringify(windowsManifest));
      await expect(executeAction(windowsRoot, "windows-timeout", { title: "x" }))
        .rejects.toThrow("timed out");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }

    const originalKill = process.kill;
    process.kill = (() => {
      throw new Error("injected process-group failure");
    }) as typeof process.kill;
    try {
      await expect(executeAction(timeoutRoot, "timeout", { title: "x" }))
        .rejects.toThrow("timed out");
    } finally {
      process.kill = originalKill;
    }

    await expect(executeAction(
      actionRoot("stdout-overflow", "process.stdout.write('x'.repeat(1024 * 1024 + 1));\n"),
      "stdout-overflow",
      { title: "x" },
    )).rejects.toThrow("stdout exceeds");
    await expect(executeAction(
      actionRoot("stderr-overflow", "process.stderr.write('x'.repeat(1024 * 1024 + 1));\n"),
      "stderr-overflow",
      { title: "x" },
    )).rejects.toThrow("stderr exceeds");
  });

  test("binds an execution report to the Action bytes read before spawn", async () => {
    const dataRoot = actionRoot(
      "self-modifying",
      `await Bun.write(import.meta.path, "console.log('{}')\\n");
console.log(JSON.stringify({ title: "before" }));
`,
    );
    const manifest = loadActionManifest(dataRoot, "self-modifying");
    const before = actionDefinitionSha256(dataRoot, manifest);
    const report = await executeAction(dataRoot, "self-modifying", { title: "x" });
    expect(report.definitionSha256).toBe(before);
    expect(actionDefinitionSha256(dataRoot, manifest)).not.toBe(before);
  });

  test("validates reusable JSON Schema boundaries", () => {
    expect(() => validateJsonSchema({ type: "array", minItems: 2 }, [1])).toThrow("fewer");
    expect(() => validateJsonSchema({ type: "number", minimum: 2 }, 1)).toThrow("below");
    expect(() => validateJsonSchema({ type: "string", pattern: "^x" }, "abc")).toThrow("pattern");
    expect(() => validateJsonSchema(false, null)).toThrow("rejected");
    expect(() => validateJsonSchema(true, { ok: true })).not.toThrow();
    expect(() => validateJsonSchema(true, Number.NaN)).toThrow("JSON-compatible");
    expect(() => validateJsonSchema(null, null)).toThrow("schema must");
    expect(() => validateJsonSchema({ const: 1 }, 2)).toThrow("must equal");
    expect(() => validateJsonSchema({ enum: [1] }, 2)).toThrow("allowed enum");
    expect(() => validateJsonSchema({ type: ["string", "null"] }, 2)).toThrow("match one");
    expect(() => validateJsonSchema({ type: ["number"] }, 2)).not.toThrow();
    expect(() => validateJsonSchema({ type: "string", maxLength: 2 }, "long")).toThrow("longer");
    expect(() => validateJsonSchema({ type: "number", maximum: 2 }, 3)).toThrow("above");
    expect(() => validateJsonSchema({ type: "array", maxItems: 1 }, [1, 2])).toThrow("more");
    expect(() => validateJsonSchema({ type: "array", items: { type: "string" } }, [1]))
      .toThrow("$[0]");
    expect(() => validateJsonSchema({ type: "array", items: { type: "number" } }, [1, 2]))
      .not.toThrow();
    expect(() => validateJsonSchema({
      type: "object",
      additionalProperties: false,
      properties: {},
    }, { extra: true })).toThrow("not allowed");
    expect(() => validateJsonSchema({
      type: "object",
      additionalProperties: { type: "number" },
    }, { value: "x" })).toThrow("$.value");
    expect(() => validateJsonSchema({}, { bad: Number.NaN })).toThrow("JSON-compatible");
    expect(() => validateJsonSchema({}, Symbol("bad"))).toThrow("JSON-compatible");

    expect(() => validateJsonSchemaDefinition(1)).toThrow("object or boolean");
    expect(() => validateJsonSchemaDefinition({ type: [] })).toThrow("type is invalid");
    expect(() => validateJsonSchemaDefinition({ type: ["string", "string"] }))
      .toThrow("type is invalid");
    expect(() => validateJsonSchemaDefinition({ const: Symbol("bad") }))
      .toThrow("not JSON-compatible");
    expect(() => validateJsonSchemaDefinition({ enum: "bad" })).toThrow("enum is invalid");
    expect(() => validateJsonSchemaDefinition({ enum: [Symbol("bad")] })).toThrow("enum is invalid");
    expect(() => validateJsonSchemaDefinition({ minLength: -1 }))
      .toThrow("non-negative safe integer");
    expect(() => validateJsonSchemaDefinition({ minimum: Number.NaN }))
      .toThrow("finite number");
    expect(() => validateJsonSchemaDefinition({ pattern: 1 })).toThrow("must be a string");
    expect(() => validateJsonSchemaDefinition({ pattern: "[" })).toThrow("pattern is invalid");
    expect(() => validateJsonSchemaDefinition({ required: "x" })).toThrow("required is invalid");
    expect(() => validateJsonSchemaDefinition({ required: ["x", "x"] }))
      .toThrow("required is invalid");
    expect(() => validateJsonSchemaDefinition({ properties: [] }))
      .toThrow("properties must be an object");
    expect(() => validateJsonSchemaDefinition({
      type: ["object", "null"],
      properties: { value: { type: "number" } },
      items: true,
      additionalProperties: false,
    })).not.toThrow();
    expect(() => validateJsonSchema(
      { const: [{ value: 1 }] },
      [{ value: 1 }],
    )).not.toThrow();
    expect(() => validateJsonSchema(
      { enum: [{ value: 1 }] },
      { value: 2 },
    )).toThrow("allowed enum");
  });
});
