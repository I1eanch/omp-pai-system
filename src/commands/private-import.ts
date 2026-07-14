import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertSafePrivatePath,
  destinationConflict,
  isPrivateBundleManifest,
  safeLocalPath,
  sha256File,
} from "../private-bundle.ts";

export type ImportPrivateStateInput = {
  dataRoot: string;
  archivePath: string;
};

export type ImportPrivateStateReport = {
  archiveSha256: string;
  imported: number;
};

type ValidatedEntry = {
  path: string;
  content: Uint8Array;
};

function assertSafeDestination(dataRoot: string, path: string): void {
  const root = resolve(dataRoot);
  const rootInfo = lstatSync(root, { throwIfNoEntry: false });
  if (rootInfo?.isSymbolicLink()) throw new Error("Import conflict: data root is a symlink");
  if (rootInfo && !rootInfo.isDirectory()) throw new Error("Import conflict: data root is not a directory");

  const parentParts = dirname(path).split("/").filter((part) => part && part !== ".");
  let current = root;
  for (const part of parentParts) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) throw new Error(`Import conflict: symlink parent for ${path}`);
    if (info && !info.isDirectory()) throw new Error(`Import conflict: file parent for ${path}`);
  }
  if (destinationConflict(root, path)) {
    throw new Error(`Import conflict: ${path} already exists`);
  }
}

function ensureImportParents(
  dataRoot: string,
  path: string,
  createdDirectories: string[],
): void {
  const root = resolve(dataRoot);
  if (!lstatSync(root, { throwIfNoEntry: false })) {
    mkdirSync(root, { recursive: true });
    createdDirectories.push(root);
  }
  const parentParts = dirname(path).split("/").filter((part) => part && part !== ".");
  let current = root;
  for (const part of parentParts) {
    current = join(current, part);
    if (!lstatSync(current, { throwIfNoEntry: false })) {
      mkdirSync(current);
      createdDirectories.push(current);
    }
  }
}

export async function importPrivateState(
  input: ImportPrivateStateInput,
): Promise<ImportPrivateStateReport> {
  const source = resolve(input.archivePath);
  const sourceInfo = lstatSync(source, { throwIfNoEntry: false });
  if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error("Private archive must be an existing regular file");
  }

  const snapshotRoot = mkdtempSync(join(tmpdir(), "omp-pai-import-"));
  const snapshotPath = join(snapshotRoot, basename(source));
  copyFileSync(source, snapshotPath);

  try {
    const archive = new Bun.Archive(await Bun.file(snapshotPath).bytes());
    const archiveFiles = await archive.files();
    const manifestFile = archiveFiles.get("manifest.json");
    if (!manifestFile) throw new Error("Private archive manifest is missing");

    const parsedManifest: unknown = JSON.parse(await manifestFile.text());
    if (!isPrivateBundleManifest(parsedManifest)) {
      throw new Error("Private archive manifest is invalid");
    }
    if (Number.isNaN(Date.parse(parsedManifest.createdAt))) {
      throw new Error("Private archive manifest timestamp is invalid");
    }

    const expectedEntries = new Set(["manifest.json"]);
    const seenPaths = new Set<string>();
    const validated: ValidatedEntry[] = [];
    for (const manifestEntry of parsedManifest.files) {
      assertSafePrivatePath(manifestEntry.path);
      if (seenPaths.has(manifestEntry.path)) {
        throw new Error(`Duplicate manifest path: ${manifestEntry.path}`);
      }
      seenPaths.add(manifestEntry.path);
      const archivePath = `data/${manifestEntry.path}`;
      expectedEntries.add(archivePath);
      const file = archiveFiles.get(archivePath);
      if (!file) throw new Error(`Archive entry missing: ${manifestEntry.path}`);
      const content = new Uint8Array(await file.arrayBuffer());
      if (content.byteLength !== manifestEntry.size) {
        throw new Error(`Size mismatch: ${manifestEntry.path}`);
      }
      const digest = new Bun.CryptoHasher("sha256").update(content).digest("hex");
      if (digest !== manifestEntry.sha256) {
        throw new Error(`Checksum mismatch: ${manifestEntry.path}`);
      }
      validated.push({ path: manifestEntry.path, content });
    }

    for (const archivePath of archiveFiles.keys()) {
      if (!expectedEntries.has(archivePath)) {
        throw new Error(`Unexpected archive entry: ${archivePath}`);
      }
    }
    for (const entry of validated) {
      assertSafeDestination(input.dataRoot, entry.path);
    }

    const createdFiles: string[] = [];
    const createdDirectories: string[] = [];
    const temporaryFiles: string[] = [];
    try {
      for (const entry of validated) {
        ensureImportParents(input.dataRoot, entry.path, createdDirectories);
        const destination = safeLocalPath(input.dataRoot, entry.path);
        const temporary = join(
          dirname(destination),
          `.${basename(destination)}.tmp-${randomUUID()}`,
        );
        temporaryFiles.push(temporary);
        writeFileSync(temporary, entry.content, { flag: "wx" });
        linkSync(temporary, destination);
        unlinkSync(temporary);
        temporaryFiles.pop();
        createdFiles.push(destination);
      }
    } catch (error) {
      for (const path of temporaryFiles) rmSync(path, { force: true });
      for (const path of createdFiles.reverse()) rmSync(path, { force: true });
      for (const path of createdDirectories.reverse()) {
        try {
          rmdirSync(path);
        } catch {
          // Preserve non-empty directories that predated another concurrent writer.
        }
      }
      throw error;
    }

    return {
      archiveSha256: await sha256File(snapshotPath),
      imported: validated.length,
    };
  } finally {
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
}
