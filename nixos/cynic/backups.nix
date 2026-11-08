{ pkgs, ... }:
let
  # Runner-owned Alchemy state: job units use WorkingDirectory /var/lib/alchemy, and
  # Alchemy writes under ./.alchemy (see nixos/modules/alchemy-runner.nix).
  alchemyDir = "/var/lib/alchemy/.alchemy";

  # Writes every database and role as SQL to stdout. restic keeps the snapshot only when
  # this exits 0, so a failed or partial dump never becomes a backup.
  dump = pkgs.writeShellApplication {
    name = "dump-postgres";
    runtimeInputs = [ pkgs.podman pkgs.coreutils ];
    text = ''
      container=$(podman ps --filter label=com.hashicorp.nomad.job_name=postgres --filter label=com.hashicorp.nomad.task_name=server --format '{{.ID}}')
      if [ -z "$container" ]; then
        echo "No running container labelled for Nomad job postgres, task server. Containers started before extra_labels was set carry no labels: restart the postgres job once." >&2
        exit 1
      fi
      if [ "$(printf '%s\n' "$container" | wc -l)" -ne 1 ]; then
        echo "Expected one running PostgreSQL container; found multiple." >&2
        exit 1
      fi
      exec podman exec "$container" pg_dumpall --username=postgres
    '';
  };
in
{
  # The operator runs restic by hand for init, snapshots and restore (nixos/backup-operations.md).
  environment.systemPackages = [ pkgs.restic ];

  systemd.tmpfiles.rules = [ "d /var/lib/backups 0700 nomad nomad -" ];

  services.restic.backups.postgres = import ../modules/restic-r2.nix // {
    # Postgres runs in nomad's rootless Podman, which only nomad can reach.
    user = "nomad";
    command = [ "${dump}/bin/dump-postgres" ];
    # The name the snapshots had before this module, so retention treats them as one series.
    extraBackupArgs = [ "--stdin-filename" "postgres.sql" ];
    # Retention for every host's snapshots; forget groups them by host and path.
    # The pre-nixos snapshots are atheist's Debian install; keep them.
    pruneOpts = [ "--keep-daily 14" "--keep-weekly 8" "--keep-monthly 12" "--keep-tag pre-nixos" ];
    # Reads a random 5% of the stored data each run, so damage anywhere is found within weeks.
    checkOpts = [ "--read-data-subset=5%" ];
    timerConfig = (import ../modules/restic-r2.nix).timerConfig // { OnCalendar = "*-*-* 03:00"; };
  };

  systemd.services.restic-backups-postgres.environment.XDG_RUNTIME_DIR = "/run/user/1001";

  # Alchemy's state and operation journal: the record of what each stage deployed.
  # The journal is SQLite in WAL mode, so a file copy taken during a write can be torn;
  # back up a consistent copy made with VACUUM INTO instead of the live files.
  # This unit runs as root (NixOS restic default). Root can read the alchemy user's
  # 0700 home at /var/lib/alchemy; the restic.env file under /var/lib/backups is also
  # root-readable (0700 nomad). Running as alchemy would fail to read restic.env.
  services.restic.backups.alchemy = import ../modules/restic-r2.nix // {
    backupPrepareCommand = ''
      rm -f /var/lib/backups/alchemy-operations.sqlite
      ${pkgs.sqlite}/bin/sqlite3 -readonly ${alchemyDir}/operations.sqlite \
        "VACUUM INTO '/var/lib/backups/alchemy-operations.sqlite'"
    '';
    paths = [ "${alchemyDir}/state" "/var/lib/backups/alchemy-operations.sqlite" ];
    # Before the postgres backup, whose prune locks the whole repository.
    timerConfig = (import ../modules/restic-r2.nix).timerConfig // { OnCalendar = "*-*-* 02:00"; };
  };
}
