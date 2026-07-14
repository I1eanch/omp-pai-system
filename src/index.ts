import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { runPaiDoctor } from "./commands/doctor.ts";
import { initializePaiState } from "./commands/init.ts";
import { exportPrivateState } from "./commands/private-export.ts";
import { importPrivateState } from "./commands/private-import.ts";
import { resolvePaiConfig, type ResolvePaiConfigInput } from "./config.ts";
import { createPaiRuntimeGate } from "./runtime/pai-runtime-gate.ts";

export type CreatePaiPluginInput = ResolvePaiConfigInput;

function localPathArgument(args: string, command: string): string {
  const value = args.trim();
  if (!value) throw new Error(`Usage: /${command} <local-path>`);
  const quote = value[0];
  if ((quote === `"` || quote === `'`) && value.at(-1) === quote) {
    return value.slice(1, -1);
  }
  return value;
}

export function createPaiPlugin(input: CreatePaiPluginInput): (pi: ExtensionAPI) => void {
  const config = resolvePaiConfig(input);
  const runtimeGate = createPaiRuntimeGate({
    algorithmPath: config.algorithmPath,
    algorithmVersion: config.algorithmVersion,
    dataRoot: config.dataRoot,
    paiTemplateRoot: join(config.pluginRoot, "templates", "PAI"),
  });

  return (pi) => {
    runtimeGate(pi);
    pi.registerCommand("pai-init", {
      description: "Initialize local PAI state without overwriting user files",
      handler: async (_args, context) => {
        const report = initializePaiState({
          pluginRoot: config.pluginRoot,
          dataRoot: config.dataRoot,
        });
        context.ui.notify(
          `PAI initialized: ${report.created.length} created, ${report.skipped.length} preserved`,
          "info",
        );
      },
    });
    pi.registerCommand("pai-doctor", {
      description: "Check portable PAI runtime and private-state health without mutation",
      handler: async (_args, context) => {
        const report = runPaiDoctor({
          pluginRoot: config.pluginRoot,
          dataRoot: config.dataRoot,
          algorithmPath: config.algorithmPath,
          algorithmVersion: config.algorithmVersion,
        });
        const issues = report.checks
          .filter(({ status }) => status !== "pass")
          .map(({ id, status }) => `${id}:${status}`)
          .join(", ");
        context.ui.notify(
          `PAI doctor: ${report.passed} pass, ${report.warned} warn, ${report.failed} fail${issues ? ` (${issues})` : ""}`,
          report.failed > 0 ? "error" : report.warned > 0 ? "warning" : "info",
        );
      },
    });
    pi.registerCommand("pai-private-export", {
      description: "Export private TELOS and MEMORY state to a local archive",
      handler: async (args, context) => {
        const report = await exportPrivateState({
          dataRoot: config.dataRoot,
          archivePath: localPathArgument(args, "pai-private-export"),
        });
        context.ui.notify(
          `Private state exported: ${report.fileCount} files, SHA-256 ${report.archiveSha256}`,
          "info",
        );
      },
    });
    pi.registerCommand("pai-private-import", {
      description: "Import private TELOS and MEMORY state without overwriting files",
      handler: async (args, context) => {
        const report = await importPrivateState({
          dataRoot: config.dataRoot,
          archivePath: localPathArgument(args, "pai-private-import"),
        });
        context.ui.notify(
          `Private state imported: ${report.imported} files`,
          "info",
        );
      },
    });
  };
}

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default createPaiPlugin({ pluginRoot });
