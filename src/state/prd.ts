import { lstatSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { parseFrontmatter } from "./frontmatter.ts";
import { atomicWriteStateText, readStateText, resolveStatePath } from "./safe-state.ts";

export const PRD_PHASES = [
  "observe",
  "think",
  "plan",
  "build",
  "execute",
  "verify",
  "learn",
  "complete",
] as const;
export type PrdPhase = (typeof PRD_PHASES)[number];

export type PrdCriterion = {
  id: string;
  text: string;
  checked: boolean;
};

export type PrdDocument = {
  task: string;
  slug: string;
  effort: string;
  phase: PrdPhase;
  progress: string;
  mode: string;
  started: string;
  updated: string;
  criteria: PrdCriterion[];
  content: string;
  path: string;
};

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const CRITERION_PATTERN = /^- \[([ xX])\] (ISC-(?:A\d*|\d+)): (\S.*)$/u;
const REQUIRED_FIELDS = ["task", "slug", "effort", "phase", "progress", "mode", "started", "updated"];

/** Parses and validates a PRD document, criteria, and progress invariants. */
export function parsePrd(content: string, path: string): PrdDocument {
  const { fields, body } = parseFrontmatter(content);
  for (const key of REQUIRED_FIELDS) {
    if (typeof fields[key] !== "string" || !fields[key]) {
      throw new Error(`PRD field ${key} is missing: ${path}`);
    }
  }
  const allowed = new Set([...REQUIRED_FIELDS, "iteration"]);
  const unknown = Object.keys(fields).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown PRD fields: ${unknown.join(", ")}`);
  if (!SLUG_PATTERN.test(fields.slug!)) throw new Error(`Invalid PRD slug: ${path}`);
  if (!PRD_PHASES.includes(fields.phase as PrdPhase)) throw new Error(`Invalid PRD phase: ${path}`);
  if (Number.isNaN(Date.parse(fields.started!)) || Number.isNaN(Date.parse(fields.updated!))) {
    throw new Error(`Invalid PRD timestamp: ${path}`);
  }

  const criteria: PrdCriterion[] = [];
  const ids = new Set<string>();
  for (const line of body.split("\n")) {
    const match = line.match(CRITERION_PATTERN);
    if (!match) continue;
    const id = match[2]!;
    if (ids.has(id)) throw new Error(`Duplicate PRD criterion: ${id}`);
    ids.add(id);
    criteria.push({ id, text: match[3]!, checked: match[1]!.toLowerCase() === "x" });
  }
  const completed = criteria.filter(({ checked }) => checked).length;
  const expectedProgress = `${completed}/${criteria.length}`;
  if (fields.progress !== expectedProgress) {
    throw new Error(`PRD progress ${fields.progress} does not match ${expectedProgress}: ${path}`);
  }

  return {
    task: fields.task!,
    slug: fields.slug!,
    effort: fields.effort!,
    phase: fields.phase as PrdPhase,
    progress: fields.progress!,
    mode: fields.mode!,
    started: fields.started!,
    updated: fields.updated!,
    criteria,
    content,
    path,
  };
}

/** Reads one PRD by safe slug and verifies path/frontmatter consistency. */
export function readPrd(dataRoot: string, slug: string): PrdDocument {
  if (!SLUG_PATTERN.test(slug)) throw new Error("PRD slug is invalid");
  const path = `MEMORY/WORK/${slug}/PRD.md`;
  const prd = parsePrd(readStateText(dataRoot, path, 4 * 1024 * 1024), path);
  if (prd.slug !== slug) throw new Error(`PRD slug does not match directory: ${path}`);
  return prd;
}

/** Lists every valid PRD beneath the owner-controlled MEMORY work root. */
export function listPrds(dataRoot: string): PrdDocument[] {
  const workRoot = resolveStatePath(dataRoot, "MEMORY/WORK");
  const info = lstatSync(workRoot, { throwIfNoEntry: false });
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("PRD work root is unsafe");
  const documents: PrdDocument[] = [];
  for (const entry of readdirSync(workRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`PRD work entry is a symlink: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    if (!SLUG_PATTERN.test(entry.name)) throw new Error(`Invalid PRD directory: ${entry.name}`);
    const prdPath = join(workRoot, entry.name, "PRD.md");
    const prdInfo = lstatSync(prdPath, { throwIfNoEntry: false });
    if (!prdInfo) continue;
    documents.push(readPrd(dataRoot, entry.name));
  }
  return documents.sort((left, right) => right.updated.localeCompare(left.updated));
}

/** Rebuilds the work registry from canonical PRD documents. */
export function syncPrdRegistry(dataRoot: string): { sessions: number; path: string } {
  const documents = listPrds(dataRoot);
  const sessions = Object.fromEntries(documents.map((prd) => [prd.slug, {
    prd: prd.path,
    phase: prd.phase,
    progress: prd.progress,
    updated: prd.updated,
  }]));
  const path = atomicWriteStateText(
    dataRoot,
    "MEMORY/STATE/work.json",
    `${JSON.stringify({ schemaVersion: 1, sessions }, null, 2)}\n`,
  );
  return { sessions: documents.length, path };
}

/** Atomically writes a validated PRD and synchronizes the work registry. */
export function writePrd(dataRoot: string, content: string): PrdDocument {
  const preview = parsePrd(content, "PRD.md");
  const path = `MEMORY/WORK/${preview.slug}/PRD.md`;
  atomicWriteStateText(dataRoot, path, content.endsWith("\n") ? content : `${content}\n`);
  const prd = readPrd(dataRoot, preview.slug);
  syncPrdRegistry(dataRoot);
  return prd;
}

function pointsInsideWorkRoot(dataRoot: string, candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;
  const path = candidate.split(":", 1)[0]!;
  const workRoot = resolve(join(dataRoot, "MEMORY/WORK"));
  const resolved = resolve(path);
  const fromRoot = relative(workRoot, resolved);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

/** Synchronizes the PRD registry after successful OMP write/edit tool results. */
export function registerPrdSyncHook(pi: ExtensionAPI, dataRoot: string): void {
  pi.on("tool_result", (event) => {
    if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;
    const candidates = [
      event.input.path,
      ...(Array.isArray(event.input.paths) ? event.input.paths : []),
    ];
    if (candidates.some((path) => pointsInsideWorkRoot(dataRoot, path))) {
      syncPrdRegistry(dataRoot);
    }
  });
}
