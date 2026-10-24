# PostgreSQL backups

Cynic backs up all PostgreSQL databases and roles each day. Restic encrypts the dump on cynic before it is sent to Cloudflare R2. The R2 credentials and encryption password are kept in `/var/lib/backups/restic.env`, not OpenBao, so a backup can run when OpenBao is unavailable.

## One-time setup

1. Deploy the NixOS configuration. It creates `/var/lib/backups` (mode `0700`, owner `nomad`), installs `restic`, labels new containers with their Nomad job and task, and starts the daily timer. Until steps 2–5 are done, each timer run fails with a message that names the missing piece.
2. Restart the `postgres` job once, so its container is recreated with the labels the backup selects by (`com.hashicorp.nomad.job_name=postgres`, `com.hashicorp.nomad.task_name=server`). Check with `sudo -u nomad XDG_RUNTIME_DIR=/run/user/1001 podman ps --filter label=com.hashicorp.nomad.job_name=postgres`.
3. Create a Cloudflare R2 bucket. Create an R2 API token with object read/write access scoped to that bucket. Record the account ID, access key ID, and secret access key.
4. Create `/var/lib/backups/restic.env` on cynic, owned by `nomad` and readable only by `nomad`:

   ```sh
   sudo install -o nomad -g nomad -m 0600 /dev/null /var/lib/backups/restic.env
   sudo -u nomad tee /var/lib/backups/restic.env >/dev/null <<'EOF'
   RESTIC_REPOSITORY=s3:https://<account>.r2.cloudflarestorage.com/<bucket>
   RESTIC_PASSWORD=<long-random-restic-password>
   AWS_ACCESS_KEY_ID=<r2-access-key-id>
   AWS_SECRET_ACCESS_KEY=<r2-secret-access-key>
   EOF
   ```

   Replace each placeholder. Store `RESTIC_PASSWORD` in the operator's password store as well. Losing it makes every backup unrecoverable.
5. Initialize the repository as `nomad` on cynic:

   ```sh
   sudo -u nomad sh -c 'set -a; . /var/lib/backups/restic.env; set +a; restic init'
   ```

   Do not run `restic init` again for an existing repository.
6. Run a backup now (next section) and list its snapshot. From then on the service runs daily, with a randomized delay of up to one hour. Persistent timers catch up after downtime.

## Run a backup now

```sh
sudo systemctl start postgres-backup.service
sudo systemctl status postgres-backup.service
```

A failed dump or repository operation makes the service fail. Read its log with `journalctl -u postgres-backup.service`.

## List snapshots

On cynic, as `nomad` with the environment file loaded:

```sh
sudo -u nomad sh -c 'set -a; . /var/lib/backups/restic.env; set +a; restic snapshots'
```

## Restore into fresh PostgreSQL

This restores the complete cluster, including roles and every database, into a fresh, empty PostgreSQL. The dump creates the role `postgres`, so the fresh cluster must start with a different superuser, here `restore`. Never restore over a cluster with data.

On a machine with `restic`, `psql` and podman (cynic or the operator's machine), with the four variables from `/var/lib/backups/restic.env` set:

```sh
set -euo pipefail
dump=1000 90 98 953 965 984 985 987 994 996 998 1000 1001mktemp); trap 'rm -f ""' EXIT
# A failed download must not reach psql: an empty input would "restore" nothing and exit 0.
restic dump latest postgres.sql > ""
grep -q '^-- PostgreSQL database cluster dump complete

- OpenBao's Raft snapshot and its secrets.
- `noneuclid-data`.
 ""
podman run -d --name pg-restore -e POSTGRES_USER=restore -e POSTGRES_PASSWORD=restore -p 127.0.0.1:55432:5432 postgres:<same major version as cynic>
until podman exec pg-restore pg_isready -U restore; do sleep 1; done
podman exec -i pg-restore psql -v ON_ERROR_STOP=1 -U restore -d postgres < ""
```

Then check the data: `podman exec pg-restore psql -U restore -d giglist -c 'select count(*) from app_public.users'`, and the same for other tables you know the counts of. Remove the container afterwards with `podman rm -f pg-restore`.

## Not backed up yet

- OpenBao's Raft snapshot and its secrets.
- `noneuclid-data`.
