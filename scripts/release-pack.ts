import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const stagingRoot = join(packageRoot, "dist/staging");
const releaseRoot = join(packageRoot, "dist/release");
const packageMetadata = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
) as { name?: unknown; version?: unknown };
if (
  typeof packageMetadata.name !== "string"
  || typeof packageMetadata.version !== "string"
) {
  throw new Error("Package name and version must be strings");
}

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
  }
  return stdout;
}

await run(["bun", "scripts/build-staging.ts"], packageRoot);
await run(["bun", "scripts/privacy-audit.ts"], packageRoot);
rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(releaseRoot, { recursive: true });

const packOutput = JSON.parse(await run([
  "npm",
  "pack",
  "--json",
  "--pack-destination",
  releaseRoot,
], stagingRoot)) as Array<{ filename: string }>;
const filename = packOutput[0]?.filename;
if (!filename) throw new Error("npm pack did not report an artifact");
const archivePath = join(releaseRoot, basename(filename));

const extractionRoot = mkdtempSync(join(tmpdir(), "omp-pai-release-audit-"));
try {
  const archive = new Bun.Archive(await Bun.file(archivePath).bytes());
  await archive.extract(extractionRoot);
  await run(
    ["bun", "scripts/privacy-audit.ts", join(extractionRoot, "package")],
    packageRoot,
  );
} finally {
  rmSync(extractionRoot, { recursive: true, force: true });
}

const archiveBytes = readFileSync(archivePath);
const manifest = {
  schemaVersion: 1,
  package: packageMetadata.name,
  version: packageMetadata.version,
  artifact: basename(archivePath),
  size: archiveBytes.byteLength,
  sha256: createHash("sha256").update(archiveBytes).digest("hex"),
  gates: ["allowlist", "privacy", "provenance", "archive-rescan"],
};
writeFileSync(
  join(releaseRoot, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
console.log(JSON.stringify(manifest, null, 2));
