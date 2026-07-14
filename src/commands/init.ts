import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export type InitializePaiStateInput = {
  pluginRoot: string;
  dataRoot: string;
};

export type InitializePaiStateReport = {
  created: string[];
  skipped: string[];
  directories: string[];
};

const TELOS_FILES = [
  "README.md",
  "schema.json",
  "BELIEFS.md",
  "CHALLENGES.md",
  "DECISIONS.md",
  "GOALS.md",
  "IDEAS.md",
  "LEARNED.md",
  "PROJECTS.md",
] as const;

const MEMORY_FILES = [
  "README.md",
  "layout.json",
  "STATE/work.json",
  "STATE/work.schema.json",
  "LEARNING/README.md",
  "LEARNING/REFLECTIONS/algorithm-reflections.jsonl",
  "LEARNING/SIGNALS/ratings.jsonl",
] as const;

export const OWNED_STARTER_PATHS = new Set<string>([
  ...TELOS_FILES.map((filename) => `TELOS/${filename}`),
  ...MEMORY_FILES.map((filename) => `MEMORY/${filename}`),
]);
const STATE_DIRECTORIES = [
  "TELOS",
  "MEMORY/WORK",
  "MEMORY/STATE",
  "MEMORY/LEARNING/REFLECTIONS",
  "MEMORY/LEARNING/SIGNALS",
  "MEMORY/LEARNING/FAILURES",
  "MEMORY/LEARNING/SYNTHESIS",
  "MEMORY/RAW",
  "PAI/ACTIONS",
  "PAI/FLOWS",
  "PAI/PIPELINES",
] as const;

function safeChild(root: string, child: string): string {
  const absoluteRoot = resolve(root);
  const absoluteChild = resolve(absoluteRoot, child);
  const childRelative = relative(absoluteRoot, absoluteChild);
  if (childRelative === ".." || childRelative.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes configured root: ${child}`);
  }
  return absoluteChild;
}

function ensureDirectory(root: string, relativePath: string): void {
  const target = safeChild(root, relativePath);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing symlink directory: ${relativePath}`);
  }
  if (existing && !existing.isDirectory()) {
    throw new Error(`Expected directory but found file: ${relativePath}`);
  }
  if (existing) return;

  if (relativePath === "." || relativePath === "") {
    mkdirSync(target, { recursive: true });
    return;
  }

  ensureDirectory(root, dirname(relativePath));
  mkdirSync(target);
}

function copyStarter(
  pluginRoot: string,
  dataRoot: string,
  templatePath: string,
  destinationPath: string,
  report: InitializePaiStateReport,
): void {
  const source = safeChild(join(pluginRoot, "templates"), templatePath);
  const sourceInfo = lstatSync(source, { throwIfNoEntry: false });
  if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`Invalid starter template: ${templatePath}`);
  }

  const destination = safeChild(dataRoot, destinationPath);
  ensureDirectory(dataRoot, dirname(destinationPath));
  const destinationInfo = lstatSync(destination, { throwIfNoEntry: false });
  if (destinationInfo?.isSymbolicLink()) {
    throw new Error(`Refusing symlink destination: ${destinationPath}`);
  }
  if (destinationInfo) {
    if (!destinationInfo.isFile()) {
      throw new Error(`Expected file but found directory: ${destinationPath}`);
    }
    report.skipped.push(destinationPath);
    return;
  }

  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  report.created.push(destinationPath);
}

type OwnershipEntry = {
  path: string;
  sha256: string;
};

type OwnershipManifest = {
  schemaVersion: 1;
  package: "omp-pai-system";
  version: string;
  managedFiles: OwnershipEntry[];
};

const OWNERSHIP_PATH = ".omp-pai-ownership.json";

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function readOwnership(dataRoot: string): OwnershipManifest | null {
  const path = safeChild(dataRoot, OWNERSHIP_PATH);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return null;
  if (info.isSymbolicLink()) throw new Error(`Refusing symlink destination: ${OWNERSHIP_PATH}`);
  if (!info.isFile()) throw new Error(`Expected file but found directory: ${OWNERSHIP_PATH}`);

  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<OwnershipManifest>;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.package !== "omp-pai-system" ||
    !Array.isArray(parsed.managedFiles) ||
    parsed.managedFiles.some((entry) =>
      typeof entry?.path !== "string" ||
      !OWNED_STARTER_PATHS.has(entry.path) ||
      typeof entry?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    )
  ) {
    throw new Error(`Invalid ownership manifest: ${OWNERSHIP_PATH}`);
  }
  for (const entry of parsed.managedFiles) safeChild(dataRoot, entry.path);
  return parsed as OwnershipManifest;
}

function writeOwnership(
  pluginRoot: string,
  dataRoot: string,
  previous: OwnershipManifest | null,
  created: readonly string[],
): void {
  const packageJson = JSON.parse(
    readFileSync(safeChild(pluginRoot, "package.json"), "utf8"),
  ) as { name?: string; version?: string };
  if (packageJson.name !== "omp-pai-system" || typeof packageJson.version !== "string") {
    throw new Error("Invalid plugin package metadata");
  }

  const managed = new Map(
    (previous?.managedFiles ?? []).map((entry) => [entry.path, entry.sha256]),
  );
  for (const path of created) {
    managed.set(path, fileSha256(safeChild(dataRoot, path)));
  }
  const manifest: OwnershipManifest = {
    schemaVersion: 1,
    package: "omp-pai-system",
    version: packageJson.version,
    managedFiles: [...managed]
      .map(([path, sha256]) => ({ path, sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };

  const target = safeChild(dataRoot, OWNERSHIP_PATH);
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function initializePaiState(
  input: InitializePaiStateInput,
): InitializePaiStateReport {
  const pluginRoot = resolve(input.pluginRoot);
  const dataRoot = resolve(input.dataRoot);
  const report: InitializePaiStateReport = {
    created: [],
    skipped: [],
    directories: [...STATE_DIRECTORIES],
  };

  ensureDirectory(dataRoot, ".");
  const previousOwnership = readOwnership(dataRoot);
  for (const directory of STATE_DIRECTORIES) {
    ensureDirectory(dataRoot, directory);
  }
  for (const filename of TELOS_FILES) {
    copyStarter(pluginRoot, dataRoot, `TELOS/${filename}`, `TELOS/${filename}`, report);
  }
  for (const filename of MEMORY_FILES) {
    copyStarter(pluginRoot, dataRoot, `MEMORY/${filename}`, `MEMORY/${filename}`, report);
  }

  report.created.sort();
  report.skipped.sort();
  writeOwnership(pluginRoot, dataRoot, previousOwnership, report.created);
  return report;
}
