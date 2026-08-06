import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  writeSync,
} from "node:fs";
import {
  atomicWriteStateText,
  ensureSafeStateDirectory,
  readStateText,
  resolveStatePath,
} from "./safe-state.ts";

export const MEMORY_KINDS = ["fact", "preference", "decision", "lesson", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MemoryRecord = {
  schemaVersion: 1;
  id: string;
  kind: MemoryKind;
  content: string;
  source: string;
  confidence: number;
  userConfirmed: boolean;
  createdAt: string;
};

export type RecordMemoryInput = {
  kind: MemoryKind;
  content: string;
  source: string;
  confidence: number;
  userConfirmed: boolean;
  createdAt?: string;
  id?: string;
};

export type MemorySearchResult = MemoryRecord & { score: number };

const RECORDS_PATH = "MEMORY/LEARNING/SYNTHESIS/memories.jsonl";
const INDEX_PATH = "MEMORY/STATE/memory-index.json";
const MAX_RECORDS_BYTES = 64 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && MEMORY_KINDS.includes(value as MemoryKind);
}

/** Validates one persisted MEMORY JSONL record against the runtime contract. */
export function parseMemoryRecord(value: unknown, line: number): MemoryRecord {
  if (value === null || typeof value !== "object") {
    throw new Error(`Invalid MEMORY record at line ${line}`);
  }
  const record = value as Partial<MemoryRecord>;
  const fields = [
    "schemaVersion",
    "id",
    "kind",
    "content",
    "source",
    "confidence",
    "userConfirmed",
    "createdAt",
  ];
  if (
    record.schemaVersion !== 1
    || typeof record.id !== "string"
    || !UUID_PATTERN.test(record.id)
    || !isMemoryKind(record.kind)
    || typeof record.content !== "string"
    || !record.content.trim()
    || record.content.includes("\0")
    || Buffer.byteLength(record.content) > 32 * 1024
    || typeof record.source !== "string"
    || !record.source.trim()
    || record.source.includes("\0")
    || Buffer.byteLength(record.source) > 1024
    || typeof record.confidence !== "number"
    || !Number.isFinite(record.confidence)
    || record.confidence < 0
    || record.confidence > 1
    || typeof record.userConfirmed !== "boolean"
    || ((record.kind === "fact" || record.kind === "preference") && !record.userConfirmed)
    || typeof record.createdAt !== "string"
    || Number.isNaN(Date.parse(record.createdAt))
    || Object.keys(record).some((key) => !fields.includes(key))
  ) {
    throw new Error(`Invalid MEMORY record at line ${line}`);
  }
  return record as MemoryRecord;
}

/** Reads bounded MEMORY JSONL and rejects malformed or duplicate records. */
export function readMemoryRecords(dataRoot: string): MemoryRecord[] {
  const path = resolveStatePath(dataRoot, RECORDS_PATH);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return [];
  const text = readStateText(dataRoot, RECORDS_PATH, MAX_RECORDS_BYTES);
  const records: MemoryRecord[] = [];
  const ids = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid MEMORY JSON at line ${index + 1}`, { cause: error });
    }
    const record = parseMemoryRecord(parsed, index + 1);
    if (ids.has(record.id)) throw new Error(`Duplicate MEMORY record id: ${record.id}`);
    ids.add(record.id);
    records.push(record);
  }
  return records;
}

function memoryTerms(text: string): string[] {
  return [...new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].sort();
}

function writeMemoryIndex(
  dataRoot: string,
  records: readonly MemoryRecord[],
): { records: number; path: string } {
  const index = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    records: records.map((record) => ({
      id: record.id,
      kind: record.kind,
      createdAt: record.createdAt,
      terms: memoryTerms(record.content),
    })),
  };
  const path = atomicWriteStateText(dataRoot, INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);
  return { records: records.length, path };
}

/** Rebuilds the deterministic retrieval index from canonical MEMORY records. */
export function rebuildMemoryIndex(dataRoot: string): { records: number; path: string } {
  return writeMemoryIndex(dataRoot, readMemoryRecords(dataRoot));
}

/** Appends one provenance-bearing MEMORY record after privacy and size checks. */
export function recordMemory(dataRoot: string, input: RecordMemoryInput): MemoryRecord {
  if (!isMemoryKind(input.kind)) throw new Error(`Unknown MEMORY kind: ${input.kind}`);
  const content = input.content.trim();
  const source = input.source.trim();
  if (!content || content.includes("\0")) {
    throw new Error("MEMORY content must be non-empty text without NUL bytes");
  }
  if (Buffer.byteLength(content) > 32 * 1024) throw new Error("MEMORY content exceeds 32768 byte limit");
  if (!source || Buffer.byteLength(source) > 1024) {
    throw new Error("MEMORY source must contain 1 to 1024 bytes");
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error("MEMORY confidence must be between 0 and 1");
  }
  if ((input.kind === "fact" || input.kind === "preference") && !input.userConfirmed) {
    throw new Error("Personal facts and preferences require explicit user confirmation");
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("MEMORY createdAt timestamp is invalid");
  const id = input.id ?? randomUUID();
  if (!UUID_PATTERN.test(id)) throw new Error("MEMORY id must be a UUID");
  const records = readMemoryRecords(dataRoot);
  if (records.some((record) => record.id === id)) throw new Error(`Duplicate MEMORY record id: ${id}`);

  const record: MemoryRecord = {
    schemaVersion: 1,
    id,
    kind: input.kind,
    content,
    source,
    confidence: input.confidence,
    userConfirmed: input.userConfirmed,
    createdAt,
  };
  ensureSafeStateDirectory(dataRoot, "MEMORY/LEARNING/SYNTHESIS");
  const path = resolveStatePath(dataRoot, RECORDS_PATH);

  const descriptor = openSync(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    chmodSync(path, 0o600);
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    const written = writeSync(descriptor, line);
    if (written !== line.byteLength) throw new Error("MEMORY record append was incomplete");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  records.push(record);
  writeMemoryIndex(dataRoot, records);
  return record;
}

/** Ranks MEMORY records by deterministic token overlap and confirmation weight. */
export function queryMemory(dataRoot: string, query: string, limit = 8): MemorySearchResult[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("MEMORY query limit must be an integer from 1 to 100");
  }
  const terms = memoryTerms(query);
  const results: MemorySearchResult[] = [];
  for (const record of readMemoryRecords(dataRoot)) {
    const normalized = record.content.toLocaleLowerCase();
    const termScore = terms.length === 0
      ? 1
      : terms.reduce((total, term) => total + (normalized.includes(term) ? 1 : 0), 0);
    if (termScore > 0) results.push({ ...record, score: termScore * record.confidence });
  }
  return results
    .sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}
