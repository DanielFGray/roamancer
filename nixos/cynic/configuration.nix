{ pkgs, site, ... }:
let
  operator = site.operator;
in
{
  imports = [
    ../modules/base.nix
    ./nomad.nix
    ./registry.nix
    ./nomad-acl.nix
    ./openbao.nix
    ../modules/herdr.nix
    ./backups.nix
    ./cluster-tls.nix
  ];

  nixpkgs.overlays = [ (import ./bun.nix) ];

  networking.hostName = "cynic";
  networking.networkmanager.enable = true;

  # Bun runs Alchemy and the host commands in tools/alchemy/src/cli.ts.
  # pg_dump/pg_restore (postgresql_17) are used by ops to copy Postgres databases.
  # sqlite3 checks and backs up the queue and the operation journal (queue-cutover.md).
  environment.systemPackages = [ pkgs.bun pkgs.postgresql_17 pkgs.sqlite ];

  users.groups.alchemy = { };
  users.users.${operator.name}.extraGroups = [ "alchemy" ];

  # The operator's password lives only in /etc/shadow (users.mutableUsers), set with
  # `sudo passwd <operator>`.
  system.stateVersion = "26.05";
}
