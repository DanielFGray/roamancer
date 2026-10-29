/**
 * Writes only the managed Postgres credential keys into an app's .env, leaving
 * every other line and comment unchanged. Strips the ROOT_DATABASE_* keys it does not
 * manage: the shared cluster is administered by `ops`, not by a superuser URL in the app env.
 */

const isRootDatabaseKey = (key: string) => key.startsWith("ROOT_DATABASE_");

/** Drop ROOT_DATABASE_* lines not named in `keep`; keep everything else byte-for-byte. */
const stripRootDatabaseKeys = (contents: string, keep: ReadonlySet<string>): string => {
  const hadTrailingNewline = contents.endsWith("\n");
  const body = contents.length === 0 ? "" : hadTrailingNewline ? contents.slice(0, -1) : contents;
  const lines = body.length === 0 && contents.length === 0 ? [] : body.split("\n");
  const kept = lines.filter((line) => {
    const match = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return match === null || keep.has(match[2]!) || !isRootDatabaseKey(match[2]!);
  });
  if (kept.length === 0) return hadTrailingNewline || contents.length === 0 ? "\n" : "";
  return `${kept.join("\n")}${hadTrailingNewline || contents.length === 0 ? "\n" : ""}`;
};

/** Replace or append keys in `updates`; non-matching lines stay byte-for-byte. */
export const applyManagedKeys = (
  contents: string,
  updates: Readonly<Record<string, string>>,
): string => {
  const keys = Object.keys(updates);
  const withoutRoot = stripRootDatabaseKeys(contents, new Set(keys));
  if (keys.length === 0) return withoutRoot;

  const seen = new Set<string>();
  const hadTrailingNewline = withoutRoot.endsWith("\n");
  const body =
    withoutRoot.length === 0 ? "" : hadTrailingNewline ? withoutRoot.slice(0, -1) : withoutRoot;
  const lines = body.length === 0 && withoutRoot.length === 0 ? [] : body.split("\n");

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
  return `${rewritten.join("\n")}${hadTrailingNewline || withoutRoot.length === 0 ? "\n" : ""}`;
};
