import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { OWNED_STARTER_PATHS } from "../src/commands/init.ts";

export const REQUIRED_PACKAGE_FILES = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "docs/best-practices.md",
  "docs/faq.md",
  "docs/sdk.md",
  "src/index.ts",
  "templates/Algorithm/v3.5.0.md",
  "templates/PAI/README.md",
  "templates/PAI/PRDFORMAT.md",
  "templates/PAI/CONTEXT_ROUTING.md",
  "templates/PAI/ACTIONS/README.md",
  "templates/PAI/FLOWS/README.md",
  "templates/PAI/PIPELINES/README.md",
  ...[...OWNED_STARTER_PATHS].map((path) => `templates/${path}`),
].sort();
export type Allowlist = {
  schemaVersion: 1;
  include: string[];
  exclude: string[];
};

export type Exclusions = {
  schemaVersion: 1;
  patterns: string[];
};

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(path));
}

export function safeRelativePath(root: string, path: string): string {
  const value = relative(resolve(root), resolve(path)).split(sep).join(posix.sep);
  if (value === "" || value === ".." || value.startsWith("../") || posix.isAbsolute(value)) {
    throw new Error(`Path is outside release root: ${value}`);
  }
  return value;
}

export function listRegularFiles(root: string, ignored: readonly string[] = []): string[] {
  const absoluteRoot = resolve(root);
  const rootInfo = lstatSync(absoluteRoot, { throwIfNoEntry: false });
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Release root must be a regular directory");
  }
  const files: string[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const path = safeRelativePath(absoluteRoot, absolutePath);
      if (entry.isDirectory() && matchesAny(`${path}/`, ignored)) continue;
      if (!entry.isDirectory() && matchesAny(path, ignored)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Release input contains symlink: ${path}`);
      if (entry.isDirectory()) walk(absolutePath);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Release input contains non-regular file: ${path}`);
    }
  }

  walk(absoluteRoot);
  return files.sort();
}

export function collectAllowlistedFiles(
  root: string,
  allowlist: Allowlist,
  exclusions: Exclusions,
): string[] {
  if (allowlist.schemaVersion !== 1 || exclusions.schemaVersion !== 1) {
    throw new Error("Unsupported privacy configuration schema");
  }
  return listRegularFiles(root, [...allowlist.exclude, ...exclusions.patterns]).filter((path) =>
    matchesAny(path, allowlist.include)
    && !matchesAny(path, allowlist.exclude)
    && !matchesAny(path, exclusions.patterns)
  );
}

export function copyReleaseFile(sourceRoot: string, targetRoot: string, path: string): void {
  const source = resolve(sourceRoot, path);
  const target = resolve(targetRoot, path);
  safeRelativePath(sourceRoot, source);
  safeRelativePath(targetRoot, target);
  const sourceInfo = lstatSync(source, { throwIfNoEntry: false });
  if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`Cannot stage unsafe source: ${path}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
