/** Narrows an unknown value to a non-null, non-array string-keyed record. */
export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
