import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { initializePaiState } from "../../src/commands/init.ts";
import {
  listPrds,
  parsePrd,
  readPrd,
  registerPrdSyncHook,
  syncPrdRegistry,
  writePrd,
} from "../../src/state/prd.ts";

const packageRoot = resolve(import.meta.dir, "../..");
const roots: string[] = [];
const prdContent = `---
task: Реализовать PRD lifecycle
slug: prd-lifecycle
effort: standard
phase: execute
progress: 1/2
mode: autonomous
started: 2026-08-05T10:00:00.000Z
updated: 2026-08-05T12:00:00.000Z
---

## Context

Persistent work.

## Criteria

- [x] ISC-1: PRD file is stored safely
- [ ] ISC-2: Registry reflects current progress
`;

function initializedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-pai-prd-runtime-"));
  roots.push(root);
  const dataRoot = join(root, "pai");
  initializePaiState({ pluginRoot: packageRoot, dataRoot });
  return dataRoot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PRD lifecycle", () => {
  test("writes, reads, lists, and synchronizes validated PRDs", () => {
    const dataRoot = initializedRoot();
    const written = writePrd(dataRoot, prdContent);
    expect(written.slug).toBe("prd-lifecycle");
    expect(written.criteria.filter(({ checked }) => checked)).toHaveLength(1);
    expect(readPrd(dataRoot, "prd-lifecycle").phase).toBe("execute");
    writePrd(
      dataRoot,
      prdContent
        .replace("task: Реализовать PRD lifecycle", "task: Второй PRD")
        .replaceAll("prd-lifecycle", "another-prd"),
    );
    expect(listPrds(dataRoot)).toHaveLength(2);
    expect(syncPrdRegistry(dataRoot).sessions).toBe(2);

    const registry = JSON.parse(
      readFileSync(join(dataRoot, "MEMORY/STATE/work.json"), "utf8"),
    ) as { sessions: Record<string, { progress: string }> };
    expect(registry.sessions["prd-lifecycle"]?.progress).toBe("1/2");
  });

  test("rejects invalid progress, duplicate criteria, and slug mismatch", () => {
    expect(() => parsePrd(prdContent.replace("progress: 1/2", "progress: 0/2"), "PRD.md"))
      .toThrow("does not match");
    expect(() => parsePrd(
      prdContent.replace("ISC-2", "ISC-1"),
      "PRD.md",
    )).toThrow("Duplicate PRD criterion");
    const dataRoot = initializedRoot();
    writePrd(dataRoot, prdContent);
    const path = join(dataRoot, "MEMORY/WORK/prd-lifecycle/PRD.md");
    writeFileSync(path, prdContent.replace("slug: prd-lifecycle", "slug: another"));
    expect(() => readPrd(dataRoot, "prd-lifecycle")).toThrow("does not match directory");
    expect(() => readPrd(dataRoot, "../escape")).toThrow("slug is invalid");
  });

  test("sync hook reacts only to successful PRD mutations", () => {
    const dataRoot = initializedRoot();
    writePrd(dataRoot, prdContent);
    const handlers: Record<string, (event: Record<string, unknown>) => unknown> = {};
    registerPrdSyncHook({
      on: (name: string, handler: (event: Record<string, unknown>) => unknown) => {
        handlers[name] = handler;
      },
    } as unknown as ExtensionAPI, dataRoot);
    const registryPath = join(dataRoot, "MEMORY/STATE/work.json");
    writeFileSync(registryPath, '{"schemaVersion":1,"sessions":{}}\n');
    handlers.tool_result({
      toolName: "write",
      isError: false,
      input: { path: join(dataRoot, "MEMORY/WORK/prd-lifecycle/PRD.md") },
    });
    expect(readFileSync(registryPath, "utf8")).toContain("prd-lifecycle");
    writeFileSync(registryPath, '{"schemaVersion":1,"sessions":{}}\n');
    handlers.tool_result({ toolName: "write", isError: true, input: { path: registryPath } });
    expect(readFileSync(registryPath, "utf8")).not.toContain("prd-lifecycle");
  });

  test("rejects symlinked work entries", () => {
    const dataRoot = initializedRoot();
    const outside = join(roots[0]!, "outside");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(dataRoot, "MEMORY/WORK/link"));
    expect(() => listPrds(dataRoot)).toThrow("symlink");
  });
});
