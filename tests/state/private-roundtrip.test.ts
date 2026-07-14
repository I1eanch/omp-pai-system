import { afterEach, describe, expect, test } from "bun:test";
import {
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
import { exportPrivateState } from "../../src/commands/private-export.ts";
import { importPrivateState } from "../../src/commands/private-import.ts";
import { initializePaiState } from "../../src/commands/init.ts";

const packageRoot = resolve(import.meta.dir, "../..");
const tempRoots: string[] = [];

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `omp-pai-${label}-`));
  tempRoots.push(root);
  return root;
}

function writeFixture(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function archiveEntries(path: string): Promise<Map<string, File>> {
  return new Bun.Archive(await Bun.file(path).bytes()).files();
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("private export/import", () => {
  test("round-trips TELOS and MEMORY with checksummed binary-safe contents", async () => {
    const sourceRoot = join(temporaryRoot("source"), "pai");
    initializePaiState({ pluginRoot: packageRoot, dataRoot: sourceRoot });
    writeFixture(join(sourceRoot, "TELOS/GOALS.md"), "private goals\n");
    writeFixture(join(sourceRoot, "MEMORY/WORK/session/PRD.md"), "# private work\n");
    writeFixture(join(sourceRoot, "MEMORY/RAW/blob.bin"), new Uint8Array([0, 1, 2, 255]));
    writeFixture(join(sourceRoot, "MEMORY/RAW/empty.txt"), "");
    writeFixture(join(sourceRoot, "PAI/ACTIONS/local.ts"), "must not export\n");
    const archivePath = join(temporaryRoot("archive"), "private-state.tar.gz");

    const exported = await exportPrivateState({ dataRoot: sourceRoot, archivePath });
    expect(exported.fileCount).toBeGreaterThan(4);
    expect(exported.archiveSha256).toMatch(/^[a-f0-9]{64}$/u);

    const entries = await archiveEntries(archivePath);
    expect(entries.has("manifest.json")).toBe(true);
    expect(entries.has("data/TELOS/GOALS.md")).toBe(true);
    expect(entries.has("data/MEMORY/RAW/empty.txt")).toBe(true);
    expect(entries.has("data/PAI/ACTIONS/local.ts")).toBe(false);

    const targetRoot = join(temporaryRoot("target"), "pai");
    const imported = await importPrivateState({ dataRoot: targetRoot, archivePath });
    expect(imported.imported).toBe(exported.fileCount);
    expect(readFileSync(join(targetRoot, "TELOS/GOALS.md"), "utf8")).toBe("private goals\n");
    expect(readFileSync(join(targetRoot, "MEMORY/RAW/blob.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect(readFileSync(join(targetRoot, "MEMORY/RAW/empty.txt"))).toHaveLength(0);
  });

  test("rejects source, destination, and archive-path symlinks", async () => {
    const dataRoot = join(temporaryRoot("unsafe-source"), "pai");
    initializePaiState({ pluginRoot: packageRoot, dataRoot });
    const outside = join(temporaryRoot("outside"), "secret.txt");
    writeFixture(outside, "secret\n");
    symlinkSync(outside, join(dataRoot, "TELOS/link.md"));

    const archiveRoot = temporaryRoot("archive");
    await expect(exportPrivateState({
      dataRoot,
      archivePath: join(archiveRoot, "state.tar.gz"),
    })).rejects.toThrow("Refusing source symlink");
    expect(readdirSync(archiveRoot).filter((name) => name.startsWith(".omp-pai-export-")))
      .toEqual([]);
    await expect(exportPrivateState({
      dataRoot,
      archivePath: join(dataRoot, "MEMORY/private-state.tar.gz"),
    })).rejects.toThrow("outside data root");

    const cleanDataRoot = join(temporaryRoot("clean-source"), "pai");
    initializePaiState({ pluginRoot: packageRoot, dataRoot: cleanDataRoot });
    const linkedDataRoot = join(temporaryRoot("linked-data-root"), "pai");
    symlinkSync(cleanDataRoot, linkedDataRoot);
    await expect(exportPrivateState({
      dataRoot: linkedDataRoot,
      archivePath: join(temporaryRoot("linked-data-archive"), "state.tar.gz"),
    })).rejects.toThrow("data root symlink");
    const sentinel = join(temporaryRoot("sentinel"), "sentinel.txt");
    writeFixture(sentinel, "do not replace\n");
    const linkedArchive = join(temporaryRoot("linked-archive"), "state.tar.gz");
    symlinkSync(sentinel, linkedArchive);
    await expect(exportPrivateState({
      dataRoot: cleanDataRoot,
      archivePath: linkedArchive,
    })).rejects.toThrow("archive destination symlink");
    expect(readFileSync(sentinel, "utf8")).toBe("do not replace\n");
  });

  test("rejects checksum tampering before writing any target file", async () => {
    const sourceRoot = join(temporaryRoot("tamper-source"), "pai");
    initializePaiState({ pluginRoot: packageRoot, dataRoot: sourceRoot });
    writeFixture(join(sourceRoot, "TELOS/GOALS.md"), "authentic\n");
    const archivePath = join(temporaryRoot("tamper-archive"), "state.tar.gz");
    await exportPrivateState({ dataRoot: sourceRoot, archivePath });

    const originalEntries = await archiveEntries(archivePath);
    const tamperedEntries: Record<string, Blob> = {};
    for (const [path, file] of originalEntries) {
      tamperedEntries[path] = path === "data/TELOS/GOALS.md"
        ? new Blob(["corrupted\n"])
        : file;
    }
    const tamperedPath = join(temporaryRoot("tampered"), "state.tar.gz");
    await Bun.write(tamperedPath, new Bun.Archive(tamperedEntries, { compress: "gzip" }));
    const targetRoot = join(temporaryRoot("tamper-target"), "pai");

    await expect(importPrivateState({ dataRoot: targetRoot, archivePath: tamperedPath }))
      .rejects.toThrow("Checksum mismatch");
    expect(existsSync(join(targetRoot, "TELOS/GOALS.md"))).toBe(false);
  });

  test("rejects traversal manifests and existing-file conflicts without overwrite", async () => {
    const traversalManifest = JSON.stringify({
      schemaVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      files: [{ path: "../escape.txt", size: 1, sha256: "0".repeat(64) }],
    });
    const traversalPath = join(temporaryRoot("traversal"), "state.tar.gz");
    await Bun.write(traversalPath, new Bun.Archive({
      "manifest.json": traversalManifest,
      "data/escape.txt": "x",
    }, { compress: "gzip" }));
    const traversalTarget = join(temporaryRoot("traversal-target"), "pai");
    await expect(importPrivateState({ dataRoot: traversalTarget, archivePath: traversalPath }))
      .rejects.toThrow("Unsafe manifest path");

    const sourceRoot = join(temporaryRoot("conflict-source"), "pai");
    initializePaiState({ pluginRoot: packageRoot, dataRoot: sourceRoot });
    writeFixture(join(sourceRoot, "TELOS/GOALS.md"), "from archive\n");
    const archivePath = join(temporaryRoot("conflict-archive"), "state.tar.gz");
    await exportPrivateState({ dataRoot: sourceRoot, archivePath });
    const targetRoot = join(temporaryRoot("conflict-target"), "pai");
    writeFixture(join(targetRoot, "TELOS/GOALS.md"), "keep local\n");

    await expect(importPrivateState({ dataRoot: targetRoot, archivePath }))
      .rejects.toThrow("Import conflict");
    expect(readFileSync(join(targetRoot, "TELOS/GOALS.md"), "utf8")).toBe("keep local\n");
  });
});
