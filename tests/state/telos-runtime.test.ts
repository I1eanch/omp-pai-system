import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initializePaiState } from "../../src/commands/init.ts";
import {
  appendTelosEntry,
  parseTelosRecord,
  queryTelos,
  readTelosRecords,
} from "../../src/state/telos.ts";

const packageRoot = resolve(import.meta.dir, "../..");
const roots: string[] = [];

function initializedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-pai-telos-runtime-"));
  roots.push(root);
  const dataRoot = join(root, "pai");
  initializePaiState({ pluginRoot: packageRoot, dataRoot });
  return dataRoot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TELOS runtime", () => {
  test("reads and validates all initialized records", () => {
    const records = readTelosRecords(initializedRoot());
    expect(records).toHaveLength(7);
    expect(records.every(({ status }) => status === "starter")).toBe(true);
    expect(records.map(({ recordType }) => recordType).sort()).toContain("goals");
  });

  test("appends an active entry atomically and retrieves it by relevance", () => {
    const dataRoot = initializedRoot();
    const updated = "2026-08-05T12:00:00.000Z";
    const record = appendTelosEntry(
      dataRoot,
      "goals",
      "Оптимизировать OMP runtime для быстрых задач",
      updated,
    );
    expect(record.status).toBe("active");
    expect(record.updated).toBe(updated);
    expect(queryTelos(dataRoot, "OMP быстрых")).toEqual([{
      recordType: "goals",
      path: "TELOS/GOALS.md",
      text: "Оптимизировать OMP runtime для быстрых задач",
      score: 2,
    }]);
    expect(queryTelos(dataRoot, "", 1)).toHaveLength(1);
    expect(readFileSync(join(dataRoot, "TELOS/GOALS.md"), "utf8")).toContain("status: active");
  });

  test("rejects malformed records, unsafe files, and invalid writes", () => {
    expect(() => parseTelosRecord("missing", "TELOS/GOALS.md")).toThrow("frontmatter");
    expect(() => parseTelosRecord(
      "---\nschema_version: 2\nrecord_type: goals\nstatus: active\nupdated: null\n---\n\n## Entries\n",
      "TELOS/GOALS.md",
    )).toThrow("schema version");
    expect(() => parseTelosRecord(
      "---\nschema_version: 1\nrecord_type: unknown\nstatus: active\nupdated: null\n---\n\n## Entries\n",
      "TELOS/GOALS.md",
    )).toThrow("record type");

    const dataRoot = initializedRoot();
    expect(() => appendTelosEntry(dataRoot, "goals", " ")).toThrow("non-empty");
    expect(() => appendTelosEntry(dataRoot, "goals", "x", "invalid")).toThrow("timestamp");
    expect(() => queryTelos(dataRoot, "x", 0)).toThrow("limit");
    const goals = join(dataRoot, "TELOS/GOALS.md");
    rmSync(goals);
    const outside = join(dirname(dataRoot), "outside.md");
    writeFileSync(outside, "outside");
    symlinkSync(outside, goals);
    expect(() => readTelosRecords(dataRoot)).toThrow("unsafe");
  });
});

