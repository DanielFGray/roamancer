{ pkgs, ... }:
{
  imports = [
    ../modules/base.nix
    ./nomad.nix
    ./registry.nix
    ./traefik.nix
    ../modules/static-sites.nix
    ./nomad-acl.nix
    ./openbao.nix
    ./herdr.nix
    ./backups.nix
    ./cluster-tls.nix
  ];

  nixpkgs.overlays = [ (import ./bun.nix) ];

  networking.hostName = "cynic";
  networking.networkmanager.enable = true;

  # Bun runs Alchemy and scripts/ops-on-host.sh.
  environment.systemPackages = [ pkgs.bun ];

  users.groups.alchemy = { };
  users.users.dan.extraGroups = [ "alchemy" ];

  # dan's password lives only in /etc/shadow (users.mutableUsers), set with
  # `sudo passwd dan`.
  system.stateVersion = "26.05";
}
