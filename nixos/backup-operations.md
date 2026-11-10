# Backups

Every host backs up to one restic repository in Cloudflare R2. Restic encrypts on the host before anything leaves it. Each host keeps the repository address, its password and the R2 keys in `/var/lib/backups/restic.env`, not OpenBao, so a backup runs while OpenBao is down. The NixOS module `services.restic.backups` runs each backup from a daily timer; the shared settings are in `nixos/modules/restic-r2.nix`.

| Host | Unit | What | When |
| --- | --- | --- | --- |
| cynic | `restic-backups-postgres` | `pg_dumpall` of every database and role, as `postgres.sql` | 03:00, then prune and check |
| cynic | `restic-backups-alchemy` | Alchemy state (`/var/lib/alchemy/.alchemy/state`), a `VACUUM INTO` copy of its operation journal, `alchemy-operations.sqlite`, and the apps' repositories, `/srv/git` | 02:00 |
| cynic | `restic-backups-garage` | The Garage object store volume, `/var/lib/nomad/garage-data`, with a fresh `garage meta snapshot` of its database in place of the live database | 04:00 |
| atheist | `restic-backups-files` | `/srv/www` (static site releases) and `/var/lib/nomad/traefik-acme` (Let's Encrypt account and certificates) | 01:00 |

Each timer adds up to 30 minutes of random delay, and runs a missed backup at the next boot.

Only cynic's unit prunes and checks the repository, after its own backup. Prune locks the whole repository, so a second pruner would make the other host's backup fail. Retention keeps 14 daily, 8 weekly and 12 monthly snapshots for each host and path, and every snapshot tagged `pre-nixos` (atheist's Debian install). The check reads a random 5% of the stored data each run.

The Postgres dump runs as `nomad`, the only user that can reach Postgres's rootless Podman container. restic keeps the snapshot only when the dump exits 0, so a failed or partial dump never becomes a backup.

The Garage backup also runs as `nomad`, and asks the running Garage server for a database snapshot first. A failed snapshot stops the backup. Garage keeps its two newest snapshots under `meta/snapshots`. The backup skips the live database, `meta/db.lmdb`, because a copy taken during a write can be torn. The keys' secrets are also in OpenBao, which is not backed up yet: a restored Garage has its keys, and OpenBao must still hold their secrets.

## Set up a host

1. Copy cynic's environment file to the new host, mode 0600, owned by the backup's user (`nomad` on cynic, `root` on atheist). From the laptop:

   ```sh
   ssh -t cynic 'sudo install -m 0600 -o "$(id -un)" /var/lib/backups/restic.env /run/user/1000/restic.env'
   ssh cynic 'cat /run/user/1000/restic.env; rm /run/user/1000/restic.env' |
     ssh atheist 'umask 077; cat > /run/user/1000/restic.env'
   ssh -t atheist 'sudo install -m 0600 -o root /run/user/1000/restic.env /var/lib/backups/restic.env; rm /run/user/1000/restic.env'
   ```

   The file holds:

   ```
   RESTIC_REPOSITORY=s3:https://<account>.r2.cloudflarestorage.com/<bucket>
   RESTIC_PASSWORD=<restic password>
   AWS_ACCESS_KEY_ID=<R2 access key ID>
   AWS_SECRET_ACCESS_KEY=<R2 secret access key>
   ```

   The two `AWS_` variables hold the R2 API token's keys. No AWS account is involved: R2 speaks the S3 protocol, and restic's S3 backend reads its keys from these names for every provider.

   Keep `RESTIC_PASSWORD` in the password store as well. Losing it makes every backup unrecoverable.

2. Rebuild the host (`ops rebuild <host>`), then run a backup now and read its result:

   ```sh
   sudo systemctl start restic-backups-<name>
   journalctl -u restic-backups-<name> -n 20
   ```

The repository already exists. A new repository is created once with `restic init`, never again.

## List snapshots

NixOS installs a wrapper per backup that loads its environment file:

```sh
sudo restic-postgres snapshots     # on cynic
sudo restic-files snapshots        # on atheist
```

## Restore files

```sh
sudo restic-files restore latest --host atheist --target /tmp/restore --include /srv/www
```

Then compare and copy the folders you need. Restore into an empty target, never over the live folder.

To restore Alchemy state onto a rebuilt cynic, restore `--host cynic --include /var/lib/alchemy/.alchemy/state --include /var/lib/backups/alchemy-operations.sqlite` the same way, then put the state folder back at `/var/lib/alchemy/.alchemy/state` and the journal at `/var/lib/alchemy/.alchemy/operations.sqlite`, owned by `alchemy`, before the first `ops plan`. To restore the apps' repositories, restore `--include /srv/git` the same way and put each `<app>.git` back in `/srv/git`, owned by the operator with group `alchemy-repositories`, before the next push.

## Restore the Postgres cluster

This restores every role and database into a fresh, empty PostgreSQL, never one with data. The superuser must be `postgres`, as on cynic: PostgreSQL 16 and later accept the dump's `GRANTED BY postgres` only from the bootstrap superuser. The dump's `role "postgres" already exists` error is expected; any other error is not.

On a machine with podman and the environment file's four variables set:

```sh
set -euo pipefail
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
restic dump --host cynic latest postgres.sql > "$work/postgres.sql"
# A failed download must not reach psql: an empty input would restore nothing and exit 0.
grep -q '^-- PostgreSQL database cluster dump complete$' "$work/postgres.sql"
podman run -d --name pg-restore -e POSTGRES_PASSWORD=restore -p 127.0.0.1:55432:5432 postgres:17
until podman exec pg-restore pg_isready -q -U postgres; do sleep 1; done
podman exec -i pg-restore psql -q -U postgres -d postgres < "$work/postgres.sql" 2> "$work/errors" || true
grep ERROR "$work/errors" | grep -v 'role "postgres" already exists' || echo "no unexpected errors"
```

Then check the data: `podman exec pg-restore psql -U postgres -d giglist -c 'select count(*) from app_public.users'`, and the same for other tables whose counts you know. Remove the container afterwards with `podman rm -f pg-restore`.

## Restore one app's database into the live cluster

`tools/alchemy/scripts/restore-database.sh` takes a custom-format dump of one database. To get one from a backup, restore the cluster into a container as above and dump the app's database from it:

```sh
podman exec pg-restore pg_dump -U postgres -Fc giglist > giglist.dump
tools/alchemy/scripts/restore-database.sh cynic giglist giglist.dump
```

The script restores into `giglist_restore` in one transaction, then swaps it in for `giglist`. Apps lose their connections for a moment. The replaced database stays as `giglist_before_restore_<UTC time>` until you drop it.

## Restore the object store

This restores the `garage` job's volume onto cynic. Garage must not run while its volume changes.

```sh
# On cynic. Stops only the garage job; Postgres and Valkey keep running.
sudo sh -c 'export NOMAD_TOKEN="$(cat /var/lib/nomad-acl/bootstrap.token)"; exec nomad job stop garage'
sudo restic-garage restore latest --host cynic --target /tmp/garage-restore
```

Then, as root on cynic, put the restored volume in place of the live one and make the newest snapshot the live database:

```sh
set -euo pipefail
from=/tmp/garage-restore/var/lib/nomad/garage-data
to=/var/lib/nomad/garage-data
mv "$to" "$to.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$from" "$to"
newest=$(ls "$to/meta/snapshots" | sort | tail -1)
mkdir "$to/meta/db.lmdb"
cp -a "$to/meta/snapshots/$newest/db.lmdb" "$to/meta/db.lmdb/data.mdb"
chown -R nomad:nomad "$to"
```

Then start the job again with the same command, `nomad job start garage` in place of `nomad job stop garage`. Garage starts with its old node key and layout, so its buckets, keys and objects come back as they were at the snapshot. The replaced volume stays beside the live one until you remove it. This was tested on 2026-11-08 with the platform-garage image in Docker: a bucket, its key and one object came back, and the object read back intact.

## Not backed up yet

- OpenBao's Raft snapshot and its secrets.
- `noneuclid-data`.
