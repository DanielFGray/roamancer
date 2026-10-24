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
# sudo on the host needs a terminal for its password, and a terminal cannot also carry the
# dump. So the dump and the steps go to the host's tmpfs first, and one terminal session
# runs them as root.
#
# Usage: restore-database.sh <ssh host> <database> <dump file> [dump's owner role]

host="${1:?ssh host, such as cynic.dlab}"
database="${2:?database name}"
dump="${3:?pg_dump -Fc file}"
old_owner="${4:-}"

dir=$(ssh "$host" 'mktemp -d "/run/user/$(id -u)/restore.XXXXXX"')
trap 'ssh "$host" rm -rf "$dir"' EXIT
ssh "$host" "cat > '$dir/dump'" < "$dump"
ssh "$host" "cat > '$dir/restore'" <<'EOF'
set -euo pipefail
dump=$1 database=$2 old_owner=$3
owner="${database}_owner"
export NOMAD_TOKEN=$(cat /var/lib/nomad-acl/bootstrap.token)
alloc=$(nomad job allocs -t '{{range .}}{{if eq .ClientStatus "running"}}{{.ID}}{{end}}{{end}}' postgres)
in_postgres() { nomad alloc exec -i -task server "$alloc" "$@"; }

in_postgres pg_restore -U postgres --no-owner --role="$owner" -d "$database" < "$dump" || true

if [[ -n "$old_owner" ]]; then
  # nomad alloc exec does not pass the end of input on to psql, so the script ends with \q.
  in_postgres pg_restore -f - < "$dump" |
    grep -E "^ALTER DEFAULT PRIVILEGES FOR ROLE $old_owner " |
    sed -E "s/^ALTER DEFAULT PRIVILEGES FOR ROLE $old_owner /ALTER DEFAULT PRIVILEGES FOR ROLE $owner /" |
    { cat; printf '\\q\n'; } |
    in_postgres psql -U postgres -v ON_ERROR_STOP=1 -q -d "$database"
fi
EOF
ssh -t "$host" sudo bash "$dir/restore" "$dir/dump" "$database" "$old_owner"
