import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import { createPaiPlugin } from "../../src/index.ts";

const pluginRoot = resolve(import.meta.dir, "../..");

test("loads native PAI runtime and resources through the official ExtensionRunner", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-pai-official-sdk-"));
  try {
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: join(root, "agent"),
      sessionManager: SessionManager.inMemory(),
      disableExtensionDiscovery: true,
      extensions: [createPaiPlugin({
        pluginRoot,
        env: {
          HOME: root,
          OMP_PAI_DATA_DIR: join(root, "pai"),
        },
      })],
      systemPrompt: ["base"],
    });
    try {
      const runner = session.extensionRunner;
      expect(runner).toBeDefined();

      const start = await runner!.emitBeforeAgentStart(
        "Собери многофайловый лендинг.",
        undefined,
        ["base"],
      );
      expect(start?.systemPrompt?.[0]).toBe("base");
      expect(start?.systemPrompt?.join("\n\n")).toContain("OMP PAI TURN POLICY");
      expect(start?.systemPrompt?.join("\n\n")).toContain("Internal mode: ALGORITHM");
      expect(start?.systemPrompt?.join("\n\n")).not.toContain("Entering the PAI");

      const payload = {
        model: "gemini-3-flash-preview",
        config: { thinkingConfig: { thinkingLevel: "HIGH" } },
      };
      expect(await runner!.emitBeforeProviderRequest(payload)).toEqual(payload);

      const resources = await runner!.emitResourcesDiscover(root, "startup");
      expect(resources.skillPaths).toContainEqual({
        path: join(pluginRoot, "skills"),
        extensionPath: "<inline-0>",
      });

      const subagent = await runner!.emitBeforeAgentStart(
        "Проверь папку.",
        undefined,
        ["You are operating on a piece of work assigned to you by the main agent."],
      );
      expect(subagent?.systemPrompt?.join("\n\n")).toContain("Internal mode: NATIVE");
    } finally {
      await session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
