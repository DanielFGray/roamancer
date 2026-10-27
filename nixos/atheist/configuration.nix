# atheist holds the public address, so it runs the ingress: Traefik as a Nomad job
# (tools/alchemy/platform/ingress) that terminates TLS and routes every public name,
# to Nomad services anywhere in the cluster and to the static sites served here.
{ pkgs, site, siteDir, ... }:
let
  operator = site.operator;
  # Traefik reads every file in this folder. host.toml names the static file server; the
  # other files are the routes/ folder of the site, one link each.
  routesDir = "/var/lib/traefik-routes";
  routeFiles = builtins.attrNames (builtins.readDir "${siteDir}/routes");
  hostRoutes = (pkgs.formats.toml { }).generate "host.toml" {
    http.services.static-sites.loadBalancer.servers = [ { url = "http://127.0.0.1:8080"; } ];
  };
in
{
  imports = [
    ../modules/base.nix
    ../modules/static-sites.nix
    ../modules/herdr.nix
    ./network.nix
    ./nomad.nix
    ./backups.nix
  ];

  networking.hostName = "atheist";

  services.openssh.ports = [ site.hosts.atheist.sshPort ];

  # Set at activation from a file the install copies in, so the password never enters
  # the Nix store or git. A `passwd` change lasts only until the next rebuild; change
  # the file instead.
  users.users.${operator.name}.hashedPasswordFile = "/var/lib/user-passwords/${operator.name}";

  systemd.tmpfiles.rules = [
    "d ${routesDir} 0755 root root -"
    "L+ ${routesDir}/host.toml - - - - ${hostRoutes}"
    # Site releases are copied here as the operator (nixos/modules/static-sites.nix serves
    # them).
    "d /srv/www 0755 ${operator.name} users -"
    "z /var/lib/user-passwords 0700 root root -"
    "z /var/lib/user-passwords/${operator.name} 0600 root root -"
  ] ++ map (file: "L+ ${routesDir}/${file} - - - - ${siteDir}/routes/${file}") routeFiles;

  system.stateVersion = "26.05";
}
