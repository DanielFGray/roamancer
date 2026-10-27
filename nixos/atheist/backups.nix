{ ... }:
{
  systemd.tmpfiles.rules = [ "d /var/lib/backups 0700 root root -" ];

  # Two hours before cynic's backup, which prunes the shared repository under a lock.
  services.restic.backups.files = import ../modules/restic-r2.nix // {
    paths = [
      # The only copy of the static site releases.
      "/srv/www"
      # Traefik's Let's Encrypt account and certificates. Without them a restart asks for
      # every certificate again, and Let's Encrypt rate-limits that.
      "/var/lib/nomad/traefik-acme"
      # The only copy of the bookmarks app's data. OpenObserve's telemetry is not kept.
      "/var/lib/nomad/twitter-bookmarks-data"
    ];
    timerConfig = (import ../modules/restic-r2.nix).timerConfig // { OnCalendar = "*-*-* 01:00"; };
  };
}
