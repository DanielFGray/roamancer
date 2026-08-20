// ---------------------------------------------------------------------------
// .env.example parser
//
// Rules:
//   - empty value        → generated (auto-password)
//   - contains ${...}    → composed (resolved after statics/generated)
//   - anything else      → static (used as-is)
// ---------------------------------------------------------------------------

export interface EnvField {
  readonly key: string;
  readonly kind: "static" | "generated" | "composed";
  readonly value: string;
}

const classifyField = (key: string, value: string): EnvField => ({
  key,
  kind: value === "" ? "generated" : /\$\{[^}]+\}/.test(value) ? "composed" : "static",
  value,
});

export const parseEnvExample = (content: string): ReadonlyArray<EnvField> =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const eq = line.indexOf("=");
      return classifyField(line.slice(0, eq).trim(), line.slice(eq + 1));
    });

export const resolveComposed = (template: string, resolved: Record<string, string>): string =>
  template.replace(/\$\{([^}]+)\}/g, (_, key: string) => resolved[key] ?? "");

export const formatEnv = (env: Record<string, string>): string =>
  Object.entries(env)
    .map(([k, v]) => {
      // Quote values that contain spaces, quotes, newlines, or shell metacharacters
      if (/[\s"'\\$`!#&|;()]/.test(v) || v === "") {
        return `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      }
      return `${k}=${v}`;
    })
    .join("\n");
