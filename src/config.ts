import { statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

export type PaiConfig = {
  pluginRoot: string;
  dataRoot: string;
  algorithmPath: string;
  algorithmVersion: string;
  algorithmSource: "bundled-mit-v3.5.0" | "local-override";
};

export type ResolvePaiConfigInput = {
  pluginRoot: string;
  env?: Record<string, string | undefined>;
};

export function resolvePaiConfig(input: ResolvePaiConfigInput): PaiConfig {
  const env = input.env ?? process.env;
  const pluginRoot = resolve(input.pluginRoot);
  const override = env.OMP_PAI_ALGORITHM_PATH?.trim();

  if (override && (/^[a-z][a-z\d+.-]*:\/\//iu.test(override) || !isAbsolute(override))) {
    throw new Error("Algorithm override must be a local filesystem path");
  }

  if (override) {
    try {
      if (!statSync(override).isFile()) {
        throw new Error("not a regular file");
      }
    } catch {
      throw new Error("Algorithm override must be an existing regular file");
    }
  }

  const explicitVersion = env.OMP_PAI_ALGORITHM_VERSION?.trim();
  const inferredVersion = override
    ? basename(override).match(/^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\.md$/u)?.[1]
    : undefined;
  const algorithmVersion = override ? explicitVersion ?? inferredVersion : "3.5.0";

  if (override && !algorithmVersion) {
    throw new Error("Algorithm override version is required");
  }
  if (algorithmVersion && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(algorithmVersion)) {
    throw new Error("Algorithm version must be semantic version text");
  }

  const home = env.HOME ?? env.USERPROFILE;
  const profileRoot = env.PI_CODING_AGENT_DIR ?? (home ? join(home, ".omp", "agent") : undefined);

  if (!env.OMP_PAI_DATA_DIR && !profileRoot) {
    throw new Error("Cannot resolve OMP profile directory");
  }

  const dataRoot = resolve(env.OMP_PAI_DATA_DIR ?? join(profileRoot!, "pai"));

  return {
    pluginRoot,
    dataRoot,
    algorithmPath: override ?? join(pluginRoot, "templates", "Algorithm", "v3.5.0.md"),
    algorithmVersion: algorithmVersion!,
    algorithmSource: override ? "local-override" : "bundled-mit-v3.5.0",
  };
}
