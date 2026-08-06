import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { loadActionManifest } from "../automation/actions.ts";
import { loadFlowDefinition } from "../automation/flows.ts";
import { loadPipelineDefinition } from "../automation/pipelines.ts";
import { listPrivateFiles } from "../private-bundle.ts";
import { readMemoryRecords } from "../state/memory.ts";
import { listPrds } from "../state/prd.ts";
import { readTelosRecords } from "../state/telos.ts";
import { isUnknownRecord } from "../type-guards.ts";
import { readOwnership } from "./init.ts";

export type DoctorCheck = {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
};

export type PaiDoctorInput = {
  pluginRoot: string;
  dataRoot: string;
};

export type PaiDoctorReport = {
  checks: DoctorCheck[];
  passed: number;
  warned: number;
  failed: number;
};

function regularFile(path: string): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

function directoryCheck(id: string, path: string, label: string): DoctorCheck {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return { id, status: "warn", message: `${label} is not initialized` };
  if (info.isSymbolicLink() || !info.isDirectory()) {
    return { id, status: "fail", message: `${label} is not a safe directory` };
  }
  return { id, status: "pass", message: `${label} is a local directory` };
}

function schemaCheck(id: string, label: string, validate: () => number): DoctorCheck {
  try {
    const count = validate();
    return { id, status: "pass", message: `${label} is valid (${count} records)` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id, status: "fail", message: `${label} is invalid: ${message}` };
  }
}

function validateTelosSchema(dataRoot: string): number {
  const parsed: unknown = JSON.parse(readFileSync(join(dataRoot, "TELOS/schema.json"), "utf8"));
  if (!isUnknownRecord(parsed) || !isUnknownRecord(parsed.properties)) {
    throw new Error("TELOS schema contract mismatch");
  }
  const recordType = parsed.properties.record_type;
  const status = parsed.properties.status;
  if (
    !isUnknownRecord(recordType)
    || !Array.isArray(recordType.enum)
    || !recordType.enum.includes("goals")
    || !isUnknownRecord(status)
    || !Array.isArray(status.enum)
    || !status.enum.includes("active")
  ) {
    throw new Error("TELOS schema contract mismatch");
  }
  return readTelosRecords(dataRoot).length;
}

function validateMemoryState(dataRoot: string): number {
  const layout: unknown = JSON.parse(readFileSync(join(dataRoot, "MEMORY/layout.json"), "utf8"));
  if (
    !isUnknownRecord(layout)
    || layout.schemaVersion !== 1
    || !Array.isArray(layout.directories)
    || !layout.directories.includes("WORK")
    || !layout.directories.includes("STATE")
  ) {
    throw new Error("MEMORY layout contract mismatch");
  }
  const work: unknown = JSON.parse(readFileSync(join(dataRoot, "MEMORY/STATE/work.json"), "utf8"));
  if (!isUnknownRecord(work) || work.schemaVersion !== 1 || !isUnknownRecord(work.sessions)) {
    throw new Error("work registry contract mismatch");
  }
  const memoryRecords = readMemoryRecords(dataRoot);
  const prds = listPrds(dataRoot);
  return memoryRecords.length + prds.length;
}

function automationCheck(dataRoot: string): DoctorCheck {
  try {
    let definitions = 0;
    const actionsRoot = join(dataRoot, "PAI/ACTIONS");
    const actionInfo = lstatSync(actionsRoot, { throwIfNoEntry: false });
    if (actionInfo) {
      if (!actionInfo.isDirectory() || actionInfo.isSymbolicLink()) throw new Error("ACTIONS root is unsafe");
      for (const entry of readdirSync(actionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe ACTIONS entry: ${entry.name}`);
        loadActionManifest(dataRoot, entry.name);
        definitions += 1;
      }
    }
    for (const kind of ["FLOWS", "PIPELINES"] as const) {
      const root = join(dataRoot, `PAI/${kind}`);
      const info = lstatSync(root, { throwIfNoEntry: false });
      if (!info) continue;
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${kind} root is unsafe`);
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || extname(entry.name) !== ".json") {
          throw new Error(`Unsafe ${kind} entry: ${entry.name}`);
        }
        const id = basename(entry.name, ".json");
        if (kind === "FLOWS") loadFlowDefinition(dataRoot, id);
        else loadPipelineDefinition(dataRoot, id);
        definitions += 1;
      }
    }
    return {
      id: "automation-definitions",
      status: "pass",
      message: `Automation definitions are valid (${definitions} definitions)`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: "automation-definitions", status: "fail", message };
  }
}

