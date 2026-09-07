// ---------------------------------------------------------------------------
// Pure line-level classifier over a varlock `.env.schema` source.
//
// Used only by `vault rotate`, which needs to know which keys to *keep*
// (literal static defaults) versus which to regenerate (a `randomHex()` /
// `ref()` / `concat()` / other function-call expression) -- the schema
// author's own declared resolver call is the classification, not a
// heuristic over the resolved value's shape.
// ---------------------------------------------------------------------------

const FIELD_LINE = /^([^=\s#][^=]*)=(.*)$/;
const CALL_EXPRESSION = /^[A-Za-z_]\w*\(/;

export interface SchemaKeys {
  readonly all: ReadonlyArray<string>;
  readonly dynamic: ReadonlySet<string>;
}

export const classifySchemaKeys = (source: string): SchemaKeys => {
  const all: Array<string> = [];
  const dynamic = new Set<string>();

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = FIELD_LINE.exec(line);
    if (!match) continue;
    const [, key, value] = match as unknown as [string, string, string];
    all.push(key.trim());
    if (CALL_EXPRESSION.test(value.trim())) dynamic.add(key.trim());
  }

  return { all, dynamic };
};
