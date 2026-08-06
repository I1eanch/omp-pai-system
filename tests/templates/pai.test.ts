import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MEMORY_KINDS } from "../../src/state/memory.ts";

const packageRoot = resolve(import.meta.dir, "../..");
const requiredPortableTemplates = [
  "templates/PAI/README.md",
  "templates/PAI/PRDFORMAT.md",
  "templates/PAI/CONTEXT_ROUTING.md",
  "templates/PAI/ACTIONS/README.md",
  "templates/PAI/FLOWS/README.md",
  "templates/PAI/PIPELINES/README.md",
] as const;
const forbiddenPortablePatterns = [
  /\/Users\//u,
  /~\/\.claude/u,
  /\.claude\/PAI/u,
  /\.claude\/MEMORY/u,
  /process\.env\.HOME/u,
  /homedir\(\)/u,
] as const;

describe("bundled PAI templates", () => {
  test("provide the portable core specifications", () => {
    for (const relativePath of requiredPortableTemplates) {
      const content = readFileSync(join(packageRoot, relativePath), "utf8");
      expect(content.trim().length, relativePath).toBeGreaterThan(100);
      for (const pattern of forbiddenPortablePatterns) {
        expect(pattern.test(content), `${relativePath}: ${pattern}`).toBe(false);
      }
    }
  });

  test("ships machine-readable contracts and the native deep-work skill", () => {
    for (const filename of [
      "runtime-gate.json",
      "action.schema.json",
      "flow.schema.json",
      "pipeline.schema.json",
      "memory-record.schema.json",
    ]) {
      const contract = JSON.parse(
        readFileSync(join(packageRoot, "contracts", filename), "utf8"),
      ) as { schemaVersion?: number; $schema?: string };
      expect(
        (typeof contract.schemaVersion === "number" && contract.schemaVersion >= 1)
        || contract.$schema?.includes("json-schema") === true,
      ).toBe(true);
    }
    const skill = readFileSync(join(packageRoot, "skills/pai-deep-work/SKILL.md"), "utf8");
    expect(skill).toContain("name: pai-deep-work");
    expect(skill).toContain("description:");
  });

  test("keeps machine-readable schemas aligned with runtime contracts", () => {
    const action = JSON.parse(
      readFileSync(join(packageRoot, "contracts/action.schema.json"), "utf8"),
    ) as {
      $id: string;
      $defs: { runtimeSchema: { anyOf: Array<{ properties?: Record<string, unknown> }> } };
    };
    const runtimeKeywords = Object.keys(action.$defs.runtimeSchema.anyOf[1]!.properties!);
    expect(runtimeKeywords.sort()).toEqual([
      "additionalProperties",
      "const",
      "enum",
      "items",
      "maxItems",
      "maxLength",
      "maximum",
      "minItems",
      "minLength",
      "minimum",
      "pattern",
      "properties",
      "required",
      "type",
    ]);
    expect(action.$id).toBe("urn:omp-pai-system:schema:action:1");

    const memory = JSON.parse(
      readFileSync(join(packageRoot, "contracts/memory-record.schema.json"), "utf8"),
    ) as { properties: { kind: { enum: string[] } }; additionalProperties: boolean };
    expect(memory.properties.kind.enum).toEqual([...MEMORY_KINDS]);
    expect(memory.additionalProperties).toBe(false);

    const flow = JSON.parse(
      readFileSync(join(packageRoot, "contracts/flow.schema.json"), "utf8"),
    ) as { $defs: { state: { oneOf: unknown[] } } };
    expect(flow.$defs.state.oneOf).toHaveLength(2);

    const pipeline = JSON.parse(
      readFileSync(join(packageRoot, "contracts/pipeline.schema.json"), "utf8"),
    ) as { properties: { steps: { minItems: number; maxItems: number } } };
    expect(pipeline.properties.steps).toMatchObject({ minItems: 1, maxItems: 1000 });
  });
});
