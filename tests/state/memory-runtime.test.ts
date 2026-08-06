import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializePaiState } from "../../src/commands/init.ts";
import {
  parseMemoryRecord,
  queryMemory,
  readMemoryRecords,
  rebuildMemoryIndex,
  recordMemory,
} from "../../src/state/memory.ts";

const packageRoot = resolve(import.meta.dir, "../..");
const roots: string[] = [];
const fixedId = "123e4567-e89b-12d3-a456-426614174000";

function initializedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-pai-memory-runtime-"));
  roots.push(root);
  const dataRoot = join(root, "pai");
  initializePaiState({ pluginRoot: packageRoot, dataRoot });
  return dataRoot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MEMORY runtime", () => {
  test("records, indexes, reads, and retrieves confirmed memory", () => {
    const dataRoot = initializedRoot();
    const record = recordMemory(dataRoot, {
      id: fixedId,
      kind: "preference",
      content: "Пользователь предпочитает короткие OMP отчёты",
      source: "explicit user statement",
      confidence: 1,
      userConfirmed: true,
      createdAt: "2026-08-05T12:00:00.000Z",
    });
    expect(record.id).toBe(fixedId);
    expect(readMemoryRecords(dataRoot)).toEqual([record]);
    expect(queryMemory(dataRoot, "OMP отчёты")).toEqual([{ ...record, score: 2 }]);
    expect(queryMemory(dataRoot, "", 1)).toHaveLength(1);
    recordMemory(dataRoot, {
      kind: "note",
      content: "OMP отчёты дополняются проверками",
      source: "explicit user statement",
      confidence: 0.5,
      userConfirmed: true,
      createdAt: "2026-08-05T13:00:00.000Z",
    });
    expect(queryMemory(dataRoot, "OMP отчёты")).toHaveLength(2);

    const index = JSON.parse(
      readFileSync(join(dataRoot, "MEMORY/STATE/memory-index.json"), "utf8"),
    ) as { schemaVersion: number; records: Array<{ id: string; terms: string[] }> };
    expect(index.schemaVersion).toBe(1);
    expect(index.records[0]?.id).toBe(fixedId);
    expect(index.records[0]?.terms).toContain("отчёты");
    expect(rebuildMemoryIndex(dataRoot).records).toBe(2);
  });

  test("rejects unconfirmed personal context and invalid fields", () => {
    const dataRoot = initializedRoot();
    const base = {
      kind: "fact" as const,
      content: "Личный факт",
      source: "inference",
      confidence: 0.5,
      userConfirmed: false,
    };
    expect(() => recordMemory(dataRoot, base)).toThrow("explicit user confirmation");
    expect(() => recordMemory(dataRoot, { ...base, kind: "note", content: " " }))
      .toThrow("non-empty");
    expect(() => recordMemory(dataRoot, { ...base, kind: "note", confidence: 2 }))
      .toThrow("between 0 and 1");
    expect(() => recordMemory(dataRoot, {
      ...base,
      kind: "note",
      createdAt: "invalid",
    })).toThrow("timestamp");
    expect(() => recordMemory(dataRoot, {
      ...base,
      kind: "note",
      id: "not-a-uuid",
    })).toThrow("UUID");
    expect(() => queryMemory(dataRoot, "x", 0)).toThrow("limit");
  });

  test("validates persisted JSONL and duplicate ids", () => {
    expect(() => parseMemoryRecord(null, 1)).toThrow("line 1");
    expect(() => parseMemoryRecord({ schemaVersion: 2 }, 2)).toThrow("line 2");
    const dataRoot = initializedRoot();
    const path = join(dataRoot, "MEMORY/LEARNING/SYNTHESIS/memories.jsonl");
    const valid = {
      schemaVersion: 1,
      id: fixedId,
      kind: "note",
      content: "text",
      source: "test",
      confidence: 1,
      userConfirmed: false,
      createdAt: "2026-08-05T12:00:00.000Z",
    };
    writeFileSync(path, `${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`);
    expect(() => readMemoryRecords(dataRoot)).toThrow("Duplicate MEMORY record id");
  });
});
