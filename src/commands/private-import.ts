import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type TransformCallback } from "node:stream";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import {
  assertArchiveOutsideDataRoot,
  assertSafePrivatePath,
  destinationConflict,
  fileIdentity,
  isPrivateBundleManifest,
  removeOwnedPath,
  safeLocalPath,
  sha256File,
  type FileIdentity,
} from "../private-bundle.ts";
import { ensureSafeStateDirectory } from "../state/safe-state.ts";

export type PrivateImportLimits = {
  archiveBytes: number;
  manifestBytes: number;
  fileBytes: number;
  totalBytes: number;
  files: number;
};

type OwnedDirectory = FileIdentity & { path: string };

export type ImportPrivateStateInput = {
  dataRoot: string;
  archivePath: string;
  limits?: Partial<PrivateImportLimits>;
};

export type ImportPrivateStateReport = {
  archiveSha256: string;
  imported: number;
};

type StagedEntry = {
  path: string;
  stagedPath: string;
  size: number;
  sha256: string;
};

export const DEFAULT_PRIVATE_IMPORT_LIMITS: PrivateImportLimits = {
  archiveBytes: 512 * 1024 * 1024,
  manifestBytes: 4 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  files: 10_000,
};

function resolveImportLimits(overrides: Partial<PrivateImportLimits> | undefined): PrivateImportLimits {
  const limits = { ...DEFAULT_PRIVATE_IMPORT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Private import limit ${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function assertImportDirectory(path: string, privatePath: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (
    !info?.isDirectory()
    || info.isSymbolicLink()
    || (info.mode & 0o077) !== 0
  ) {
    throw new Error(`Import conflict: unsafe parent for ${privatePath}`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  // Ownership mismatch requires executing as another OS user.
  if (uid !== undefined && info.uid !== uid) throw new Error(`Import conflict: unowned parent for ${privatePath}`);
}

function assertSafeDestination(dataRoot: string, path: string): void {
  const root = resolve(dataRoot);
  const rootInfo = lstatSync(root, { throwIfNoEntry: false });
  if (rootInfo) {
    ensureSafeStateDirectory(dataRoot, ".");
    assertImportDirectory(root, path);
  }

  const parentParts = dirname(path).split("/").filter((part) => part && part !== ".");
  let current = root;
  for (const part of parentParts) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (info) assertImportDirectory(current, path);
  }
  if (destinationConflict(root, path)) {
    throw new Error(`Import conflict: ${path} already exists`);
  }
}

function ensureImportParents(
  dataRoot: string,
  path: string,
  createdDirectories: OwnedDirectory[],
): void {
  const root = resolve(dataRoot);
  const parentParts = dirname(path).split("/").filter((part) => part && part !== ".");
  const paths = [root];
  let current = root;
  for (const part of parentParts) {
    current = join(current, part);
    paths.push(current);
  }
  const missing = paths.filter((candidate) =>
    !lstatSync(candidate, { throwIfNoEntry: false })
  );
  ensureSafeStateDirectory(dataRoot, dirname(path));
  for (const candidate of missing) {
    const info = lstatSync(candidate, { bigint: true });
    createdDirectories.push({
      path: candidate,
      dev: info.dev,
      ino: info.ino,
      birthtimeNs: info.birthtimeNs,
    });
  }
}

function copyStagedFile(source: string, destination: string): FileIdentity {
  const sourceDescriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationDescriptor: number | undefined;
  let destinationIdentity: FileIdentity | undefined;
  try {
    const sourceInfo = fstatSync(sourceDescriptor);
    if (!sourceInfo.isFile()) throw new Error("Staged import source is not a regular file");
    destinationDescriptor = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(destinationDescriptor, { bigint: true });
    destinationIdentity = {
      dev: opened.dev,
      ino: opened.ino,
      birthtimeNs: opened.birthtimeNs,
    };
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        offset += writeSync(destinationDescriptor, buffer, offset, bytesRead - offset);
      }
    }
    fsyncSync(destinationDescriptor);
    const written = fstatSync(destinationDescriptor, { bigint: true });
    const identity = fileIdentity(destination);
    if (
      identity.dev !== written.dev
      || identity.ino !== written.ino
      || identity.birthtimeNs !== written.birthtimeNs
      || identity.dev !== destinationIdentity.dev
      || identity.ino !== destinationIdentity.ino
      || identity.birthtimeNs !== destinationIdentity.birthtimeNs
    ) {
      throw new Error("Import temporary file changed during copy");
    }
    return identity;
  } catch (error) {
    if (destinationDescriptor !== undefined) {
      closeSync(destinationDescriptor);
      destinationDescriptor = undefined;
    }
    if (destinationIdentity) removeOwnedPath(destination, destinationIdentity);
    throw error;
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    closeSync(sourceDescriptor);
  }
}

/** Verifies and imports a private archive atomically without overwriting state. */
export async function importPrivateState(
  input: ImportPrivateStateInput,
): Promise<ImportPrivateStateReport> {
  const limits = resolveImportLimits(input.limits);
  const expandedArchiveBytes = limits.totalBytes
    + limits.manifestBytes
    + (limits.files + 2) * 1024;
  if (!Number.isSafeInteger(expandedArchiveBytes)) {
    throw new Error("Private import limits produce an unsafe expanded archive bound");
  }
  assertArchiveOutsideDataRoot(input.dataRoot, input.archivePath);
  const source = resolve(input.archivePath);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-pai-import-"));
  const snapshotPath = join(temporaryRoot, basename(source));

  try {
    const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await sourceHandle.stat();
      if (!before.isFile()) throw new Error("Private archive must be an existing regular file");
      if (before.size > limits.archiveBytes) {
        throw new Error(`Private archive exceeds ${limits.archiveBytes} byte limit`);
      }
      let snapshotBytes = 0;
      const snapshotMeter = new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
          snapshotBytes += chunk.byteLength;
          if (snapshotBytes > limits.archiveBytes) {
            callback(new Error(`Private archive exceeds ${limits.archiveBytes} byte limit`));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        sourceHandle.createReadStream({ autoClose: false }),
        snapshotMeter,
        createWriteStream(snapshotPath, { flags: "wx", mode: 0o600 }),
      );
      const after = await sourceHandle.stat();
      if (
        snapshotBytes !== before.size
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
      ) {
        throw new Error("Private archive changed during snapshot");
      }
    } finally {
      await sourceHandle.close();
    }

    const archive = extract();
    let expandedBytes = 0;
    const expandedMeter = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        expandedBytes += chunk.byteLength;
        if (expandedBytes > expandedArchiveBytes) {
          callback(new Error(`Private archive exceeds ${expandedArchiveBytes} expanded byte limit`));
          return;
        }
        callback(null, chunk);
      },
    });
    const extraction = pipeline(
      createReadStream(snapshotPath),
      createGunzip(),
      expandedMeter,
      archive,
    );
    const seenArchivePaths = new Set<string>();
    const stagedEntries = new Map<string, StagedEntry>();
    let manifestPath: string | null = null;
    let totalBytes = 0;
    let fileCount = 0;
    let entryError: unknown;
    try {

    for await (const archiveEntry of archive) {
      const header = archiveEntry.header;
      if (header.type !== "file") {
        throw new Error(`Unsafe archive entry type: ${header.name}`);
      }
      if (seenArchivePaths.has(header.name)) {
        throw new Error(`Duplicate archive entry: ${header.name}`);
      }
      seenArchivePaths.add(header.name);
      fileCount += 1;
      if (fileCount > limits.files + 1) {
        throw new Error(`Private archive exceeds ${limits.files} file limit`);
      }

      if (header.name === "manifest.json") {
        const stagedManifest = safeLocalPath(temporaryRoot, "manifest.json");
        let manifestSize = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
            manifestSize += chunk.byteLength;
            if (manifestSize > limits.manifestBytes) {
              callback(new Error(`Private manifest exceeds ${limits.manifestBytes} byte limit`));
              return;
            }
            callback(null, chunk);
          },
        });
        await pipeline(
          archiveEntry,
          meter,
          createWriteStream(stagedManifest, { flags: "wx", mode: 0o600 }),
        );
        manifestPath = stagedManifest;
        continue;
      }

      if (!header.name.startsWith("data/")) {
        throw new Error(`Unexpected archive entry: ${header.name}`);
      }
      const privatePath = header.name.slice("data/".length);
      assertSafePrivatePath(privatePath);
      if (typeof header.size === "number" && header.size > limits.fileBytes) {
        throw new Error(`Private file exceeds ${limits.fileBytes} byte limit: ${privatePath}`);
      }

      const stagedPath = safeLocalPath(temporaryRoot, `data/${privatePath}`);
      mkdirSync(dirname(stagedPath), { recursive: true, mode: 0o700 });
      const hasher = createHash("sha256");
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
          size += chunk.byteLength;
          totalBytes += chunk.byteLength;
          if (totalBytes > limits.totalBytes) {
            callback(new Error(`Private archive exceeds ${limits.totalBytes} uncompressed byte limit`));
            return;
          }
          hasher.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        archiveEntry,
        meter,
        createWriteStream(stagedPath, { flags: "wx", mode: 0o600 }),
      );
      stagedEntries.set(privatePath, {
        path: privatePath,
        stagedPath,
        size,
        sha256: hasher.digest("hex"),
      });
    }
    } catch (error) {
      entryError = error;
      archive.destroy(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      await extraction;
    } catch (error) {
      entryError ??= error;
    }
    if (entryError) throw entryError;

    if (!manifestPath) throw new Error("Private archive manifest is missing");
    const parsedManifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!isPrivateBundleManifest(parsedManifest)) {
      throw new Error("Private archive manifest is invalid");
    }
    if (Number.isNaN(Date.parse(parsedManifest.createdAt))) {
      throw new Error("Private archive manifest timestamp is invalid");
    }
    if (parsedManifest.files.length > limits.files) {
      throw new Error(`Private manifest exceeds ${limits.files} file limit`);
    }

    const manifestPaths = new Set<string>();
    for (const manifestEntry of parsedManifest.files) {
      assertSafePrivatePath(manifestEntry.path);
      if (manifestPaths.has(manifestEntry.path)) {
        throw new Error(`Duplicate manifest path: ${manifestEntry.path}`);
      }
      manifestPaths.add(manifestEntry.path);
      const staged = stagedEntries.get(manifestEntry.path);
      if (!staged) throw new Error(`Archive entry missing: ${manifestEntry.path}`);
      if (staged.size !== manifestEntry.size) {
        throw new Error(`Size mismatch: ${manifestEntry.path}`);
      }
      if (staged.sha256 !== manifestEntry.sha256) {
        throw new Error(`Checksum mismatch: ${manifestEntry.path}`);
      }
    }
    for (const privatePath of stagedEntries.keys()) {
      if (!manifestPaths.has(privatePath)) {
        throw new Error(`Unexpected archive entry: data/${privatePath}`);
      }
    }
    for (const privatePath of manifestPaths) {
      assertSafeDestination(input.dataRoot, privatePath);
    }

    const createdFiles: Array<FileIdentity & { path: string }> = [];
    const createdDirectories: OwnedDirectory[] = [];
    const temporaryFiles: Array<FileIdentity & { path: string }> = [];
    try {
      for (const manifestEntry of parsedManifest.files) {
        const staged = stagedEntries.get(manifestEntry.path) as StagedEntry;
        assertSafeDestination(input.dataRoot, manifestEntry.path);
        ensureImportParents(input.dataRoot, manifestEntry.path, createdDirectories);
        assertSafeDestination(input.dataRoot, manifestEntry.path);
        const destination = safeLocalPath(input.dataRoot, manifestEntry.path);
        const temporary = join(
          resolve(input.dataRoot),
          `.omp-pai-import-${randomUUID()}`,
        );
        const temporaryIdentity = copyStagedFile(staged.stagedPath, temporary);
        temporaryFiles.push({ path: temporary, ...temporaryIdentity });
        assertSafeDestination(input.dataRoot, manifestEntry.path);
        const currentTemporary = fileIdentity(temporary);
        const temporaryChanged = (
          currentTemporary.dev !== temporaryIdentity.dev
          || currentTemporary.ino !== temporaryIdentity.ino
          || currentTemporary.birthtimeNs !== temporaryIdentity.birthtimeNs
        );
        // TOCTOU guard: copyStagedFile verified this inode immediately before returning.
        if (temporaryChanged) throw new Error(`Import temporary file changed before commit: ${manifestEntry.path}`);
        linkSync(temporary, destination);
        const destinationIdentity = fileIdentity(destination);
        const destinationChanged = (
          destinationIdentity.dev !== temporaryIdentity.dev
          || destinationIdentity.ino !== temporaryIdentity.ino
          || destinationIdentity.birthtimeNs !== temporaryIdentity.birthtimeNs
        );
        // A successful hard link has the source identity unless an external writer wins this gap.
        if (destinationChanged) { removeOwnedPath(destination, destinationIdentity); throw new Error(`Import destination identity mismatch: ${manifestEntry.path}`); }
        createdFiles.push({ path: destination, ...destinationIdentity });
        unlinkSync(temporary);
        temporaryFiles.pop();
      }
    } catch (error) {
      for (const owned of temporaryFiles) removeOwnedPath(owned.path, owned);
      for (const owned of createdFiles.reverse()) removeOwnedPath(owned.path, owned);
      for (const owned of createdDirectories.reverse()) {
        const current = lstatSync(owned.path, { bigint: true, throwIfNoEntry: false });
        if (
          !current
          || current.dev !== owned.dev
          || current.ino !== owned.ino
          || current.birthtimeNs !== owned.birthtimeNs
        ) continue;
        try {
          rmdirSync(owned.path);
        } catch {
          // Preserve non-empty directories populated by another concurrent writer.
        }
      }
      throw error;
    }

    return {
      archiveSha256: await sha256File(snapshotPath),
      imported: parsedManifest.files.length,
    };
  } catch (error) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && (error.code === "ELOOP" || error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      throw new Error("Private archive must be an existing regular file", { cause: error });
    }
    throw error;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
