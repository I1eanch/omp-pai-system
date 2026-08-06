export type FrontmatterDocument = {
  fields: Record<string, string | null>;
  body: string;
};

/** Parses strict scalar YAML-style frontmatter without accepting duplicate keys. */
export function parseFrontmatter(content: string): FrontmatterDocument {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new Error("Document frontmatter is missing");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("Document frontmatter is not terminated");

  const fields: Record<string, string | null> = {};
  const lines = normalized.slice(4, end).split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`Invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!/^[a-z][a-z0-9_]*$/u.test(key)) throw new Error(`Invalid frontmatter key: ${key}`);
    if (key in fields) throw new Error(`Duplicate frontmatter key: ${key}`);
    fields[key] = rawValue === "null" ? null : rawValue;
  }
  return { fields, body: normalized.slice(end + 5) };
}

/** Serializes ordered scalar fields and a normalized Markdown body. */
export function serializeFrontmatter(
  fields: ReadonlyArray<readonly [string, string | null]>,
  body: string,
): string {
  const lines = fields.map(([key, value]) => `${key}: ${value ?? "null"}`);
  return `---\n${lines.join("\n")}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}
