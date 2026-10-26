// Pure helpers for the table-of-contents list that `pg_restore -l` produces.
// The list is plain text, one entry per line; comment lines start with ';'.
const entries = (
  list: string,
): ReadonlyArray<{
  readonly line: string;
  readonly roleBearing: boolean;
  readonly extensionComment: boolean;
}> =>
  list.split("\n").map((line) => {
    const trimmed = line.trim();
    const fields = trimmed.split(/\s+/);
    return {
      line,
      // pg_restore -l writes the type of a default-privileges entry as two words, "DEFAULT ACL",
      // and a row-level security policy as "POLICY". These entries name roles.
      roleBearing:
        fields[3] === "ACL" ||
        (fields[3] === "DEFAULT" && fields[4] === "ACL") ||
        fields[3] === "POLICY",
      // These entries need the extension's owner.
      extensionComment: fields[3] === "COMMENT" && fields[5] === "EXTENSION",
    };
  });

const selectEntries = (list: string, roleBearing: boolean): string =>
  entries(list)
    .filter(
      ({ line, roleBearing: entryRoleBearing, extensionComment }) =>
        line.trim() === "" ||
        line.trim().startsWith(";") ||
        (!extensionComment && entryRoleBearing === roleBearing),
    )
    .map(({ line }) => line)
    .join("\n");

export const objectRestoreList = (list: string): string => selectEntries(list, false);

export const roleRestoreList = (list: string): string => selectEntries(list, true);

export const remapRoles = (sql: string, source: string, target: string): string => {
  return sql.replace(
    new RegExp(`(?<![A-Za-z0-9_$])(?:"${source}"|${source})(?![A-Za-z0-9_$])`, "g"),
    `"${target}"`,
  );
};
