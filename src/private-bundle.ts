import {
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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

const PRIVATE_ROOTS = ["TELOS", "MEMORY"] as const;

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

export function safeLocalPath(root: string, child: string): string {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, child);
  const targetRelative = relative(absoluteRoot, target);
  if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes configured root: ${child}`);
  }
  return target;
}

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

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of createReadStream(path)) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}





export function assertArchiveOutsideDataRoot(dataRoot: string, archivePath: string): void {
  const archiveRelative = relative(resolve(dataRoot), resolve(archivePath));
  if (archiveRelative === "" || (archiveRelative !== ".." && !archiveRelative.startsWith(`..${sep}`))) {
    throw new Error("Private archive must be outside data root");
  }
}



export function destinationConflict(dataRoot: string, path: string): boolean {
  const destination = safeLocalPath(dataRoot, path);
  return lstatSync(destination, { throwIfNoEntry: false }) !== undefined;
}

export function ensureArchiveParent(path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

export function fileSize(path: string): number {
  return statSync(path).size;
}

export function atomicArchivePaths(archivePath: string): { target: string; temporary: string } {
  const target = resolve(archivePath);
  return {
    target,
    temporary: join(dirname(target), `.${basename(target)}.tmp-${randomUUID()}`),
  };
}

export function commitArchive(temporary: string, target: string): void {
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
  unlinkSync(temporary);
}
