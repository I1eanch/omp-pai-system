import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

/** Resolves a lexical relative path beneath a configured state root. */
export function resolveStatePath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\0")) {
    throw new Error("State path must be non-empty text without NUL bytes");
  }
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, relativePath);
  const fromRoot = relative(absoluteRoot, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`State path escapes configured root: ${relativePath}`);
  }
  return target;
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`State path contains a symlink: ${current}`);
  }
}

function assertPrivateDirectory(path: string, label: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info?.isDirectory()) throw new Error(`${label} must be a directory`);
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${label} permissions must be owner-only`);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid) throw new Error(`${label} must be owned by the current user`);
}

function safeStateDirectory(root: string, relativePath: string, create: boolean): string {
  const target = resolveStatePath(root, relativePath || ".");
  const rootPath = resolve(root);
  assertNoSymlinkComponents(rootPath);
  const fromRoot = relative(rootPath, target);
  const parts = fromRoot === "" ? [] : fromRoot.split(sep);

  let rootInfo = lstatSync(rootPath, { throwIfNoEntry: false });
  if (!rootInfo) {
    if (!create) return target;
    mkdirSync(rootPath, { recursive: true, mode: 0o700 });
    rootInfo = lstatSync(rootPath);
  }
  assertPrivateDirectory(rootPath, "State root");

  let current = rootPath;
  for (const part of parts) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) {
      if (!create) return target;
      mkdirSync(current, { mode: 0o700 });
    }
    assertPrivateDirectory(current, `State directory ${relativePath}`);
  }
  return target;
}

/** Creates and verifies owner-only state directories without symlink ancestors. */
export function ensureSafeStateDirectory(root: string, relativePath: string): string {
  return safeStateDirectory(root, relativePath, true);
}

/** Reads a bounded regular state file through a no-follow descriptor. */
export function readStateText(
  root: string,
  relativePath: string,
  maxBytes = 8 * 1024 * 1024,
): string {
  const path = resolveStatePath(root, relativePath);
  safeStateDirectory(root, dirname(relativePath), false);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`State file is missing or unsafe: ${relativePath}`, { cause: error });
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error(`State file is missing or unsafe: ${relativePath}`);
    if (info.size > maxBytes) {
      throw new Error(`State file exceeds ${maxBytes} byte limit: ${relativePath}`);
    }
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    let total = 0;
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new Error(`State file exceeds ${maxBytes} byte limit: ${relativePath}`);
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

/** Atomically replaces a state file while preserving inode ownership on cleanup. */
export function atomicWriteStateText(root: string, relativePath: string, content: string): string {
  const path = resolveStatePath(root, relativePath);
  ensureSafeStateDirectory(root, dirname(relativePath));
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (current?.isSymbolicLink()) throw new Error(`State file must not be a symlink: ${relativePath}`);
  if (current && !current.isFile()) throw new Error(`State destination is not a file: ${relativePath}`);

  const temporary = `${path}.tmp-${randomUUID()}`;
  let descriptor: number | undefined;
  let temporaryIdentity: { dev: bigint; ino: bigint; birthtimeNs: bigint } | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    temporaryIdentity = {
      dev: opened.dev,
      ino: opened.ino,
      birthtimeNs: opened.birthtimeNs,
    };
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    }
    fsyncSync(descriptor);
    const written = fstatSync(descriptor, { bigint: true });
    ensureSafeStateDirectory(root, dirname(relativePath));
    const temporaryInfo = lstatSync(temporary, { bigint: true, throwIfNoEntry: false });
    if (
      !temporaryInfo?.isFile()
      || temporaryInfo.isSymbolicLink()
      || temporaryInfo.dev !== written.dev
      || temporaryInfo.ino !== written.ino
      || temporaryInfo.birthtimeNs !== written.birthtimeNs
    ) {
      throw new Error(`State temporary file changed before commit: ${relativePath}`);
    }
    const latest = lstatSync(path, { throwIfNoEntry: false });
    if (latest?.isSymbolicLink() || (latest && !latest.isFile())) {
      throw new Error(`State destination became unsafe: ${relativePath}`);
    }
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    const committed = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    const committedIdentityChanged = (
      !committed
      || committed.dev !== written.dev
      || committed.ino !== written.ino
      || committed.birthtimeNs !== written.birthtimeNs
    );
    // rename preserves inode identity unless an external writer wins before this check.
    if (committedIdentityChanged) throw new Error(`State commit identity mismatch: ${relativePath}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryIdentity) {
      const current = lstatSync(temporary, { bigint: true, throwIfNoEntry: false });
      if (
        current
        && current.dev === temporaryIdentity.dev
        && current.ino === temporaryIdentity.ino
        && current.birthtimeNs === temporaryIdentity.birthtimeNs
      ) {
        rmSync(temporary);
      }
    }
  }
  return path;
}

/** Returns a regular file mode, null when absent, or -1 for unsafe node types. */
export function stateFileMode(root: string, relativePath: string): number | null {
  const path = resolveStatePath(root, relativePath);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) return -1;
  return info.mode & 0o777;
}
