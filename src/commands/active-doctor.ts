import { lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DoctorCheck, PaiDoctorReport } from "./doctor.ts";

export type ActivePaiDoctorInput = {
  profileRoot: string;
  algorithmPath: string;
  algorithmVersion: string;
  paiTemplateRoot: string;
  memoryRoot: string;
  telosRoot: string;
};

const PAI_TEMPLATE_FILES = [
  "README.md",
  "PRDFORMAT.md",
  "CONTEXT_ROUTING.md",
  "ACTIONS/README.md",
  "FLOWS/README.md",
  "PIPELINES/README.md",
];

const MEMORY_DIRECTORIES = [
  "WORK",
  "STATE",
  "LEARNING",
  "LEARNING/SYSTEM",
  "LEARNING/ALGORITHM",
  "LEARNING/SYNTHESIS",
  "LEARNING/SIGNALS",
  "LEARNING/FAILURES",
  "LEARNING/REFLECTIONS",
  "SECURITY",
  "RESEARCH",
];

const TELOS_FILES = [
  "BELIEFS.md",
  "CHALLENGES.md",
  "DECISIONS.md",
  "GOALS.md",
  "IDEAS.md",
  "LEARNED.md",
  "MISSION.md",
  "MODELS.md",
  "NARRATIVES.md",
  "PROJECTS.md",
  "STRATEGIES.md",
  "Updates.md",
];

function directoryCheck(id: string, path: string, label: string): DoctorCheck {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return { id, status: "warn", message: `${label} is not initialized` };
  if (info.isSymbolicLink() || !info.isDirectory()) {
    return { id, status: "fail", message: `${label} is not a safe directory` };
  }
  return { id, status: "pass", message: `${label} is a local directory` };
}

function regularFileFollowingSymlink(path: string): boolean {
  try {
    return Boolean(statSync(path, { throwIfNoEntry: false })?.isFile());
  } catch {
    return false;
  }
}

function advisorContractCheck(profileRoot: string): DoctorCheck {
  let found = false;
  for (const filename of ["WATCHDOG.yml", "WATCHDOG.yaml"]) {
    const path = join(profileRoot, filename);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) continue;
    found = true;
    if (info.isSymbolicLink() || !info.isFile()) {
      return { id: "advisor-contract", status: "fail", message: `${filename} is not a safe file` };
    }
    if (readFileSync(path, "utf8").includes("ADVISOR IS NOT A PAI EXECUTOR")) {
      return { id: "advisor-contract", status: "pass", message: "Advisor role boundary is installed" };
    }
  }
  return found
    ? { id: "advisor-contract", status: "fail", message: "Advisor role boundary marker is missing" }
    : { id: "advisor-contract", status: "warn", message: "Advisor contract is not installed" };
}

export function runActivePaiDoctor(input: ActivePaiDoctorInput): PaiDoctorReport {
  const profileRoot = resolve(input.profileRoot);
  const paiTemplateRoot = resolve(input.paiTemplateRoot);
  const memoryRoot = resolve(input.memoryRoot);
  const telosRoot = resolve(input.telosRoot);
  const checks: DoctorCheck[] = [];

  const algorithmSafe = regularFileFollowingSymlink(input.algorithmPath);
  checks.push(algorithmSafe
    ? { id: "algorithm-source", status: "pass", message: "Algorithm source is a regular file" }
    : { id: "algorithm-source", status: "fail", message: "Algorithm source is missing or unsafe" });
  checks.push(
    algorithmSafe
    && readFileSync(input.algorithmPath, "utf8").includes(`## The Algorithm ${input.algorithmVersion}`)
      ? {
          id: "algorithm-version",
          status: "pass",
          message: `Algorithm ${input.algorithmVersion} marker matches`,
        }
      : {
          id: "algorithm-version",
          status: "fail",
          message: "Algorithm version marker does not match",
        },
  );

  checks.push(directoryCheck("pai-root", paiTemplateRoot, "Active PAI root"));
  checks.push(
    PAI_TEMPLATE_FILES.every((path) => regularFileFollowingSymlink(join(paiTemplateRoot, path)))
      ? { id: "pai-files", status: "pass", message: "Active PAI files are complete" }
      : { id: "pai-files", status: "fail", message: "Active PAI files are incomplete or unsafe" },
  );

  checks.push(directoryCheck("memory-root", memoryRoot, "Active MEMORY root"));
  checks.push(
    MEMORY_DIRECTORIES.every((path) =>
      lstatSync(join(memoryRoot, path), { throwIfNoEntry: false })?.isDirectory()
    )
      ? { id: "memory-layout", status: "pass", message: "Active MEMORY layout is complete" }
      : { id: "memory-layout", status: "fail", message: "Active MEMORY layout is incomplete" },
  );

  checks.push(directoryCheck("telos-root", telosRoot, "Active TELOS root"));
  checks.push(
    TELOS_FILES.every((path) => regularFileFollowingSymlink(join(telosRoot, path)))
      ? { id: "telos-files", status: "pass", message: "Active TELOS files are complete" }
      : { id: "telos-files", status: "fail", message: "Active TELOS files are incomplete or unsafe" },
  );
  checks.push(advisorContractCheck(profileRoot));

  return {
    checks,
    passed: checks.filter(({ status }) => status === "pass").length,
    warned: checks.filter(({ status }) => status === "warn").length,
    failed: checks.filter(({ status }) => status === "fail").length,
  };
}
