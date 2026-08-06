import { lstatSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteStateText, readStateText, resolveStatePath } from "./safe-state.ts";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.ts";

export const TELOS_RECORD_TYPES = [
  "beliefs",
  "challenges",
  "decisions",
  "goals",
  "ideas",
  "learned",
  "projects",
] as const;

export type TelosRecordType = (typeof TELOS_RECORD_TYPES)[number];
export type TelosStatus = "starter" | "active" | "archived";

export type TelosRecord = {
  schemaVersion: 1;
  recordType: TelosRecordType;
  status: TelosStatus;
  updated: string | null;
  body: string;
  path: string;
};

export type TelosSearchResult = {
  recordType: TelosRecordType;
  path: string;
  text: string;
  score: number;
};

const FILE_BY_TYPE: Record<TelosRecordType, string> = {
  beliefs: "BELIEFS.md",
  challenges: "CHALLENGES.md",
  decisions: "DECISIONS.md",
  goals: "GOALS.md",
  ideas: "IDEAS.md",
  learned: "LEARNED.md",
  projects: "PROJECTS.md",
};

const STATUS_VALUES: readonly TelosStatus[] = ["starter", "active", "archived"];

function isTelosRecordType(value: string | null | undefined): value is TelosRecordType {
  return typeof value === "string" && TELOS_RECORD_TYPES.includes(value as TelosRecordType);
}

/** Parses one strict TELOS Markdown record and validates its frontmatter. */
export function parseTelosRecord(content: string, path: string): TelosRecord {
  const { fields, body } = parseFrontmatter(content);
  const allowedFields = ["schema_version", "record_type", "status", "updated"];
  const unknown = Object.keys(fields).filter((key) => !allowedFields.includes(key));
  if (unknown.length > 0 || Object.keys(fields).length !== allowedFields.length) {
    throw new Error(`Invalid TELOS frontmatter fields: ${path}`);
  }
  if (fields.schema_version !== "1") throw new Error(`Invalid TELOS schema version: ${path}`);
  if (!isTelosRecordType(fields.record_type)) throw new Error(`Invalid TELOS record type: ${path}`);
  if (!STATUS_VALUES.includes(fields.status as TelosStatus)) throw new Error(`Invalid TELOS status: ${path}`);
  if (fields.updated !== null && Number.isNaN(Date.parse(fields.updated ?? ""))) {
    throw new Error(`Invalid TELOS updated timestamp: ${path}`);
  }
  if (!body.includes("## Entries")) throw new Error(`TELOS Entries section is missing: ${path}`);

  return {
    schemaVersion: 1,
    recordType: fields.record_type,
    status: fields.status as TelosStatus,
    updated: fields.updated,
    body,
    path,
  };
}

/** Loads every canonical TELOS record from owner-controlled state. */
export function readTelosRecords(dataRoot: string): TelosRecord[] {
  const records: TelosRecord[] = [];
  for (const type of TELOS_RECORD_TYPES) {
    const relativePath = `TELOS/${FILE_BY_TYPE[type]}`;
    const path = resolveStatePath(dataRoot, relativePath);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) continue;
    const record = parseTelosRecord(readStateText(dataRoot, relativePath), relativePath);
    if (record.recordType !== type) {
      throw new Error(`TELOS record type does not match filename: ${relativePath}`);
    }
    records.push(record);
  }
  return records;
}

function searchTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
}

function entryBlocks(body: string): string[] {
  const entriesAt = body.indexOf("## Entries");
  if (entriesAt < 0) return [];
  return body
    .slice(entriesAt + "## Entries".length)
    .trim()
    .split(/\n(?=###\s)|\n{2,}/u)
    .map((block) => block.trim())
    .filter(Boolean);
}

/** Ranks TELOS entry blocks by deterministic query-token overlap. */
export function queryTelos(dataRoot: string, query: string, limit = 8): TelosSearchResult[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("TELOS query limit must be an integer from 1 to 100");
  }
  const terms = searchTerms(query);
  const results: TelosSearchResult[] = [];
  for (const record of readTelosRecords(dataRoot)) {
    if (record.status === "archived") continue;
    for (const block of entryBlocks(record.body)) {
      const normalized = block.toLocaleLowerCase();
      const score = terms.length === 0
        ? 1
        : terms.reduce((total, term) => total + (normalized.includes(term) ? 1 : 0), 0);
      if (score === 0) continue;
      results.push({
        recordType: record.recordType,
        path: record.path,
        text: block.slice(0, 4_000),
        score,
      });
    }
  }
  return results
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);
}

/** Appends a validated durable entry and atomically updates its TELOS file. */
export function appendTelosEntry(
  dataRoot: string,
  recordType: TelosRecordType,
  text: string,
  updated = new Date().toISOString(),
): TelosRecord {
  if (!isTelosRecordType(recordType)) throw new Error(`Unknown TELOS record type: ${recordType}`);
  const entry = text.trim();
  if (!entry || entry.includes("\0")) throw new Error("TELOS entry must be non-empty text without NUL bytes");
  if (Buffer.byteLength(entry) > 32 * 1024) throw new Error("TELOS entry exceeds 32768 byte limit");
  if (Number.isNaN(Date.parse(updated))) throw new Error("TELOS updated timestamp is invalid");

  const relativePath = join("TELOS", FILE_BY_TYPE[recordType]).split("\\").join("/");
  const current = parseTelosRecord(readStateText(dataRoot, relativePath), relativePath);
  if (current.recordType !== recordType) {
    throw new Error(`TELOS record type does not match filename: ${relativePath}`);
  }
  const body = `${current.body.trimEnd()}\n\n### ${updated}\n\n${entry}\n`;
  const content = serializeFrontmatter([
    ["schema_version", "1"],
    ["record_type", recordType],
    ["status", "active"],
    ["updated", updated],
  ], body);
  atomicWriteStateText(dataRoot, relativePath, content);
  return parseTelosRecord(content, relativePath);
}
