import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaiConfig } from "../../src/config.ts";

const pluginRoot = "/opt/omp/plugins/omp-pai-system";
const overrideRoot = mkdtempSync(join(tmpdir(), "omp-pai-config-"));
const customAlgorithmPath = join(overrideRoot, "Algorithm.md");
const versionedAlgorithmPath = join(overrideRoot, "v4.0.3.md");
const algorithmDirectoryPath = join(overrideRoot, "Algorithm-directory");
const symlinkAlgorithmPath = join(overrideRoot, "v3.7.0.md");
writeFileSync(customAlgorithmPath, "# Algorithm\n");
writeFileSync(versionedAlgorithmPath, "# Algorithm v4.0.3\n");
mkdirSync(algorithmDirectoryPath);
symlinkSync(customAlgorithmPath, symlinkAlgorithmPath);
afterAll(() => rmSync(overrideRoot, { recursive: true, force: true }));


describe("resolvePaiConfig", () => {
  test("uses profile-local state and bundled MIT Algorithm by default", () => {
    const config = resolvePaiConfig({
      pluginRoot,
      env: { PI_CODING_AGENT_DIR: "/tmp/profile/agent" },
    });

    expect(config.dataRoot).toBe("/tmp/profile/agent/pai");
    expect(config.algorithmPath).toBe(
      "/opt/omp/plugins/omp-pai-system/templates/Algorithm/v3.5.0.md",
    );
    expect(config.algorithmSource).toBe("bundled-mit-v3.5.0");
    expect(config.algorithmVersion).toBe("3.5.0");
  });

  test("accepts an explicit local Algorithm override", () => {
    const config = resolvePaiConfig({
      pluginRoot,
      env: {
        PI_CODING_AGENT_DIR: "/tmp/profile/agent",
        OMP_PAI_ALGORITHM_PATH: customAlgorithmPath,
        OMP_PAI_ALGORITHM_VERSION: "3.7.0",
      },
    });

    expect(config.algorithmPath).toBe(customAlgorithmPath);
    expect(config.algorithmSource).toBe("local-override");
    expect(config.algorithmVersion).toBe("3.7.0");
  });

  test("infers a semantic version from a versioned local filename", () => {
    const config = resolvePaiConfig({
      pluginRoot,
      env: {
        PI_CODING_AGENT_DIR: "/tmp/profile/agent",
        OMP_PAI_ALGORITHM_PATH: versionedAlgorithmPath,
      },
    });

    expect(config.algorithmVersion).toBe("4.0.3");
  });

  test("rejects an unversioned override without an explicit version", () => {
    expect(() =>
      resolvePaiConfig({
        pluginRoot,
        env: {
          PI_CODING_AGENT_DIR: "/tmp/profile/agent",
          OMP_PAI_ALGORITHM_PATH: customAlgorithmPath,
        },
      }),
    ).toThrow("Algorithm override version is required");
  });

  test("rejects remote Algorithm sources", () => {
    expect(() =>
      resolvePaiConfig({
        pluginRoot,
        env: { OMP_PAI_ALGORITHM_PATH: "https://example.com/Algorithm.md" },
      }),
    ).toThrow("Algorithm override must be a local filesystem path");
  });

  test("rejects a missing local Algorithm override", () => {
    expect(() =>
      resolvePaiConfig({
        pluginRoot,
        env: {
          PI_CODING_AGENT_DIR: "/tmp/profile/agent",
          OMP_PAI_ALGORITHM_PATH: join(overrideRoot, "missing.md"),
          OMP_PAI_ALGORITHM_VERSION: "3.7.0",
        },
      }),
    ).toThrow("Algorithm override must be an existing regular file");
  });

  test("rejects an Algorithm override directory", () => {
    expect(() =>
      resolvePaiConfig({
        pluginRoot,
        env: {
          PI_CODING_AGENT_DIR: "/tmp/profile/agent",
          OMP_PAI_ALGORITHM_PATH: algorithmDirectoryPath,
          OMP_PAI_ALGORITHM_VERSION: "3.7.0",
        },
      }),
    ).toThrow("Algorithm override must be an existing regular file");
  });

  test("accepts a symlink to a regular local Algorithm file", () => {
    const config = resolvePaiConfig({
      pluginRoot,
      env: {
        PI_CODING_AGENT_DIR: "/tmp/profile/agent",
        OMP_PAI_ALGORITHM_PATH: symlinkAlgorithmPath,
      },
    });

    expect(config.algorithmPath).toBe(symlinkAlgorithmPath);
    expect(config.algorithmVersion).toBe("3.7.0");
  });

  test("allows an explicit data root without host assumptions", () => {
    const config = resolvePaiConfig({
      pluginRoot,
      env: {
        PI_CODING_AGENT_DIR: "/ignored/profile",
        OMP_PAI_DATA_DIR: "/srv/omp-pai-data",
      },
    });

    expect(config.dataRoot).toBe("/srv/omp-pai-data");
  });

  test("derives profile state only from the injected HOME", () => {
    const config = resolvePaiConfig({
      pluginRoot,
      env: { HOME: "/tmp/fake-home" },
    });

    expect(config.dataRoot).toBe("/tmp/fake-home/.omp/agent/pai");
  });

  test("fails closed when no profile root can be resolved", () => {
    expect(() => resolvePaiConfig({ pluginRoot, env: {} })).toThrow(
      "Cannot resolve OMP profile directory",
    );
  });
});