function permissionCheck(dataRoot: string): DoctorCheck {
  const rootInfo = lstatSync(dataRoot, { throwIfNoEntry: false });
  if (!rootInfo) {
    return { id: "private-permissions", status: "warn", message: "PAI data root is not initialized" };
  }
  const pending = [dataRoot];
  let checked = 0;
  try {
    while (pending.length > 0) {
      const path = pending.pop()!;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`symlink: ${path}`);
      if ((info.mode & 0o077) !== 0) {
        throw new Error(`group/world permissions on ${path} (${(info.mode & 0o777).toString(8)})`);
      }
      checked += 1;
      if (info.isDirectory()) {
        for (const entry of readdirSync(path)) pending.push(join(path, entry));
      } else if (!info.isFile()) {
        throw new Error(`unsupported file type: ${path}`);
      }
    }
    return {
      id: "private-permissions",
      status: "pass",
      message: `Private state permissions are owner-only (${checked} paths)`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: "private-permissions", status: "fail", message: `Private permissions are unsafe: ${message}` };
  }
}

/** Runs read-only installation, schema, permission, and private-state diagnostics. */
export function runPaiDoctor(input: PaiDoctorInput): PaiDoctorReport {
  const pluginRoot = resolve(input.pluginRoot);
  const dataRoot = resolve(input.dataRoot);
  const checks: DoctorCheck[] = [];

  try {
    const packageJson = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
    checks.push(packageJson.name === "omp-pai-system" && typeof packageJson.version === "string"
      ? { id: "package", status: "pass", message: `Package metadata is valid (${packageJson.version})` }
      : { id: "package", status: "fail", message: "Package metadata is invalid" });
  } catch {
    checks.push({ id: "package", status: "fail", message: "Package metadata is unreadable" });
  }

  checks.push(regularFile(join(pluginRoot, "skills/pai-deep-work/SKILL.md"))
    ? { id: "pai-skill", status: "pass", message: "OMP-native PAI skill is available" }
    : { id: "pai-skill", status: "fail", message: "OMP-native PAI skill is missing or unsafe" });

  const templateFiles = [
    "README.md",
    "PRDFORMAT.md",
    "CONTEXT_ROUTING.md",
    "ACTIONS/README.md",
    "FLOWS/README.md",
    "PIPELINES/README.md",
  ];
  checks.push(templateFiles.every((path) => regularFile(join(pluginRoot, "templates/PAI", path)))
    ? { id: "pai-templates", status: "pass", message: "Portable PAI templates are complete" }
    : { id: "pai-templates", status: "fail", message: "Portable PAI templates are incomplete or unsafe" });

  checks.push(directoryCheck("state-root", dataRoot, "PAI data root"));
  checks.push(directoryCheck("telos-root", join(dataRoot, "TELOS"), "TELOS root"));
  checks.push(directoryCheck("memory-root", join(dataRoot, "MEMORY"), "MEMORY root"));
  checks.push(permissionCheck(dataRoot));

  try {
    const ownership = readOwnership(dataRoot);
    checks.push(ownership
      ? { id: "ownership", status: "pass", message: "Ownership manifest is valid" }
      : { id: "ownership", status: "warn", message: "Ownership manifest is not initialized" });
  } catch {
    checks.push({ id: "ownership", status: "fail", message: "Ownership manifest is invalid or unsafe" });
  }

  checks.push(lstatSync(join(dataRoot, "TELOS"), { throwIfNoEntry: false })
    ? schemaCheck("telos-state", "TELOS state", () => validateTelosSchema(dataRoot))
    : { id: "telos-state", status: "warn", message: "TELOS state is not initialized" });
  checks.push(lstatSync(join(dataRoot, "MEMORY"), { throwIfNoEntry: false })
    ? schemaCheck("memory-state", "MEMORY and PRD state", () => validateMemoryState(dataRoot))
    : { id: "memory-state", status: "warn", message: "MEMORY state is not initialized" });
  checks.push(automationCheck(dataRoot));

  try {
    const files = listPrivateFiles(dataRoot);
    checks.push({
      id: "private-path-safety",
      status: "pass",
      message: `Private state contains ${files.length} safe regular files`,
    });
  } catch {
    checks.push({
      id: "private-path-safety",
      status: "fail",
      message: "Private state contains an unsafe path or file type",
    });
  }

  return {
    checks,
    passed: checks.filter(({ status }) => status === "pass").length,
    warned: checks.filter(({ status }) => status === "warn").length,
    failed: checks.filter(({ status }) => status === "fail").length,
  };
}
