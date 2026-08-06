import { describe, expect, test } from "bun:test";
import { buildTurnPolicy } from "../../src/runtime/pai-runtime-gate.ts";
import { routePaiPrompt } from "../../src/runtime/pai-runtime-contract.ts";

const roles = [
  ["actualModel", "openai-codex/gpt-5.6-sol"],
  ["piSubagentModel", "google/gemini-3-flash-preview"],
  ["piSlowModel", "anthropic/claude-opus-4-6"],
  ["piPlanModel", "anthropic/claude-sonnet-4-6"],
] as const;

describe("OMP role natural holdouts", () => {
  for (const [role, model] of roles) {
    test(`${role} uses the same provider-independent route contract`, () => {
      const atomic = routePaiPrompt("Исправь одну опечатку в заголовке заметки.", false);
      const complex = routePaiPrompt(
        "Собери многофайловый лендинг и проверь связанные шаблоны.",
        false,
      );
      expect(atomic.mode).toBe("native");
      expect(complex.mode).toBe("algorithm");
      const policy = buildTurnPolicy(complex, "/tmp/pai");
      expect(policy).toContain("OMP PAI TURN POLICY");
      expect(policy).not.toContain(model);
      expect(policy).not.toContain("provider request");
    });
  }
});
