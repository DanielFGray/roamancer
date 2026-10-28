/**
 * Writes only the managed Postgres credential keys into an app's .env, leaving
 * every other line and comment unchanged.
 */

/** Replace or append keys in `updates`; non-matching lines stay byte-for-byte. */
export const applyManagedKeys = (
  contents: string,
  updates: Readonly<Record<string, string>>,
): string => {
  const keys = Object.keys(updates);
  if (keys.length === 0) return contents;

  const seen = new Set<string>();
  const hadTrailingNewline = contents.endsWith("\n");
  const body = contents.length === 0 ? "" : hadTrailingNewline ? contents.slice(0, -1) : contents;
  const lines = body.length === 0 && contents.length === 0 ? [] : body.split("\n");

  const rewritten = lines.map((line) => {
    const match = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/.exec(line);
    if (match === null) return line;
    const key = match[2]!;
    const value = updates[key];
    if (value === undefined) return line;
    seen.add(key);
    const exportPrefix = match[1] ?? "";
    return `${exportPrefix}${key}=${value}`;
  });

  for (const key of keys) {
    if (!seen.has(key)) rewritten.push(`${key}=${updates[key]!}`);
  }

  if (rewritten.length === 0) return hadTrailingNewline ? "\n" : "";
  return `${rewritten.join("\n")}${hadTrailingNewline || contents.length === 0 ? "\n" : ""}`;
};
