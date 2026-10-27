#!/usr/bin/env bash
set -euo pipefail

# Replaces an app database that Alchemy created with the contents of a pg_dump
# custom-format file, all or nothing, and keeps the database it replaced.
#
# It restores into a new database, <database>_restore, made the way Alchemy makes one:
# owned by <database>_owner, with the live database's extensions. It connects as the
# server's superuser inside the Postgres allocation and runs every statement as the owner
# role, so restored objects belong to that role, as migrations would create them. Grants
# in the dump must name roles the platform made. The restore is one transaction that
# stops at the first error, so a failure leaves nothing behind and the live database is
# never touched.
#
# Two kinds of dump entry are left out. COMMENT ON EXTENSION needs the extension's owner.
# Default privileges belong to a role and pg_restore cannot rename one, so when the dump's
# owner had another name, its default privileges are replayed for <database>_owner, and
# objects that later migrations create get the same grants.
#
# Then it swaps the names: the live database stops taking connections, its sessions end,
# it becomes <database>_before_restore_<UTC time>, and the restored database takes its
# name. Apps lose their connections for a moment and reconnect to the restored data. The
# replaced database stays until you drop it.
#
# sudo on the host needs a terminal for its password, and a terminal cannot also carry the
# dump. So the dump and the steps go to the host's tmpfs first, and one terminal session
# runs them as root.
#
# Usage: restore-database.sh <ssh host> <database> <dump file>

host="${1:?ssh host, such as the control host}"
database="${2:?database name}"
dump="${3:?pg_dump -Fc file}"

dir=$(ssh "$host" 'mktemp -d "/run/user/$(id -u)/restore.XXXXXX"')
trap 'ssh "$host" rm -rf "$dir"' EXIT
ssh "$host" "cat > '$dir/dump'" < "$dump"
ssh "$host" "cat > '$dir/restore'" <<'EOF'
set -euo pipefail
dump=$1 database=$2 dir=$(dirname "$1")
owner="${database}_owner"
fresh="${database}_restore"
before="${database}_before_restore_$(date -u +%Y%m%d%H%M%S)"
export NOMAD_TOKEN=$(cat /var/lib/nomad-acl/bootstrap.token)
alloc=$(nomad job allocs -t '{{range .}}{{if eq .ClientStatus "running"}}{{.ID}}{{end}}{{end}}' postgres)
in_postgres() { nomad alloc exec -i -task server "$alloc" "$@"; }
# Runs SQL from stdin as the superuser in database $1. nomad alloc exec does not pass the
# end of input on to psql, so the script ends with \q.
sql() { { cat; printf '\\q\n'; } | in_postgres psql -U postgres -v ON_ERROR_STOP=1 -qAt -d "$1"; }

live_owner=$(sql postgres <<< "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$database';")
if [[ "$live_owner" != "$owner" ]]; then
  echo "$database must exist and belong to $owner; its owner is '$live_owner'." >&2
  exit 1
fi

# Untrusted extensions need a superuser, and the restore runs as the owner, so they are
# made first. The dump's own CREATE EXTENSION IF NOT EXISTS then does nothing.
extensions=$(sql "$database" <<< "SELECT string_agg(format('CREATE EXTENSION %I WITH SCHEMA %I;', extname, extnamespace::regnamespace), ' ') FROM pg_extension WHERE extname <> 'plpgsql';")
sql postgres <<< "SET client_min_messages = warning; DROP DATABASE IF EXISTS \"$fresh\"; CREATE DATABASE \"$fresh\" OWNER \"$owner\";"
[[ -z "$extensions" ]] || sql "$fresh" <<< "$extensions"

# The table of contents names each entry's owner last.
in_postgres pg_restore -l < "$dump" > "$dir/list"
old_owners=$(awk -v owner="$owner" '$4 == "DEFAULT" && $5 == "ACL" && $NF != owner {print $NF}' "$dir/list" | sort -u)
awk -v owner="$owner" '!($4 == "COMMENT" && $6 == "EXTENSION") && !($4 == "DEFAULT" && $5 == "ACL" && $NF != owner)' \
  "$dir/list" | in_postgres sh -c 'cat > /tmp/restore.list'
in_postgres pg_restore -U postgres --no-owner --role="$owner" --single-transaction --exit-on-error \
  -L /tmp/restore.list -d "$fresh" < "$dump"
in_postgres rm -f /tmp/restore.list

for old in $old_owners; do
  in_postgres pg_restore -f - < "$dump" |
    grep -E "^ALTER DEFAULT PRIVILEGES FOR ROLE $old " |
    sed -E "s/^ALTER DEFAULT PRIVILEGES FOR ROLE $old /ALTER DEFAULT PRIVILEGES FOR ROLE \"$owner\" /" |
    sql "$fresh"
done

tables=$(sql "$fresh" <<< "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');")
echo "Restored $tables tables into $fresh."

# Without ALLOW_CONNECTIONS false, an app could reconnect between the terminate and the
# rename, and the rename would fail on its session.
sql postgres <<SQL
ALTER DATABASE "$database" WITH ALLOW_CONNECTIONS false;
SELECT format('Ended %s sessions on %s.', count(pg_terminate_backend(pid)), '$database') FROM pg_stat_activity WHERE datname = '$database';
ALTER DATABASE "$database" RENAME TO "$before";
ALTER DATABASE "$fresh" RENAME TO "$database";
SQL
echo "$database now holds the restored data. The database it replaced is $before,"
echo "closed to connections. Drop it once the app checks out: DROP DATABASE \"$before\";"
EOF
ssh -t "$host" sudo bash "$dir/restore" "$dir/dump" "$database"
