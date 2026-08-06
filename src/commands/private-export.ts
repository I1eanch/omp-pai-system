import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack, type Pack } from "tar-stream";
import {
  assertArchiveOutsideDataRoot,
  atomicArchivePaths,
  commitArchive,
  ensureArchiveParent,
  fileIdentity,
  listPrivateFiles,
  removeOwnedPath,
  safeLocalPath,
  type FileIdentity,
  type PrivateBundleManifest,
} from "../private-bundle.ts";

export type ExportPrivateStateInput = {
  dataRoot: string;
  archivePath: string;
};

export type ExportPrivateStateReport = {
  archivePath: string;
  archiveSha256: string;
  fileCount: number;
};

async function addFileEntry(
  archive: Pack,
  name: string,
  path: string,
  size: number,
): Promise<void> {
  const entry = archive.entry({
    name,
    size,
    mode: 0o600,
    uid: 0,
    gid: 0,
    uname: "",
    gname: "",
    mtime: new Date(0),
    type: "file",
  });
  await pipeline(createReadStream(path), entry);
}

function addBufferEntry(archive: Pack, name: string, content: Buffer): Promise<void> {
  return new Promise((resolveEntry, rejectEntry) => {
    archive.entry({
      name,
      size: content.byteLength,
      mode: 0o600,
      uid: 0,
      gid: 0,
      uname: "",
      gname: "",
      mtime: new Date(0),
      type: "file",
    }, content, (error) => {
      if (error) rejectEntry(error);
      else resolveEntry();
    });
  });
}

type SourceIdentity = { dev: number; ino: number };

function assertPrivateSource(
  dataRoot: string,
  privatePath: string,
  expected?: SourceIdentity,
): SourceIdentity {
  let current = resolve(dataRoot);
  const rootInfo = lstatSync(current, { throwIfNoEntry: false });
  if (
    !rootInfo?.isDirectory()
    || rootInfo.isSymbolicLink()
    || (rootInfo.mode & 0o077) !== 0
  ) {
    throw new Error("Refusing unsafe private data root");
  }
  const parts = privatePath.split("/");
  let index = 0;
  let sourceIdentity: SourceIdentity | undefined;
  while (!sourceIdentity) {
    const part = parts[index]!;
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    const isFinal = index === parts.length - 1;
    if (
      !info
      || info.isSymbolicLink()
      || (isFinal ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())
    ) {
      throw new Error(`Refusing unsafe source: ${privatePath}`);
    }
    if (!isFinal && (info.mode & 0o077) !== 0) {
      throw new Error(`Refusing broadly accessible source directory: ${privatePath}`);
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    // Ownership mismatch requires executing as another OS user.
    if (uid !== undefined && info.uid !== uid) {
      throw new Error(`Refusing source not owned by current user: ${privatePath}`);
    }
    if (
      isFinal
      && expected
      && (info.dev !== expected.dev || info.ino !== expected.ino)
    ) {
      throw new Error(`Private source changed during export: ${privatePath}`);
    }
    if (isFinal) {
      sourceIdentity = { dev: info.dev, ino: info.ino };
    } else {
      index += 1;
    }
  }
  return sourceIdentity;
}
async function snapshotRegularFile(
  dataRoot: string,
  sourcePath: string,
  stagedPath: string,
  privatePath: string,
): Promise<{ size: number; sha256: string }> {
  const listedIdentity = assertPrivateSource(dataRoot, privatePath);
  let handle;
  try {
    handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // TOCTOU guard: open can fail if an external writer wins after the preceding lstat.
    throw new Error(`Refusing unsafe source: ${privatePath}`, { cause: error });
  }
  try {
    const before = await handle.stat();
    const openedSourceChanged = (
      !before.isFile()
      || before.nlink !== 1
      || before.dev !== listedIdentity.dev
      || before.ino !== listedIdentity.ino
    );
    // TOCTOU guard: true only if an external writer wins between lstat and open.
    if (openedSourceChanged) throw new Error(`Refusing non-regular or changed source: ${privatePath}`);
    const hasher = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        size += chunk.byteLength;
        hasher.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      meter,
      createWriteStream(stagedPath, { flags: "wx", mode: 0o600 }),
    );
    const after = await handle.stat();
    assertPrivateSource(dataRoot, privatePath, { dev: after.dev, ino: after.ino });
    if (
      before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.nlink !== after.nlink
      || size !== after.size
    ) {
      throw new Error(`Private source changed during export: ${privatePath}`);
    }
    return { size, sha256: hasher.digest("hex") };
  } finally {
    await handle.close();
  }
}


