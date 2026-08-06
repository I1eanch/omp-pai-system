import { join, resolve } from "node:path";

export type PaiConfig = {
  pluginRoot: string;
  dataRoot: string;
};

export type ResolvePaiConfigInput = {
  pluginRoot: string;
  env?: Record<string, string | undefined>;
};

/** Resolves immutable package paths and validates all environment overrides fail-closed. */
export function resolvePaiConfig(input: ResolvePaiConfigInput): PaiConfig {
  const env = input.env ?? process.env;
  const pluginRoot = resolve(input.pluginRoot);

  const home = env.HOME ?? env.USERPROFILE;
  const profileRoot = env.PI_CODING_AGENT_DIR ?? (home ? join(home, ".omp", "agent") : undefined);

  if (!env.OMP_PAI_DATA_DIR && !profileRoot) {
    throw new Error("Cannot resolve OMP profile directory");
  }

  const dataRoot = resolve(env.OMP_PAI_DATA_DIR ?? join(profileRoot!, "pai"));

  return {
    pluginRoot,
    dataRoot,
  };
}
