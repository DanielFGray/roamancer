{ pkgs, ... }:
let
  backup = pkgs.writeShellApplication {
    name = "backup-postgres";
    runtimeInputs = [ pkgs.podman pkgs.restic pkgs.coreutils pkgs.gnugrep ];
    text = ''
      env_file=/var/lib/backups/restic.env
      if [ ! -r "$env_file" ]; then
        echo "Missing $env_file; create it before running a backup." >&2
        exit 1
      fi
      container=$(podman ps --filter label=com.hashicorp.nomad.job_name=postgres --filter label=com.hashicorp.nomad.task_name=server --format '{{.ID}}')
      if [ -z "$container" ]; then
        echo "No running container labelled for Nomad job postgres, task server. Containers started before extra_labels was set carry no labels: restart the postgres job once." >&2
        exit 1
      fi
      if [ "$(printf '%s\n' "$container" | wc -l)" -ne 1 ]; then
        echo "Expected one running PostgreSQL container; found multiple." >&2
        exit 1
      fi

      dump=$(mktemp)
      trap 'rm -f "$dump"' EXIT
      podman exec "$container" pg_dumpall --username=postgres > "$dump"
      if ! grep -q '^-- PostgreSQL database cluster dump complete$' "$dump"; then
        echo "pg_dumpall output is incomplete; refusing to save it." >&2
        exit 1
      fi
      restic backup --stdin --stdin-filename postgres.sql < "$dump"
      restic forget --prune --keep-daily 14 --keep-weekly 8 --keep-monthly 12
    '';
  };
in
{
  # The operator runs restic by hand for init, snapshots and restore (backup-operations.md).
  environment.systemPackages = [ pkgs.restic ];

  systemd.tmpfiles.rules = [ "d /var/lib/backups 0700 nomad nomad -" ];

  systemd.services.postgres-backup = {
    description = "Encrypted PostgreSQL backup to restic";
    serviceConfig = {
      Type = "oneshot";
      User = "nomad";
      Environment = [ "XDG_RUNTIME_DIR=/run/user/1001" ];
      # Optional, so a missing file reaches the script's own message instead of a systemd error.
      EnvironmentFile = "-/var/lib/backups/restic.env";
      # The plain-text dump waits in /tmp until it is checked; keep it out of the shared one.
      PrivateTmp = true;
      ExecStart = "${backup}/bin/backup-postgres";
    };
  };

  systemd.timers.postgres-backup = {
    description = "Nightly PostgreSQL backup";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "daily";
      RandomizedDelaySec = "1h";
      Persistent = true;
      Unit = "postgres-backup.service";
    };
  };
}