/** Streams TELOS and MEMORY into a checksummed, no-overwrite private archive. */
export async function exportPrivateState(
  input: ExportPrivateStateInput,
): Promise<ExportPrivateStateReport> {
  const { target, temporary } = atomicArchivePaths(input.archivePath);
  ensureArchiveParent(target);
  assertArchiveOutsideDataRoot(input.dataRoot, target);
  const targetInfo = lstatSync(target, { throwIfNoEntry: false });
  if (targetInfo?.isSymbolicLink()) {
    throw new Error("Refusing archive destination symlink");
  }
  if (targetInfo) {
    throw new Error(`Archive already exists: ${target}`);
  }

  const stagingRoot = mkdtempSync(join(dirname(target), ".omp-pai-export-"));
  const manifest: PrivateBundleManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    files: [],
  };
  const stagedFiles: Array<{ archivePath: string; path: string; size: number }> = [];
  let archiveDescriptor: number | undefined;
  let archiveIdentity: FileIdentity | undefined;
  let archiveSha256 = "";

  try {
    const sourceFiles = listPrivateFiles(input.dataRoot);
    for (const source of sourceFiles) {
      const stagedPath = safeLocalPath(stagingRoot, source.path);
      mkdirSync(dirname(stagedPath), { recursive: true, mode: 0o700 });
      const snapshot = await snapshotRegularFile(
        input.dataRoot,
        source.absolutePath,
        stagedPath,
        source.path,
      );
      manifest.files.push({
        path: source.path,
        size: snapshot.size,
        sha256: snapshot.sha256,
      });
      stagedFiles.push({
        archivePath: `data/${source.path}`,
        path: stagedPath,
        size: snapshot.size,
      });
    }
    const archive = pack();
    archiveDescriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const openedArchive = fstatSync(archiveDescriptor, { bigint: true });
    archiveIdentity = {
      dev: openedArchive.dev,
      ino: openedArchive.ino,
      birthtimeNs: openedArchive.birthtimeNs,
    };
    const archiveHasher = createHash("sha256");
    let archiveBytes = 0;
    const archiveMeter = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        archiveBytes += chunk.byteLength;
        archiveHasher.update(chunk);
        callback(null, chunk);
      },
    });
    const archiveWrite = pipeline(
      archive,
      createGzip({ level: 9 }),
      archiveMeter,
      createWriteStream(temporary, { fd: archiveDescriptor, autoClose: false }),
    );
    await addBufferEntry(
      archive,
      "manifest.json",
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    );
    for (const staged of stagedFiles) {
      await addFileEntry(archive, staged.archivePath, staged.path, staged.size);
    }
    archive.finalize();
    await archiveWrite;
    fsyncSync(archiveDescriptor);
    const writtenArchive = fstatSync(archiveDescriptor);
    if (writtenArchive.size !== archiveBytes) throw new Error("Archive write size mismatch");
    const pathIdentity = fileIdentity(temporary);
    if (
      pathIdentity.dev !== archiveIdentity.dev
      || pathIdentity.ino !== archiveIdentity.ino
      || pathIdentity.birthtimeNs !== archiveIdentity.birthtimeNs
    ) {
      throw new Error("Archive temporary file changed during export");
    }
    archiveSha256 = archiveHasher.digest("hex");
    closeSync(archiveDescriptor);
    archiveDescriptor = undefined;
    commitArchive(temporary, target, archiveIdentity);
  } catch (error) {
    if (archiveDescriptor !== undefined) {
      closeSync(archiveDescriptor);
      archiveDescriptor = undefined;
    }
    if (archiveIdentity) removeOwnedPath(temporary, archiveIdentity);
    throw error;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  return {
    archivePath: target,
    archiveSha256,
    fileCount: manifest.files.length,
  };
}
