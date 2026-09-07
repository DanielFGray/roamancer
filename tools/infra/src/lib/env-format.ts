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
