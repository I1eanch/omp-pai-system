import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { initializePaiState } from "../src/commands/init.ts";

const packageRoot = resolve(import.meta.dir, "..");
const manifestPath = join(packageRoot, "dist/release/release-manifest.json");
if (!existsSync(manifestPath)) throw new Error("Release manifest is missing");
const releaseManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  artifact?: unknown;
};
if (
  typeof releaseManifest.artifact !== "string"
  || releaseManifest.artifact !== basename(releaseManifest.artifact)
  || !releaseManifest.artifact.endsWith(".tgz")
) {
  throw new Error("Release manifest artifact is unsafe");
}
const archivePath = join(packageRoot, "dist/release", releaseManifest.artifact);
if (!existsSync(archivePath)) throw new Error("Release artifact is missing");

const home = mkdtempSync(join(tmpdir(), "omp-pai-lifecycle-"));
const agentRoot = join(home, ".omp/agent");
const dataRoot = join(agentRoot, "pai");
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  PI_CODING_AGENT_DIR: agentRoot,
};

async function run(args: string[]): Promise<string> {
  const child = Bun.spawn(["omp", ...args], {
    cwd: packageRoot,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`omp ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
  }
  return `${stdout}\n${stderr}`;
}

try {
  const archive = new Bun.Archive(await Bun.file(archivePath).bytes());
  await archive.extract(home);
  const installedPackageRoot = join(home, "package");
  assert.equal(
    existsSync(join(installedPackageRoot, "templates/MEMORY/STATE/work.json")),
    true,
  );
  assert.equal(
    existsSync(join(installedPackageRoot, "templates/MEMORY/STATE/work.schema.json")),
    true,
  );
  initializePaiState({ pluginRoot: installedPackageRoot, dataRoot });
  const goalsPath = join(dataRoot, "TELOS/GOALS.md");
  writeFileSync(goalsPath, "preserve across lifecycle\n");

  const installed = await run([
    "plugin", "install", installedPackageRoot, "--json",
  ]);
  assert.match(installed, /omp-pai-system/u);

  const listed = await run(["plugin", "list", "--json"]);
  assert.match(listed, /omp-pai-system/u);
  const nativeDoctor = await run(["plugin", "doctor", "omp-pai-system", "--json"]);
  assert.doesNotMatch(nativeDoctor, /"status"\s*:\s*"error"/u);
  assert.equal(readFileSync(goalsPath, "utf8"), "preserve across lifecycle\n");

  const upgraded = await run([
    "plugin", "install", installedPackageRoot, "--force", "--json",
  ]);
  assert.match(upgraded, /omp-pai-system/u);
  assert.equal(readFileSync(goalsPath, "utf8"), "preserve across lifecycle\n");

  const uninstalled = await run([
    "plugin", "uninstall", "omp-pai-system", "--json",
  ]);
  assert.match(uninstalled, /omp-pai-system/u);
  const after = await run(["plugin", "list", "--json"]);
  assert.doesNotMatch(after, /omp-pai-system/u);
  assert.equal(readFileSync(goalsPath, "utf8"), "preserve across lifecycle\n");

  console.log(JSON.stringify({
    passed: true,
    checks: ["install", "list", "native-doctor", "force-upgrade", "uninstall", "private-state-preserved"],
  }, null, 2));
} finally {
  rmSync(home, { recursive: true, force: true });
}
