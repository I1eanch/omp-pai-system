import { lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readOwnership } from "./init.ts";
import { listPrivateFiles } from "../private-bundle.ts";

export type DoctorCheck = {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
};

export type PaiDoctorInput = {
  pluginRoot: string;
  dataRoot: string;
  algorithmPath: string;
  algorithmVersion: string;
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

function regularFileFollowingSymlink(path: string): boolean {
  try {
    return Boolean(statSync(path, { throwIfNoEntry: false })?.isFile());
  } catch {
    return false;
  }
}

function directoryCheck(id: string, path: string, label: string): DoctorCheck {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return { id, status: "warn", message: `${label} is not initialized` };
  if (info.isSymbolicLink() || !info.isDirectory()) {
    return { id, status: "fail", message: `${label} is not a safe directory` };
  }
  return { id, status: "pass", message: `${label} is a local directory` };
}

function jsonStateCheck(id: string, path: string, label: string): DoctorCheck {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return { id, status: "warn", message: `${label} is not initialized` };
  if (!info.isFile() || info.isSymbolicLink()) {
    return { id, status: "fail", message: `${label} is not a safe file` };
  }
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return { id, status: "pass", message: `${label} contains valid JSON` };
  } catch {
    return { id, status: "fail", message: `${label} contains invalid JSON` };
  }
}

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

  const algorithmSafe = regularFileFollowingSymlink(input.algorithmPath);
  checks.push(algorithmSafe
    ? { id: "algorithm-source", status: "pass", message: "Algorithm source is a regular file" }
    : { id: "algorithm-source", status: "fail", message: "Algorithm source is missing or unsafe" });
  if (algorithmSafe) {
    const marker = `## The Algorithm ${input.algorithmVersion}`;
    checks.push(readFileSync(input.algorithmPath, "utf8").includes(marker)
      ? { id: "algorithm-version", status: "pass", message: `Algorithm ${input.algorithmVersion} marker matches` }
      : { id: "algorithm-version", status: "fail", message: "Algorithm version marker does not match" });
  } else {
    checks.push({ id: "algorithm-version", status: "fail", message: "Algorithm version cannot be verified" });
  }

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

  try {
    const ownership = readOwnership(dataRoot);
    checks.push(ownership
      ? { id: "ownership", status: "pass", message: "Ownership manifest is valid" }
      : { id: "ownership", status: "warn", message: "Ownership manifest is not initialized" });
  } catch {
    checks.push({ id: "ownership", status: "fail", message: "Ownership manifest is invalid or unsafe" });
  }

  checks.push(jsonStateCheck("telos-schema", join(dataRoot, "TELOS/schema.json"), "TELOS schema"));
  checks.push(jsonStateCheck("memory-layout", join(dataRoot, "MEMORY/layout.json"), "MEMORY layout"));
  checks.push(jsonStateCheck("work-registry", join(dataRoot, "MEMORY/STATE/work.json"), "Work registry"));

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
