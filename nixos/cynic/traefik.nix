{ lib, pkgs, ... }:
let
  # cynic's private LAN interface. The firewall opens port 80 on this
  # interface only, so the ingress is reachable from the LAN and from nowhere
  # else.
  lanInterface = "ens18";

  # The health path belongs to the host and answers on every host name.
  # Application routes match by host name, and this router has the highest
  # priority, so no application route can hide it.
  healthPath = "/_traefik/health";

  # nomad-acl-issue-traefik writes this file. It holds NOMAD_TOKEN, a client
  # token bound to the read-only traefik policy in nomad-acl.nix.
  tokenEnvFile = "/var/lib/nomad-acl/traefik.env";

  # Traefik reads every file in this folder and follows changes to it. NixOS
  # owns host.toml. Each static site's route is one more file here, written
  # by whoever owns that site.
  routesDir = "/var/lib/traefik-routes";

  toml = pkgs.formats.toml { };

  hostRoutes = toml.generate "host.toml" {
    http = {
      routers.host-health = {
        entryPoints = [ "web" ];
        rule = "Path(`${healthPath}`)";
        service = "ping@internal";
        priority = 1000000;
      };
      # Static-site routes send their requests to this service. The file
      # server is in static-sites.nix.
      services.static-sites.loadBalancer.servers = [ { url = "http://127.0.0.1:8080"; } ];
    };
  };

  staticConfig = toml.generate "traefik.toml" {
    global = {
      checkNewVersion = false;
      sendAnonymousUsage = false;
    };
    log.level = "ERROR";

    entryPoints.web.address = ":80";

    # manualRouting keeps Traefik from adding its own /ping router on the
    # web entry point, which would hide an application's /ping.
    ping.manualRouting = true;

    providers = {
      # Alchemy declares every Nomad application route as tags on the
      # release's Nomad service. Traefik polls Nomad for them, so a route
      # follows an allocation to its new address and port without a
      # reconcile. Polling, not watch: Traefik v3.7 ignores errors on the
      # Nomad event stream and then queries Nomad in a tight loop.
      nomad = {
        exposedByDefault = false;
        refreshInterval = "5s";
        endpoint = {
          address = "http://127.0.0.1:4646";
          # The NixOS module substitutes this from tokenEnvFile at start, so
          # the token never enters the Nix store.
          token = "$NOMAD_TOKEN";
        };
      };
      file = {
        directory = routesDir;
        watch = true;
      };
    };
  };
in
{
  services.traefik = {
    enable = true;
    staticConfigFile = staticConfig;
    environmentFiles = [ tokenEnvFile ];
  };

  systemd.tmpfiles.rules = [
    "d ${routesDir} 0755 root root -"
    "L+ ${routesDir}/host.toml - - - - ${hostRoutes}"
  ];

  # Without the token file the unit does not start. A start that fails instead
  # would count against the module's limit of five starts a day, and the
  # ingress would then stay down after the token is issued.
  systemd.services.traefik.unitConfig.ConditionPathExists = tokenEnvFile;

  # mkBefore keeps this rule composable with other modules that open ports
  # on the same interface.
  networking.firewall.interfaces.${lanInterface}.allowedTCPPorts = lib.mkBefore [ 80 ];
}
