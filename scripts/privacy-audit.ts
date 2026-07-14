import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  listRegularFiles,
  matchesAny,
  readJson,
  REQUIRED_PACKAGE_FILES,
  type Allowlist,
  type Exclusions,
} from "./release-lib.ts";

type ProvenanceSource = {
  id: string;
  paths?: string[];
  license?: string;
  distributable: boolean;
  sha256?: string;
};

type ProvenanceManifest = {
  schemaVersion: 1;
  sources: ProvenanceSource[];
};

const packageRoot = resolve(import.meta.dir, "..");
const targetRoot = resolve(process.argv[2] ?? join(packageRoot, "dist/staging"));
const allowlist = readJson<Allowlist>(join(packageRoot, "privacy/allowlist.json"));
const exclusions = readJson<Exclusions>(join(packageRoot, "privacy/exclusions.json"));
const provenance = readJson<ProvenanceManifest>(join(
  packageRoot,
  "privacy/provenance-manifest.json",
));
const files = listRegularFiles(targetRoot);
const failures: string[] = [];

const sensitiveContentPatterns: Array<[string, RegExp]> = [
  ["macOS user path", /\/Users\/[A-Za-z0-9._-]+\//u],
  ["Windows user path", /[A-Za-z]:\\Users\\[^\\\s]+\\/u],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ["credential-like token", /\b(?:github_pat_|ghp_|sk-(?:proj-)?|xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}\b/u],
  ["assigned secret", /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\n]{8,}["']/iu],
  ["personal email", /\b[A-Z0-9._%+-]+@(?:gmail|icloud|yandex|mail)\.[A-Z]{2,}\b/iu],
  ["known local username", /\bnkovelin\b/iu],
];

if (allowlist.schemaVersion !== 1 || exclusions.schemaVersion !== 1 || provenance.schemaVersion !== 1) {
  failures.push("Unsupported release metadata schema");
}
for (const path of REQUIRED_PACKAGE_FILES) {
  if (!files.includes(path)) failures.push(`${path}: required package file is missing`);
}

for (const path of files) {
  if (!matchesAny(path, allowlist.include)) failures.push(`${path}: not allowlisted`);
  if (matchesAny(path, allowlist.exclude) || matchesAny(path, exclusions.patterns)) {
    failures.push(`${path}: matches a release exclusion`);
  }

  const sources = provenance.sources.filter((source) =>
    source.paths && matchesAny(path, source.paths)
  );
  if (!sources.some(({ distributable, license }) =>
    distributable && Boolean(license) && license !== "UNRESOLVED" && license !== "PRIVATE"
  )) {
    failures.push(`${path}: no distributable provenance mapping`);
  }

  const content = readFileSync(join(targetRoot, path), "utf8");
  for (const [label, pattern] of sensitiveContentPatterns) {
    if (pattern.test(content)) failures.push(`${path}: contains ${label}`);
  }
}

for (const source of provenance.sources) {
  if (!source.sha256 || !source.paths || source.paths.length !== 1) continue;
  const path = source.paths[0];
  if (!files.includes(path)) continue;
  const info = lstatSync(join(targetRoot, path), { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) {
    failures.push(`${path}: checksummed provenance source is unsafe`);
    continue;
  }
  const digest = new Bun.CryptoHasher("sha256")
    .update(readFileSync(join(targetRoot, path)))
    .digest("hex");
  if (digest !== source.sha256) failures.push(`${path}: provenance checksum mismatch`);
}

if (failures.length > 0) {
  console.error(JSON.stringify({ targetRoot, passed: false, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    targetRoot,
    passed: true,
    checks: {
      allowlist: files.length,
      provenance: files.length,
      privacyPatterns: sensitiveContentPatterns.length,
    },
  }, null, 2));
}
