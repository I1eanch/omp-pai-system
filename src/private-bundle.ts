import {
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";

export type PrivateBundleFile = {
  path: string;
  size: number;
  sha256: string;
};

export type PrivateBundleManifest = {
  schemaVersion: 1;
  createdAt: string;
  files: PrivateBundleFile[];
};

export type FileIdentity = {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
};

const PRIVATE_ROOTS = ["TELOS", "MEMORY"] as const;

/** Validates the exact private archive manifest shape and entry metadata. */
export function isPrivateBundleManifest(value: unknown): value is PrivateBundleManifest {
  if (
    value === null
    || typeof value !== "object"
    || !("schemaVersion" in value)
    || value.schemaVersion !== 1
    || !("createdAt" in value)
    || typeof value.createdAt !== "string"
    || !("files" in value)
    || !Array.isArray(value.files)
  ) {
    return false;
  }
  return value.files.every((entry) =>
    entry !== null
    && typeof entry === "object"
    && "path" in entry
    && typeof entry.path === "string"
    && "size" in entry
    && Number.isSafeInteger(entry.size)
    && entry.size >= 0
    && "sha256" in entry
    && typeof entry.sha256 === "string"
    && /^[a-f0-9]{64}$/u.test(entry.sha256)
  );
}

/** Rejects archive paths outside the TELOS and MEMORY namespaces. */
export function assertSafePrivatePath(path: string): void {
  const normalized = posix.normalize(path);
  if (
    path.length === 0
    || path.includes("\\")
    || path.includes("\0")
    || posix.isAbsolute(path)
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized !== path
    || !PRIVATE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
  ) {
    throw new Error(`Unsafe manifest path: ${path}`);
  }
}

/** Resolves a child beneath a configured root without allowing lexical escape. */
export function safeLocalPath(root: string, child: string): string {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, child);
  const targetRelative = relative(absoluteRoot, target);
  if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes configured root: ${child}`);
  }
  return target;
}

/** Enumerates regular private files while rejecting symlinks and special files. */
export function listPrivateFiles(dataRoot: string): Array<{ path: string; absolutePath: string }> {
  const rootInfo = lstatSync(resolve(dataRoot), { throwIfNoEntry: false });
  if (!rootInfo) return [];
  if (rootInfo.isSymbolicLink()) throw new Error("Refusing data root symlink");
  if (!rootInfo.isDirectory()) throw new Error("Private data root is not a directory");

  const files: Array<{ path: string; absolutePath: string }> = [];

  function walk(rootName: string, directory: string, prefix = ""): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const privatePath = `${rootName}/${relativePath}`;
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing source symlink: ${privatePath}`);
      }
      if (entry.isDirectory()) {
        walk(rootName, absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push({ path: privatePath, absolutePath });
      } else {
        throw new Error(`Refusing non-regular source: ${privatePath}`);
      }
    }
  }

  for (const rootName of PRIVATE_ROOTS) {
    const directory = safeLocalPath(dataRoot, rootName);
    if (!existsSync(directory)) continue;
    const info = lstatSync(directory);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing source symlink: ${rootName}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Private state root is not a directory: ${rootName}`);
    }
    walk(rootName, directory);
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Streams a file into SHA-256 without loading it wholly into memory. */
export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of createReadStream(path)) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}





function canonicalProspectivePath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  while (!lstatSync(current, { throwIfNoEntry: false })) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...missing);
}

/** Rejects archive destinations resolving inside the private data root. */
export function assertArchiveOutsideDataRoot(dataRoot: string, archivePath: string): void {
  const canonicalRoot = canonicalProspectivePath(dataRoot);
  const canonicalArchive = canonicalProspectivePath(archivePath);
  const archiveRelative = relative(canonicalRoot, canonicalArchive);
  if (archiveRelative === "" || (archiveRelative !== ".." && !archiveRelative.startsWith(`..${sep}`))) {
    throw new Error("Private archive must be outside data root");
  }
}



/** Reports whether an import destination already exists without following it. */
export function destinationConflict(dataRoot: string, path: string): boolean {
  const destination = safeLocalPath(dataRoot, path);
  return lstatSync(destination, { throwIfNoEntry: false }) !== undefined;
}

/** Creates an owner-only archive parent directory when needed. */
export function ensureArchiveParent(path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
}

/** Returns the current byte size of a regular archive candidate. */
export function fileSize(path: string): number {
  return statSync(path).size;
}

/** Derives the final archive path and a unique same-directory temporary path. */
export function atomicArchivePaths(archivePath: string): { target: string; temporary: string } {
  const target = resolve(archivePath);
  return {
    target,
    temporary: join(dirname(target), `.${basename(target)}.tmp-${randomUUID()}`),
  };
}

/** Captures stable inode identity for a regular non-symlink file. */
export function fileIdentity(path: string): FileIdentity {
  const info = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new Error(`Expected a safe regular file: ${path}`);
  }
  return { dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs };
}

/** Removes a path only when it still denotes the inode created by this operation. */
export function removeOwnedPath(path: string, identity: FileIdentity): boolean {
  const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (
    !current
    || current.dev !== identity.dev
    || current.ino !== identity.ino
    || current.birthtimeNs !== identity.birthtimeNs
  ) {
    return false;
  }
  rmSync(path);
  return true;
}

/** Publishes an archive with no-overwrite hard-link semantics and identity checks. */
export function commitArchive(
  temporary: string,
  target: string,
  expectedIdentity?: FileIdentity,
): void {
  const temporaryIdentity = fileIdentity(temporary);
  if (
    expectedIdentity
    && (
      temporaryIdentity.dev !== expectedIdentity.dev
      || temporaryIdentity.ino !== expectedIdentity.ino
      || temporaryIdentity.birthtimeNs !== expectedIdentity.birthtimeNs
    )
  ) {
    throw new Error("Archive temporary file changed before commit");
  }
  try {
    linkSync(temporary, target);
  } catch (error) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "EEXIST"
    ) {
      throw new Error(`Archive already exists: ${target}`, { cause: error });
    }
    throw error;
  }

  const targetIdentity = fileIdentity(target);
  const destinationChanged = (
    targetIdentity.dev !== temporaryIdentity.dev
    || targetIdentity.ino !== temporaryIdentity.ino
    || targetIdentity.birthtimeNs !== temporaryIdentity.birthtimeNs
  );
  // A successful hard link has the source identity unless an external writer wins this gap.
  if (destinationChanged) { removeOwnedPath(target, targetIdentity); throw new Error("Archive destination identity mismatch"); }
  // Failure is possible only through external filesystem interference.
  try { unlinkSync(temporary); } catch (error) { removeOwnedPath(target, targetIdentity); throw error; }
}
