{ pkgs, ... }:
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

  # Bun runs Alchemy and scripts/ops-on-host.sh.
  # pg_dump/pg_restore (postgresql_17) are used by ops to copy Postgres databases.
  environment.systemPackages = [ pkgs.bun pkgs.postgresql_17 ];

  users.groups.alchemy = { };
  users.users.dan.extraGroups = [ "alchemy" ];

  # Alchemy runs as dan and serves tailnet routes with `tailscale serve`, which needs the
  # Tailscale operator; without it every serve change would need sudo.
  services.tailscale.extraSetFlags = [ "--operator=dan" ];

  # dan's password lives only in /etc/shadow (users.mutableUsers), set with
  # `sudo passwd dan`.
  system.stateVersion = "26.05";
}
