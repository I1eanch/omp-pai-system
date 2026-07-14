import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack, type Pack } from "tar-stream";
import {
  assertArchiveOutsideDataRoot,
  atomicArchivePaths,
  commitArchive,
  ensureArchiveParent,
  fileSize,
  listPrivateFiles,
  safeLocalPath,
  sha256File,
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

export async function exportPrivateState(
  input: ExportPrivateStateInput,
): Promise<ExportPrivateStateReport> {
  assertArchiveOutsideDataRoot(input.dataRoot, input.archivePath);
  const { target, temporary } = atomicArchivePaths(input.archivePath);
  const targetInfo = lstatSync(target, { throwIfNoEntry: false });
  if (targetInfo?.isSymbolicLink()) {
    throw new Error("Refusing archive destination symlink");
  }
  if (targetInfo) {
    throw new Error(`Archive already exists: ${target}`);
  }

  ensureArchiveParent(target);
  const stagingRoot = mkdtempSync(join(dirname(target), ".omp-pai-export-"));
  const manifest: PrivateBundleManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    files: [],
  };
  const stagedFiles: Array<{ archivePath: string; path: string; size: number }> = [];

  try {
    const sourceFiles = listPrivateFiles(input.dataRoot);
    for (const source of sourceFiles) {
      const stagedPath = safeLocalPath(stagingRoot, source.path);
      mkdirSync(dirname(stagedPath), { recursive: true });
      copyFileSync(source.absolutePath, stagedPath);
      manifest.files.push({
        path: source.path,
        size: fileSize(stagedPath),
        sha256: await sha256File(stagedPath),
      });
      stagedFiles.push({
        archivePath: `data/${source.path}`,
        path: stagedPath,
        size: fileSize(stagedPath),
      });
    }
    const archive = pack();
    const archiveWrite = pipeline(
      archive,
      createGzip({ level: 9 }),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
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
    commitArchive(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  return {
    archivePath: target,
    archiveSha256: await sha256File(target),
    fileCount: manifest.files.length,
  };
}
