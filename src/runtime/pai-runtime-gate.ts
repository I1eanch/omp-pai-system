import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  PAI_RUNTIME_CONTRACT,
  routePaiPrompt,
  type PaiMode,
  type PaiRoute,
} from "./pai-runtime-contract.ts";

export type PaiRuntimeOptions = {
  dataRoot: string;
  skillRoot: string;
};
type OmpThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];


const SUBAGENT_MARKERS = [
  "You are operating on a piece of work assigned to you by the main agent.",
  "<subagent>",
] as const;

/** Detects official and legacy OMP subagent markers in the system prompt. */
export function isSubagentSystemPrompt(systemPrompt: readonly string[]): boolean {
  return systemPrompt.some((part) => SUBAGENT_MARKERS.some((marker) => part.includes(marker)));
}

/** Maps a PAI mode to the native OMP thinking level. */
export function thinkingLevelForMode(mode: PaiMode): OmpThinkingLevel {
  return PAI_RUNTIME_CONTRACT.modes[mode].thinking as OmpThinkingLevel;
}

/** Builds compact hidden per-turn policy with only local state-root references. */
export function buildTurnPolicy(route: PaiRoute, dataRoot: string): string {
  const roots = [
    `TELOS root: ${JSON.stringify(join(dataRoot, "TELOS"))}`,
    `MEMORY root: ${JSON.stringify(join(dataRoot, "MEMORY"))}`,
    `PAI definitions root: ${JSON.stringify(join(dataRoot, "PAI"))}`,
  ].join("\n");
  const algorithmPolicy = route.mode === "algorithm"
    ? "Use the pai-deep-work skill when its structured workflow helps. For work with three or more steps, use OMP native todo/goal state; do not create ritual PRD files unless persistent project state is genuinely required."
    : "Use the normal OMP workflow and only the tools needed to complete the request.";

  return [
    "OMP PAI TURN POLICY",
    `Internal mode: ${route.mode.toUpperCase()} (${route.reason}). Do not print mode headers or protocol lines.`,
    algorithmPolicy,
    "Complete the user request end to end, verify behavioral changes, and report concise evidence.",
    "Load TELOS or MEMORY only on demand through PAI tools. Never invent missing personal context.",
    "Never contact voice, TTS, notification, or telemetry services on behalf of PAI.",
    roots,
  ].join("\n");
}

/** Registers the native OMP lifecycle hooks that apply routing and hidden policy. */
export function createPaiRuntime(options: PaiRuntimeOptions): (pi: ExtensionAPI) => void {
  return (pi) => {
    let activeRoute: PaiRoute | null = null;

    pi.on("resources_discover", () => ({
      skillPaths: [options.skillRoot],
    }));

    pi.on("before_agent_start", (event) => {
      activeRoute = routePaiPrompt(event.prompt, isSubagentSystemPrompt(event.systemPrompt));
      try {
        pi.setThinkingLevel(thinkingLevelForMode(activeRoute.mode));
      } catch (error) {
        pi.logger.warn("Unable to apply PAI thinking level", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        systemPrompt: [
          ...event.systemPrompt,
          buildTurnPolicy(activeRoute, options.dataRoot),
        ],
      };
    });

    pi.on("turn_end", (event) => {
      if (!activeRoute) return;
      pi.appendEntry("pai-runtime-route", {
        schemaVersion: 1,
        turnIndex: event.turnIndex,
        mode: activeRoute.mode,
        reason: activeRoute.reason,
      });
    });
  };
}
