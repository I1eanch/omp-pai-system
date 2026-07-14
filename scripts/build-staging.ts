import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  collectAllowlistedFiles,
  copyReleaseFile,
  readJson,
  REQUIRED_PACKAGE_FILES,
  type Allowlist,
  type Exclusions,
} from "./release-lib.ts";

const packageRoot = resolve(import.meta.dir, "..");
const stagingRoot = join(packageRoot, "dist/staging");
const allowlist = readJson<Allowlist>(join(packageRoot, "privacy/allowlist.json"));
const exclusions = readJson<Exclusions>(join(packageRoot, "privacy/exclusions.json"));
const files = collectAllowlistedFiles(packageRoot, allowlist, exclusions);
const missing = REQUIRED_PACKAGE_FILES.filter((path) => !files.includes(path));
if (missing.length > 0) throw new Error(`Required package files missing: ${missing.join(", ")}`);

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });
for (const path of files) copyReleaseFile(packageRoot, stagingRoot, path);

console.log(JSON.stringify({ stagingRoot, fileCount: files.length, files }, null, 2));
