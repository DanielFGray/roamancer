#!/usr/bin/env bash
set -euo pipefail

# Restores a pg_dump custom-format file into an app database that Alchemy created.
# Run it after the app's cartridge deploys its PostgresDatabase and before its jobs serve
# traffic. It connects as the server's superuser inside the Postgres allocation and runs
# every statement as the database's owner role, so restored objects belong to that role,
# as migrations would create them. Grants in the dump must name roles the platform made.
#
# Default privileges belong to a role, and pg_restore cannot rename one. When the dump's
# owner had another name, pass it: its ALTER DEFAULT PRIVILEGES statements are replayed
# for <database>_owner, so objects that later migrations create get the same grants.
# pg_restore reports, and skips, the originals and COMMENT ON EXTENSION.
#
# Usage: restore-database.sh <ssh host> <database> <dump file> [dump's owner role]

host="${1:?ssh host, such as cynic.dlab}"
database="${2:?database name}"
dump="${3:?pg_dump -Fc file}"
old_owner="${4:-}"
owner="${database}_owner"

in_postgres() {
  ssh "$host" "sudo env NOMAD_TOKEN=\$(sudo cat /var/lib/nomad-acl/bootstrap.token) sh -euc '
    alloc=\$(nomad job allocs -t \"{{range .}}{{if eq .ClientStatus \\\"running\\\"}}{{.ID}}{{end}}{{end}}\" postgres)
    exec nomad alloc exec -i -task server \"\$alloc\" $1
  '"
}

in_postgres "pg_restore -U postgres --no-owner --role=$owner -d $database" < "$dump" || true

if [[ -n "$old_owner" ]]; then
  # nomad alloc exec does not pass the end of input on to psql, so the script ends with \q.
  in_postgres "pg_restore -f -" < "$dump" \
    | grep -E "^ALTER DEFAULT PRIVILEGES FOR ROLE $old_owner " \
    | sed -E "s/^ALTER DEFAULT PRIVILEGES FOR ROLE $old_owner /ALTER DEFAULT PRIVILEGES FOR ROLE $owner /" \
    | { cat; printf '\\q\n'; } \
    | in_postgres "psql -U postgres -v ON_ERROR_STOP=1 -q -d $database"
fi
