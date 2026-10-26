// Pure helpers for the table-of-contents list that `pg_restore -l` produces.
// The list is plain text, one entry per line; comment lines start with ';'.
const entries = (
  list: string,
): ReadonlyArray<{
  readonly line: string;
  readonly acl: boolean;
  readonly extensionComment: boolean;
}> =>
  list.split("\n").map((line) => {
    const trimmed = line.trim();
    const fields = trimmed.split(/\s+/);
    return {
      line,
      // pg_restore -l writes the type of a default-privileges entry as two words, "DEFAULT ACL".
      acl: fields[3] === "ACL" || (fields[3] === "DEFAULT" && fields[4] === "ACL"),
      // These entries need the extension's owner.
      extensionComment: fields[3] === "COMMENT" && fields[5] === "EXTENSION",
    };
  });

const selectEntries = (list: string, acls: boolean): string =>
  entries(list)
    .filter(
      ({ line, acl, extensionComment }) =>
        line.trim() === "" || line.trim().startsWith(";") || (!extensionComment && acl === acls),
    )
    .map(({ line }) => line)
    .join("\n");

export const filterRestoreList = (list: string): string => selectEntries(list, false);

export const filterAclRestoreList = (list: string): string => selectEntries(list, true);

export const remapAclRoles = (sql: string, source: string, target: string): string => {
  return sql.replace(
    new RegExp(`(?<![A-Za-z0-9_$])(?:"${source}"|${source})(?![A-Za-z0-9_$])`, "g"),
    `"${target}"`,
  );
};
