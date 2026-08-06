import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";
import { pack, type Headers } from "tar-stream";
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content);
}

async function archiveEntries(path: string): Promise<Map<string, File>> {
  return new Bun.Archive(await Bun.file(path).bytes()).files();
}
async function writeTarGzip(path: string, entries: Record<string, Uint8Array | string>): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const archive = pack();
  const writing = pipeline(
    archive,
    createGzip({ level: 9 }),
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
  );
  for (const [name, value] of Object.entries(entries)) {
    const content = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    await new Promise<void>((resolveEntry, rejectEntry) => {
      archive.entry({ name, size: content.byteLength, type: "file" }, content, (error) => {
        if (error) rejectEntry(error);
        else resolveEntry();
      });
    });
  }
  archive.finalize();
  await writing;
}

async function writeTarEntries(
  path: string,
  entries: Array<{ name: string; content?: string; type?: Headers["type"]; size?: number }>,
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const archive = pack();
  const writing = pipeline(
    archive,
    createGzip({ level: 9 }),
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
  );
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    await new Promise<void>((resolveEntry, rejectEntry) => {
      archive.entry({
        name: entry.name,
        size: entry.size ?? content.byteLength,
        type: entry.type ?? "file",
      }, content, (error) => {
        if (error) rejectEntry(error);
        else resolveEntry();
      });
    });
  }
  archive.finalize();
  await writing;
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
    expect(statSync(join(targetRoot, "TELOS/GOALS.md")).mode & 0o777).toBe(0o600);
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
    const hardlink = join(cleanDataRoot, "TELOS/hardlink.txt");
    linkSync(outside, hardlink);
    await expect(exportPrivateState({
      dataRoot: cleanDataRoot,
      archivePath: join(temporaryRoot("hardlink-archive"), "state.tar.gz"),
    })).rejects.toThrow("unsafe source");
    unlinkSync(hardlink);
    const archiveAlias = join(temporaryRoot("archive-parent-link"), "inside");
    symlinkSync(join(cleanDataRoot, "MEMORY"), archiveAlias, "dir");
    await expect(exportPrivateState({
      dataRoot: cleanDataRoot,
      archivePath: join(archiveAlias, "nested.tar.gz"),
    })).rejects.toThrow("outside data root");
    chmodSync(cleanDataRoot, 0o755);
    await expect(exportPrivateState({
      dataRoot: cleanDataRoot,
      archivePath: join(temporaryRoot("broad-root-archive"), "state.tar.gz"),
    })).rejects.toThrow("unsafe private data root");
    chmodSync(cleanDataRoot, 0o700);
    chmodSync(join(cleanDataRoot, "MEMORY/RAW"), 0o755);
    writeFixture(join(cleanDataRoot, "MEMORY/RAW/private.txt"), "private");
    await expect(exportPrivateState({
      dataRoot: cleanDataRoot,
      archivePath: join(temporaryRoot("broad-parent-archive"), "state.tar.gz"),
    })).rejects.toThrow("broadly accessible");
    chmodSync(join(cleanDataRoot, "MEMORY/RAW"), 0o700);
    const locked = join(cleanDataRoot, "TELOS/locked.txt");
    writeFixture(locked, "locked");
    chmodSync(locked, 0o000);
    await expect(exportPrivateState({
      dataRoot: cleanDataRoot,
      archivePath: join(temporaryRoot("unreadable-source-archive"), "state.tar.gz"),
    })).rejects.toThrow("Refusing unsafe source");
    chmodSync(locked, 0o600);

    const ownerArchive = join(temporaryRoot("owner-archive"), "state.tar.gz");
    await exportPrivateState({ dataRoot: cleanDataRoot, archivePath: ownerArchive });
    const getuid = process.getuid!;
    process.getuid = (() => getuid() + 1) as typeof process.getuid;
    try {
      await expect(exportPrivateState({
        dataRoot: cleanDataRoot,
        archivePath: join(temporaryRoot("unowned-source-archive"), "state.tar.gz"),
      })).rejects.toThrow("not owned");
    } finally {
      process.getuid = getuid;
    }
    const sentinel = join(temporaryRoot("sentinel"), "sentinel.txt");
    writeFixture(sentinel, "do not replace\n");
    const linkedArchive = join(temporaryRoot("linked-archive"), "state.tar.gz");
    symlinkSync(sentinel, linkedArchive);
    await expect(exportPrivateState({
      dataRoot: cleanDataRoot,
      archivePath: linkedArchive,
    })).rejects.toThrow("archive destination symlink");
    expect(readFileSync(sentinel, "utf8")).toBe("do not replace\n");
    const occupiedArchive = join(temporaryRoot("occupied-archive"), "state.tar.gz");
    writeFixture(occupiedArchive, "occupied");
    await expect(exportPrivateState({
      dataRoot: cleanDataRoot,
      archivePath: occupiedArchive,
    })).rejects.toThrow("already exists");
    const insideArchive = join(cleanDataRoot, "MEMORY/incoming.tar.gz");
    await writeTarGzip(insideArchive, {
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-08-05T00:00:00Z",
        files: [],
      }),
    });
    await expect(importPrivateState({
      dataRoot: cleanDataRoot,
      archivePath: insideArchive,
    })).rejects.toThrow("outside data root");
  });

  test("rejects checksum tampering before writing any target file", async () => {
    const sourceRoot = join(temporaryRoot("tamper-source"), "pai");
    initializePaiState({ pluginRoot: packageRoot, dataRoot: sourceRoot });
    writeFixture(join(sourceRoot, "TELOS/GOALS.md"), "authentic\n");
    const archivePath = join(temporaryRoot("tamper-archive"), "state.tar.gz");
    await exportPrivateState({ dataRoot: sourceRoot, archivePath });

    const originalEntries = await archiveEntries(archivePath);
    const tamperedEntries: Record<string, Uint8Array> = {};
    for (const [path, file] of originalEntries) {
      tamperedEntries[path] = path === "data/TELOS/GOALS.md"
        ? new TextEncoder().encode("corrupted\n")
        : new Uint8Array(await file.arrayBuffer());
    }
    const tamperedPath = join(temporaryRoot("tampered"), "state.tar.gz");
    await writeTarGzip(tamperedPath, tamperedEntries);
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
    await writeTarGzip(traversalPath, {
      "manifest.json": traversalManifest,
      "data/escape.txt": "x",
    });
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
  test("enforces compressed, file, count, and configuration limits", async () => {
    const sourceRoot = join(temporaryRoot("limits-source"), "pai");
    writeFixture(join(sourceRoot, "TELOS/a.txt"), "1234");
    writeFixture(join(sourceRoot, "MEMORY/b.txt"), "5678");
    const archivePath = join(temporaryRoot("limits-archive"), "state.tar.gz");
    await exportPrivateState({ dataRoot: sourceRoot, archivePath });

    await expect(importPrivateState({
      dataRoot: join(temporaryRoot("compressed-limit"), "pai"),
      archivePath,
      limits: { archiveBytes: 1 },
    })).rejects.toThrow("archive exceeds");
    await expect(importPrivateState({
      dataRoot: join(temporaryRoot("file-limit"), "pai"),
      archivePath,
      limits: { fileBytes: 3 },
    })).rejects.toThrow("file exceeds");
    await expect(importPrivateState({
      dataRoot: join(temporaryRoot("count-limit"), "pai"),
      archivePath,
      limits: { files: 1 },
    })).rejects.toThrow("file limit");
    await expect(importPrivateState({
      dataRoot: join(temporaryRoot("invalid-limit"), "pai"),
      archivePath,
      limits: { totalBytes: 0 },
    })).rejects.toThrow("must be a positive safe integer");
    await expect(importPrivateState({
      dataRoot: join(temporaryRoot("unsafe-derived-limit"), "pai"),
      archivePath,
      limits: {
        manifestBytes: Number.MAX_SAFE_INTEGER,
        totalBytes: Number.MAX_SAFE_INTEGER,
        files: Number.MAX_SAFE_INTEGER,
      },
    })).rejects.toThrow("unsafe expanded archive bound");
  });

  test("fails if a source disappears or changes during its export snapshot", async () => {
    const disappearingRoot = join(temporaryRoot("disappearing-source"), "pai");
    writeFixture(join(disappearingRoot, "TELOS/a-large.bin"), Buffer.alloc(8 * 1024 * 1024, 1));
    const disappearing = join(disappearingRoot, "TELOS/z-disappears.txt");
    writeFixture(disappearing, "remove me");
    const disappearingExport = exportPrivateState({
      dataRoot: disappearingRoot,
      archivePath: join(temporaryRoot("disappearing-archive"), "state.tar.gz"),
    });
    rmSync(disappearing);
    await expect(disappearingExport).rejects.toThrow("unsafe source");

    const changingRoot = join(temporaryRoot("changing-source"), "pai");
    const changing = join(changingRoot, "TELOS/large.bin");
    writeFixture(changing, Buffer.alloc(16 * 1024 * 1024, 2));
    const archiveRoot = temporaryRoot("changing-archive");
    const watcherScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      const source = process.argv[1];
      const parent = process.argv[2];
      while (true) {
        const staging = fs.readdirSync(parent).find((name) => name.startsWith(".omp-pai-export-"));
        if (staging) {
          const snapshot = path.join(parent, staging, "TELOS/large.bin");
          try {
            if (fs.statSync(snapshot).size > 0) {
              fs.appendFileSync(source, "changed");
              break;
            }
          } catch {}
        }
      }
    `;
    const watcher = Bun.spawn(
      [process.execPath, "-e", watcherScript, changing, archiveRoot],
      { stdout: "ignore", stderr: "pipe" },
    );
    await expect(exportPrivateState({
      dataRoot: changingRoot,
      archivePath: join(archiveRoot, "state.tar.gz"),
    })).rejects.toThrow("changed during export");
    expect(await watcher.exited).toBe(0);

    const replacedRoot = join(temporaryRoot("replaced-source"), "pai");
    const replaced = join(replacedRoot, "TELOS/large.bin");
    writeFixture(replaced, Buffer.alloc(16 * 1024 * 1024, 4));
    const replacedArchiveRoot = temporaryRoot("replaced-source-archive");
    const replacementScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      const source = process.argv[1];
      const parent = process.argv[2];
      while (true) {
        const staging = fs.readdirSync(parent).find((name) => name.startsWith(".omp-pai-export-"));
        if (!staging) continue;
        const snapshot = path.join(parent, staging, "TELOS/large.bin");
        try {
          if (fs.statSync(snapshot).size > 0) {
            fs.unlinkSync(source);
            fs.writeFileSync(source, Buffer.alloc(16 * 1024 * 1024, 5));
            break;
          }
        } catch {}
      }
    `;
    const replacement = Bun.spawn(
      [process.execPath, "-e", replacementScript, replaced, replacedArchiveRoot],
      { stdout: "ignore", stderr: "pipe" },
    );
    await expect(exportPrivateState({
      dataRoot: replacedRoot,
      archivePath: join(replacedArchiveRoot, "state.tar.gz"),
    })).rejects.toThrow("changed during export");
    expect(await replacement.exited).toBe(0);
  });

  test("rejects malformed archive structure and manifest contracts", async () => {
    const target = () => join(temporaryRoot("malformed-target"), "pai");
    const archive = async (
      label: string,
      entries: Array<{ name: string; content?: string; type?: Headers["type"]; size?: number }>,
    ): Promise<string> => {
      const path = join(temporaryRoot(label), "state.tar.gz");
      await writeTarEntries(path, entries);
      return path;
    };
    const emptyManifest = JSON.stringify({
      schemaVersion: 1,
      createdAt: "2026-08-05T00:00:00Z",
      files: [],
    });

    await expect(importPrivateState({
      dataRoot: target(),
      archivePath: await archive("entry-type", [{ name: "directory", type: "directory" }]),
    })).rejects.toThrow("entry type");
    await expect(importPrivateState({
      dataRoot: target(),
      archivePath: await archive("duplicate-entry", [
        { name: "manifest.json", content: emptyManifest },
        { name: "manifest.json", content: emptyManifest },
      ]),
    })).rejects.toThrow("Duplicate archive entry");
    await expect(importPrivateState({
      dataRoot: target(),
      archivePath: await archive("unexpected-entry", [
        { name: "manifest.json", content: emptyManifest },
        { name: "other.txt", content: "x" },
      ]),
    })).rejects.toThrow("Unexpected archive entry");
    await expect(importPrivateState({
      dataRoot: target(),
      archivePath: await archive("manifest-size", [
        { name: "manifest.json", content: emptyManifest },
      ]),
      limits: { manifestBytes: 1 },
    })).rejects.toThrow("manifest exceeds");
    await expect(importPrivateState({
      dataRoot: target(),
      archivePath: await archive("invalid-manifest", [
        { name: "manifest.json", content: "{}" },
      ]),
    })).rejects.toThrow("manifest is invalid");
    await expect(importPrivateState({
      dataRoot: target(),
      archivePath: await archive("invalid-timestamp", [
        { name: "manifest.json", content: JSON.stringify({
          schemaVersion: 1,
          createdAt: "never",
          files: [],
        }) },
      ]),
    })).rejects.toThrow("timestamp");
    await expect(importPrivateState({
      dataRoot: target(),
      archivePath: await archive("manifest-count", [
        { name: "manifest.json", content: JSON.stringify({
          schemaVersion: 1,
          createdAt: "2026-08-05T00:00:00Z",
          files: [
            { path: "TELOS/a", size: 0, sha256: "0".repeat(64) },
            { path: "TELOS/b", size: 0, sha256: "0".repeat(64) },
          ],
        }) },
      ]),
      limits: { files: 1 },
    })).rejects.toThrow("manifest exceeds");
    await expect(importPrivateState({
      dataRoot: target(),
      archivePath: await archive("duplicate-manifest", [
        { name: "manifest.json", content: JSON.stringify({
          schemaVersion: 1,
          createdAt: "2026-08-05T00:00:00Z",
          files: [
            {
              path: "TELOS/a",
              size: 1,
              sha256: new Bun.CryptoHasher("sha256").update("x").digest("hex"),
            },
            {
              path: "TELOS/a",
              size: 1,
              sha256: new Bun.CryptoHasher("sha256").update("x").digest("hex"),
            },
          ],
        }) },
        { name: "data/TELOS/a", content: "x" },
      ]),
    })).rejects.toThrow("Duplicate manifest path");
    await expect(importPrivateState({
      dataRoot: target(),
      archivePath: await archive("size-mismatch", [
        { name: "manifest.json", content: JSON.stringify({
          schemaVersion: 1,
          createdAt: "2026-08-05T00:00:00Z",
          files: [{ path: "TELOS/a", size: 2, sha256: "0".repeat(64) }],
        }) },
        { name: "data/TELOS/a", content: "x" },
      ]),
    })).rejects.toThrow("Size mismatch");
    await expect(importPrivateState({
      dataRoot: target(),
      archivePath: await archive("extra-data", [
        { name: "manifest.json", content: emptyManifest },
        { name: "data/TELOS/a", content: "x" },
      ]),
    })).rejects.toThrow("Unexpected archive entry");
  });

  test("enforces aggregate limits and normalizes missing archive errors", async () => {
    const manifest = JSON.stringify({
      schemaVersion: 1,
      createdAt: "2026-08-05T00:00:00Z",
      files: [
        {
          path: "TELOS/a",
          size: 4,
          sha256: new Bun.CryptoHasher("sha256").update("1234").digest("hex"),
        },
        {
          path: "MEMORY/b",
          size: 4,
          sha256: new Bun.CryptoHasher("sha256").update("5678").digest("hex"),
        },
      ],
    });
    const archivePath = join(temporaryRoot("aggregate"), "state.tar.gz");
    await writeTarGzip(archivePath, {
      "manifest.json": manifest,
      "data/TELOS/a": "1234",
      "data/MEMORY/b": "5678",
    });
    await expect(importPrivateState({
      dataRoot: join(temporaryRoot("aggregate-target"), "pai"),
      archivePath,
      limits: { fileBytes: 10, totalBytes: 6 },
    })).rejects.toThrow("uncompressed byte limit");
    const expandedArchive = join(temporaryRoot("expanded"), "state.tar.gz");
    const emptyTarArchive = join(temporaryRoot("expanded-source"), "empty.tar.gz");
    await writeTarGzip(emptyTarArchive, {
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-08-05T00:00:00Z",
        files: [],
      }),
    });
    const expanded = Buffer.concat([
      gunzipSync(readFileSync(emptyTarArchive)),
      Buffer.alloc(5 * 1024 * 1024),
    ]);
    writeFileSync(expandedArchive, gzipSync(expanded));
    await expect(importPrivateState({
      dataRoot: join(temporaryRoot("expanded-target"), "pai"),
      archivePath: expandedArchive,
      limits: { totalBytes: 1, files: 1 },
    })).rejects.toThrow("expanded byte limit");
    await expect(importPrivateState({
      dataRoot: join(temporaryRoot("missing-target"), "pai"),
      archivePath: join(temporaryRoot("missing-archive"), "missing.tar.gz"),
    })).rejects.toThrow("existing regular file");
  });

  test("rolls back files and preserves a concurrent writer on commit conflict", async () => {
    const first = Buffer.alloc(24 * 1024 * 1024, 1);
    const second = Buffer.alloc(24 * 1024 * 1024, 2);
    const manifest = JSON.stringify({
      schemaVersion: 1,
      createdAt: "2026-08-05T00:00:00Z",
      files: [
        {
          path: "TELOS/a.bin",
          size: first.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(first).digest("hex"),
        },
        {
          path: "MEMORY/b.bin",
          size: second.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(second).digest("hex"),
        },
      ],
    });
    const archivePath = join(temporaryRoot("rollback-archive"), "state.tar.gz");
    await writeTarGzip(archivePath, {
      "manifest.json": manifest,
      "data/TELOS/a.bin": first,
      "data/MEMORY/b.bin": second,
    });
    const dataRoot = join(temporaryRoot("rollback-target"), "pai");
    const watcherScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      const root = process.argv[1];
      const first = path.join(root, "TELOS/a.bin");
      while (!fs.existsSync(first)) {}
      fs.unlinkSync(first);
      fs.writeFileSync(first, "replacement");
      fs.mkdirSync(path.join(root, "MEMORY"), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(root, "MEMORY/b.bin"), "concurrent");
    `;
    const watcher = Bun.spawn(
      [process.execPath, "-e", watcherScript, dataRoot],
      { stdout: "ignore", stderr: "pipe" },
    );
    await expect(importPrivateState({ dataRoot, archivePath })).rejects.toThrow();
    expect(await watcher.exited).toBe(0);
    expect(readFileSync(join(dataRoot, "TELOS/a.bin"), "utf8")).toBe("replacement");
    expect(readFileSync(join(dataRoot, "MEMORY/b.bin"), "utf8")).toBe("concurrent");
  });

  test("blocks a parent-directory swap before import commit", async () => {
    const content = Buffer.alloc(24 * 1024 * 1024, 3);
    const archivePath = join(temporaryRoot("parent-swap-archive"), "state.tar.gz");
    await writeTarGzip(archivePath, {
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-08-05T00:00:00Z",
        files: [{
          path: "TELOS/a.bin",
          size: content.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
        }],
      }),
      "data/TELOS/a.bin": content,
    });
    const dataRoot = join(temporaryRoot("parent-swap-target"), "pai");
    const outside = temporaryRoot("parent-swap-outside");
    const watcherScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      const root = process.argv[1];
      const outside = process.argv[2];
      while (true) {
        if (fs.existsSync(root) && fs.readdirSync(root).some((name) => name.startsWith(".omp-pai-import-"))) {
          fs.renameSync(path.join(root, "TELOS"), path.join(root, "TELOS-original"));
          fs.symlinkSync(outside, path.join(root, "TELOS"), "dir");
          break;
        }
      }
    `;
    const watcher = Bun.spawn(
      [process.execPath, "-e", watcherScript, dataRoot, outside],
      { stdout: "ignore", stderr: "pipe" },
    );
    await expect(importPrivateState({ dataRoot, archivePath }))
      .rejects.toThrow("unsafe parent");
    expect(await watcher.exited).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
    expect(readdirSync(dataRoot).some((name) => name.startsWith(".omp-pai-import-")))
      .toBe(false);
  });


  test("rejects and preserves a replaced import temporary", async () => {
    const content = Buffer.alloc(24 * 1024 * 1024, 6);
    const archivePath = join(temporaryRoot("import-temp-archive"), "state.tar.gz");
    await writeTarGzip(archivePath, {
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-08-05T00:00:00Z",
        files: [{
          path: "TELOS/a.bin",
          size: content.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
        }],
      }),
      "data/TELOS/a.bin": content,
    });
    const dataRoot = join(temporaryRoot("import-temp-target"), "pai");
    const watcherScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      const root = process.argv[1];
      while (true) {
        if (!fs.existsSync(root)) continue;
        const temporary = fs.readdirSync(root).find((name) => name.startsWith(".omp-pai-import-"));
        if (temporary) {
          const candidate = path.join(root, temporary);
          fs.unlinkSync(candidate);
          fs.writeFileSync(candidate, "replacement");
          break;
        }
      }
    `;
    const watcher = Bun.spawn(
      [process.execPath, "-e", watcherScript, dataRoot],
      { stdout: "ignore", stderr: "pipe" },
    );
    await expect(importPrivateState({ dataRoot, archivePath }))
      .rejects.toThrow("temporary file changed during copy");
    expect(await watcher.exited).toBe(0);
    expect(existsSync(join(dataRoot, "TELOS/a.bin"))).toBe(false);
    const temporary = readdirSync(dataRoot).find((name) => name.startsWith(".omp-pai-import-"));
    expect(temporary).toBeDefined();
    expect(readFileSync(join(dataRoot, temporary!), "utf8")).toBe("replacement");
  });
  test("meters bytes appended while snapshotting an import archive", async () => {
    const content = randomBytes(48 * 1024 * 1024);
    const archivePath = join(temporaryRoot("growing-archive"), "state.tar.gz");
    await writeTarGzip(archivePath, {
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-08-05T00:00:00Z",
        files: [{
          path: "TELOS/random.bin",
          size: content.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
        }],
      }),
      "data/TELOS/random.bin": content,
    });
    const archiveBytes = statSync(archivePath).size;
    const existingImports = readdirSync(tmpdir()).filter((name) => name.startsWith("omp-pai-import-"));
    const watcherScript = `
      const fs = require("node:fs");
      const os = require("node:os");
      const known = new Set(JSON.parse(process.argv[2]));
      while (!fs.readdirSync(os.tmpdir()).some((name) => name.startsWith("omp-pai-import-") && !known.has(name))) {}
      fs.appendFileSync(process.argv[1], Buffer.alloc(16 * 1024 * 1024, 7));
    `;
    const watcher = Bun.spawn(
      [process.execPath, "-e", watcherScript, archivePath, JSON.stringify(existingImports)],
      { stdout: "ignore", stderr: "pipe" },
    );
    await expect(importPrivateState({
      dataRoot: join(temporaryRoot("growing-target"), "pai"),
      archivePath,
      limits: { archiveBytes: archiveBytes + 512 * 1024 },
    })).rejects.toThrow(/byte limit|changed during snapshot/u);
    expect(await watcher.exited).toBe(0);
    const grownBytes = statSync(archivePath).size;
    const knownImports = readdirSync(tmpdir()).filter((name) => name.startsWith("omp-pai-import-"));
    const secondWatcher = Bun.spawn(
      [process.execPath, "-e", watcherScript, archivePath, JSON.stringify(knownImports)],
      { stdout: "ignore", stderr: "pipe" },
    );
    await expect(importPrivateState({
      dataRoot: join(temporaryRoot("changed-snapshot-target"), "pai"),
      archivePath,
      limits: { archiveBytes: grownBytes + 32 * 1024 * 1024 },
    })).rejects.toThrow("changed during snapshot");
    expect(await secondWatcher.exited).toBe(0);
  });

  test("rejects a replaced export temporary without publishing attacker bytes", async () => {
    const dataRoot = join(temporaryRoot("export-temp-source"), "pai");
    writeFixture(join(dataRoot, "TELOS/large.bin"), randomBytes(24 * 1024 * 1024));
    const archiveRoot = temporaryRoot("export-temp-target");
    const archivePath = join(archiveRoot, "state.tar.gz");
    const watcherScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      const root = process.argv[1];
      while (true) {
        const temporary = fs.readdirSync(root).find((name) => name.startsWith(".state.tar.gz.tmp-"));
        if (temporary) {
          const candidate = path.join(root, temporary);
          fs.unlinkSync(candidate);
          fs.writeFileSync(candidate, "replacement");
          break;
        }
      }
    `;
    const watcher = Bun.spawn(
      [process.execPath, "-e", watcherScript, archiveRoot],
      { stdout: "ignore", stderr: "pipe" },
    );
    await expect(exportPrivateState({ dataRoot, archivePath }))
      .rejects.toThrow("temporary file changed");
    expect(await watcher.exited).toBe(0);
    expect(existsSync(archivePath)).toBe(false);
    expect(readdirSync(archiveRoot).some((name) => name.startsWith(".state.tar.gz.tmp-")))
      .toBe(true);
  });

});
