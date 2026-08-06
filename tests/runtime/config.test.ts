import { describe, expect, test } from "bun:test";
import { resolvePaiConfig } from "../../src/config.ts";

const pluginRoot = "/opt/omp/plugins/omp-pai-system";

describe("resolvePaiConfig", () => {
  test("uses profile-local state by default", () => {
    expect(resolvePaiConfig({
      pluginRoot,
      env: { HOME: "/tmp/profile" },
    })).toEqual({
      pluginRoot,
      dataRoot: "/tmp/profile/.omp/agent/pai",
    });
  });

  test("prefers an explicit data root", () => {
    expect(resolvePaiConfig({
      pluginRoot,
      env: {
        HOME: "/tmp/profile",
        OMP_PAI_DATA_DIR: "/srv/pai-state",
      },
    }).dataRoot).toBe("/srv/pai-state");
  });

  test("uses the injected OMP agent directory", () => {
    expect(resolvePaiConfig({
      pluginRoot,
      env: { PI_CODING_AGENT_DIR: "/srv/agent" },
    }).dataRoot).toBe("/srv/agent/pai");
  });

  test("uses USERPROFILE when HOME is unavailable", () => {
    expect(resolvePaiConfig({
      pluginRoot,
      env: { USERPROFILE: "/tmp/windows-profile" },
    }).dataRoot).toBe("/tmp/windows-profile/.omp/agent/pai");
  });

  test("fails closed without any profile root", () => {
    expect(() => resolvePaiConfig({ pluginRoot, env: {} })).toThrow(
      "Cannot resolve OMP profile directory",
    );
  });

  test("does not expose removed legacy Algorithm configuration", () => {
    const config = resolvePaiConfig({
      pluginRoot,
      env: {
        HOME: "/tmp/profile",
        OMP_PAI_ALGORITHM_PATH: "https://legacy.invalid/algorithm.md",
      },
    });
    expect(Object.keys(config).sort()).toEqual(["dataRoot", "pluginRoot"]);
  });
});
