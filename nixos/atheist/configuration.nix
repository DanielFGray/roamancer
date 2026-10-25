# atheist holds the public address, so it runs the ingress: Traefik as a Nomad job
# (tools/alchemy/platform/ingress) that terminates TLS and routes every public name,
# to Nomad services anywhere in the cluster and to the static sites served here.
{ pkgs, ... }:
let
  # Traefik reads every file in this folder. host.toml names the static file server;
  # the others route each static site and redirect.
  routesDir = "/var/lib/traefik-routes";
  hostRoutes = (pkgs.formats.toml { }).generate "host.toml" {
    http.services.static-sites.loadBalancer.servers = [ { url = "http://127.0.0.1:8080"; } ];
  };
in
{
  imports = [
    ../modules/base.nix
    ../modules/static-sites.nix
    ./network.nix
    ./nomad.nix
    ./backups.nix
  ];

  networking.hostName = "atheist";

  services.openssh.ports = [ 10022 ];

  # Set at activation from a file the install copies in, so the password never enters
  # the Nix store or git. A `passwd` change lasts only until the next rebuild; change
  # the file instead.
  users.users.dan.hashedPasswordFile = "/var/lib/user-passwords/dan";

  systemd.tmpfiles.rules = [
    "d ${routesDir} 0755 root root -"
    "L+ ${routesDir}/host.toml - - - - ${hostRoutes}"
    "L+ ${routesDir}/sites.toml - - - - ${./traefik-routes/sites.toml}"
    "L+ ${routesDir}/redirects.toml - - - - ${./traefik-routes/redirects.toml}"
    # Site releases are copied here as dan (nixos/modules/static-sites.nix serves them).
    "d /srv/www 0755 dan users -"
    "z /var/lib/user-passwords 0700 root root -"
    "z /var/lib/user-passwords/dan 0600 root root -"
  ];

  system.stateVersion = "26.05";
}
