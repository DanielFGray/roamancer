# Settings every host's restic backup shares. All hosts write to one restic repository
# in Cloudflare R2; restic records each snapshot's host, so their retention stays separate.
# The repository address, its password and the R2 keys are in /var/lib/backups/restic.env
# on each host, not OpenBao, so a backup runs while OpenBao is down
# (nixos/backup-operations.md).
#
# Usage: services.restic.backups.<name> = import ../modules/restic-r2.nix // { ... };
# Only cynic prunes and checks: prune locks the whole repository, so a second pruner
# would make the other host's backup fail.
{
  environmentFile = "/var/lib/backups/restic.env";
  # The repository exists; `restic init` on it again is refused anyway.
  initialize = false;
  pruneOpts = [ ];
  timerConfig = {
    RandomizedDelaySec = "30m";
    # A run missed while the host was off happens at the next boot.
    Persistent = true;
  };
}
