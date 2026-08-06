import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initializePaiState } from "../../src/commands/init.ts";
import {
  assertSafePrivatePath,
  commitArchive,
  fileIdentity,
  fileSize,
  isPrivateBundleManifest,
  listPrivateFiles,
  safeLocalPath,
} from "../../src/private-bundle.ts";
import { readMemoryRecords, recordMemory } from "../../src/state/memory.ts";
import { parsePrd } from "../../src/state/prd.ts";
import {
  atomicWriteStateText,
  ensureSafeStateDirectory,
  readStateText,
  resolveStatePath,
  stateFileMode,
} from "../../src/state/safe-state.ts";
import { appendTelosEntry, parseTelosRecord, readTelosRecords } from "../../src/state/telos.ts";

const packageRoot = resolve(import.meta.dir, "../..");
const roots: string[] = [];

function root(label: string): string {
  const value = mkdtempSync(join(tmpdir(), `omp-pai-errors-${label}-`));
  roots.push(value);
  return value;
}

function initialized(label: string): string {
  const dataRoot = join(root(label), "pai");
  initializePaiState({ pluginRoot: packageRoot, dataRoot });
  return dataRoot;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("safe state error contracts", () => {
  test("rejects invalid paths, parents, reads, and destinations", async () => {
    const dataRoot = root("safe");
    expect(() => resolveStatePath(dataRoot, "")).toThrow("non-empty");
    expect(() => resolveStatePath(dataRoot, "x\0y")).toThrow("NUL");
    expect(() => resolveStatePath(dataRoot, "../escape")).toThrow("escapes");

    const fileRoot = join(dataRoot, "file-root");
    writeFileSync(fileRoot, "x");
    expect(() => ensureSafeStateDirectory(fileRoot, "child")).toThrow("must be a directory");
    const stateRoot = join(dataRoot, "state");
    mkdirSync(stateRoot, { mode: 0o700 });
    writeFileSync(join(stateRoot, "parent"), "x");
    expect(() => ensureSafeStateDirectory(stateRoot, "parent/child")).toThrow("parent");
    expect(() => readStateText(stateRoot, "missing")).toThrow("missing");
    writeFileSync(join(stateRoot, "large"), "12345");
    expect(() => readStateText(stateRoot, "large", 2)).toThrow("exceeds");
    mkdirSync(join(stateRoot, "destination"));
    expect(() => atomicWriteStateText(stateRoot, "destination", "x")).toThrow("not a file");

    const raceRoot = join(dataRoot, "atomic-race");
    mkdirSync(raceRoot, { mode: 0o700 });
    const replacementScript = `
      const fs = require("node:fs");
      const root = process.argv[1];
      while (true) {
        const temporary = fs.readdirSync(root).find((name) => name.startsWith("target.tmp-"));
        if (temporary) {
          const candidate = root + "/" + temporary;
          fs.unlinkSync(candidate);
          fs.writeFileSync(candidate, "replacement");
          break;
        }
      }
    `;
    const replacement = Bun.spawn(
      [process.execPath, "-e", replacementScript, raceRoot],
      { stdout: "ignore", stderr: "pipe" },
    );
    expect(() => atomicWriteStateText(raceRoot, "target", "x".repeat(32 * 1024 * 1024)))
      .toThrow("temporary file changed");
    expect(await replacement.exited).toBe(0);
    const replacementPath = readdirSync(raceRoot).find((name) => name.startsWith("target.tmp-"));
    expect(readFileSync(join(raceRoot, replacementPath!), "utf8")).toBe("replacement");

    const destinationRaceRoot = join(dataRoot, "destination-race");
    mkdirSync(destinationRaceRoot, { mode: 0o700 });
    const destinationScript = `
      const fs = require("node:fs");
      const root = process.argv[1];
      while (!fs.readdirSync(root).some((name) => name.startsWith("target.tmp-"))) {}
      fs.mkdirSync(root + "/target");
    `;
    const destinationWriter = Bun.spawn(
      [process.execPath, "-e", destinationScript, destinationRaceRoot],
      { stdout: "ignore", stderr: "pipe" },
    );
    expect(() => atomicWriteStateText(destinationRaceRoot, "target", "x".repeat(32 * 1024 * 1024)))
      .toThrow("became unsafe");
    expect(await destinationWriter.exited).toBe(0);

    if (process.platform === "linux") {
      const growing = join(stateRoot, "growing");
      writeFileSync(growing, Buffer.alloc(64 * 1024 * 1024, 1), { mode: 0o600 });
      const ready = join(dataRoot, "reader-ready");
      const growerScript = `
        const fs = require("node:fs");
        const pid = process.argv[1];
        const target = process.argv[2];
        fs.writeFileSync(process.argv[3], "ready");
        while (true) {
          for (const fd of fs.readdirSync("/proc/" + pid + "/fd")) {
            try {
              if (fs.readlinkSync("/proc/" + pid + "/fd/" + fd) !== target) continue;
              const info = fs.readFileSync("/proc/" + pid + "/fdinfo/" + fd, "utf8");
              const position = Number(info.match(/^pos:\\s+(\\d+)/m)?.[1] ?? 0);
              if (position > 0) {
                fs.appendFileSync(target, Buffer.alloc(1024 * 1024, 2));
                process.exit(0);
              }
            } catch {}
          }
        }
      `;
      const grower = Bun.spawn(
        [process.execPath, "-e", growerScript, String(process.pid), growing, ready],
        { stdout: "ignore", stderr: "pipe" },
      );
      while (!existsSync(ready)) {}
      expect(() => readStateText(
        stateRoot,
        "growing",
        64 * 1024 * 1024 + 512 * 1024,
      )).toThrow("exceeds");
      expect(await grower.exited).toBe(0);
    }
  });

  test("reports file modes for absent, unsafe, and regular paths", () => {
    const dataRoot = root("modes");
    expect(stateFileMode(dataRoot, "missing")).toBeNull();
    mkdirSync(join(dataRoot, "directory"));
    expect(stateFileMode(dataRoot, "directory")).toBe(-1);
    const target = join(dataRoot, "target");
    writeFileSync(target, "x", { mode: 0o600 });
    symlinkSync(target, join(dataRoot, "link"));
    expect(stateFileMode(dataRoot, "link")).toBe(-1);
    expect(stateFileMode(dataRoot, "target")).toBe(0o600);
  });
});

describe("state parser error contracts", () => {
  test("rejects malformed, duplicate, and unsafe MEMORY records", () => {
    const dataRoot = initialized("memory");
    const recordsPath = join(dataRoot, "MEMORY/LEARNING/SYNTHESIS/memories.jsonl");
    mkdirSync(dirname(recordsPath), { recursive: true });
    writeFileSync(recordsPath, "not-json\n", { mode: 0o600 });
    expect(() => readMemoryRecords(dataRoot)).toThrow("line 1");
    rmSync(recordsPath);
    expect(() => recordMemory(dataRoot, {
      kind: "lesson",
      content: "x",
      source: "",
      confidence: 1,
      userConfirmed: false,
    })).toThrow("source");
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const input = {
      kind: "lesson" as const,
      content: "unique",
      source: "test",
      confidence: 1,
      userConfirmed: false,
      id,
    };
    recordMemory(dataRoot, input);
    expect(() => recordMemory(dataRoot, input)).toThrow("Duplicate");
    const persisted = JSON.parse(readFileSync(recordsPath, "utf8")) as Record<string, unknown>;
    persisted.extra = true;
    writeFileSync(recordsPath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    expect(() => readMemoryRecords(dataRoot)).toThrow("Invalid MEMORY record");
    delete persisted.extra;
    persisted.content = "x".repeat(32 * 1024 + 1);
    writeFileSync(recordsPath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    expect(() => readMemoryRecords(dataRoot)).toThrow("Invalid MEMORY record");
    persisted.content = "personal";
    persisted.kind = "fact";
    persisted.userConfirmed = false;
    writeFileSync(recordsPath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    expect(() => readMemoryRecords(dataRoot)).toThrow("Invalid MEMORY record");
    rmSync(recordsPath);
    mkdirSync(recordsPath);
    expect(() => recordMemory(dataRoot, { ...input, id: "123e4567-e89b-42d3-a456-426614174001" }))
      .toThrow();
  });

  test("rejects TELOS and PRD schema mismatches", () => {
    expect(() => parseTelosRecord("---\nschema_version: 1\n---\n## Entries\n", "x"))
      .toThrow("frontmatter fields");
    expect(() => parseTelosRecord("---\nschema_version: 1\nrecord_type: goals\nstatus: active\nupdated: never\n---\n## Entries\n", "x"))
      .toThrow("timestamp");
    const dataRoot = initialized("telos");
    const goalsPath = join(dataRoot, "TELOS/GOALS.md");
    writeFileSync(goalsPath, "---\nschema_version: 1\nrecord_type: ideas\nstatus: active\nupdated: null\n---\n## Entries\n", { mode: 0o600 });
    expect(() => readTelosRecords(dataRoot)).toThrow("does not match filename");
    expect(() => appendTelosEntry(dataRoot, "goals", "x")).toThrow("does not match filename");
    expect(() => parsePrd("---\ntask: missing fields\n---\n", "PRD.md"))
      .toThrow("field slug is missing");
    expect(() => parsePrd(`---
task: invalid timestamp
slug: invalid-time
effort: standard
phase: build
progress: 0/0
mode: interactive
started: never
updated: 2026-08-05T00:00:00Z
---
`, "PRD.md")).toThrow("timestamp");
  });
});

describe("private bundle utility errors", () => {
  test("validates manifests and lexical paths", () => {
    expect(isPrivateBundleManifest(null)).toBe(false);
    expect(isPrivateBundleManifest({ schemaVersion: 1, createdAt: "now", files: [{}] })).toBe(false);
    expect(isPrivateBundleManifest({ schemaVersion: 1, createdAt: "now", files: [] })).toBe(true);
    for (const path of ["", "../x", "/x", "TELOS/../x", "OTHER/x", "TELOS\\x", "TELOS/x\0y"]) {
      expect(() => assertSafePrivatePath(path)).toThrow("Unsafe");
    }
    expect(() => safeLocalPath("/tmp/root", "../escape")).toThrow("escapes");
  });

  test("rejects unsafe roots and non-regular private entries", () => {
    const fileRoot = join(root("bundle-file"), "pai");
    writeFileSync(fileRoot, "x");
    expect(() => listPrivateFiles(fileRoot)).toThrow("not a directory");

    const dataRoot = join(root("bundle-tree"), "pai");
    mkdirSync(dataRoot);
    writeFileSync(join(dataRoot, "TELOS"), "x");
    expect(() => listPrivateFiles(dataRoot)).toThrow("not a directory");
    rmSync(join(dataRoot, "TELOS"));
    mkdirSync(join(dataRoot, "TELOS"));
    const fifo = join(dataRoot, "TELOS/fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    expect(() => listPrivateFiles(dataRoot)).toThrow("non-regular");
    rmSync(join(dataRoot, "TELOS"), { recursive: true });
    const outside = root("bundle-root-link");
    symlinkSync(outside, join(dataRoot, "TELOS"), "dir");
    expect(() => listPrivateFiles(dataRoot)).toThrow("source symlink");
  });

  test("reports size and both archive commit failures", () => {
    const directory = root("commit");
    const source = join(directory, "source");
    const target = join(directory, "target");
    writeFileSync(source, "abc");
    expect(fileSize(source)).toBe(3);
    writeFileSync(target, "occupied");
    expect(() => commitArchive(source, target)).toThrow("already exists");
    const identity = fileIdentity(source);
    expect(() => commitArchive(source, join(directory, "identity-mismatch"), {
      ...identity,
      birthtimeNs: identity.birthtimeNs + 1n,
    })).toThrow("changed before commit");
    expect(() => commitArchive(source, join(directory, "missing-parent/target")))
      .toThrow();
    expect(() => commitArchive(join(directory, "missing"), join(directory, "new"))).toThrow();
    chmodSync(target, 0o600);
  });
});
