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

test("loads and chains through the official OMP ExtensionRunner", async () => {
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
        "Собери многофайловый Astro/Tilda лендинг.",
        undefined,
        ["base"],
      );
      expect(start?.systemPrompt?.[0]).toBe("base");
      expect(start?.systemPrompt?.join("\n\n")).toContain("OMP PAI RUNTIME GATE");

      const providerPayload = await runner!.emitBeforeProviderRequest({
        model: "gemini-3-flash-preview",
        contents: [],
        config: {
          thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true },
        },
      }) as Record<string, any>;
      expect(providerPayload.config.thinkingConfig).toEqual({
        thinkingLevel: "MINIMAL",
        includeThoughts: false,
      });
      expect(providerPayload.config.systemInstruction.parts.at(-1).text)
        .toContain("This OMP turn requires ALGORITHM");

      const subagent = await runner!.emitBeforeAgentStart(
        "Собери многофайловый Astro/Tilda лендинг.",
        undefined,
        ["COOP", "You are operating on a piece of work assigned to you by the main agent."],
      );
      expect(subagent?.systemPrompt?.join("\n\n")).toContain("This OMP turn requires NATIVE");
    } finally {
      await session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
