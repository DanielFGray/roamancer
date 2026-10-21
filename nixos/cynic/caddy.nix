{ lib, pkgs, ... }:
let
  # cynic's private LAN interface. The firewall opens port 80 on this
  # interface only, so the health endpoint is reachable from the LAN and
  # from nowhere else.
  lanInterface = "ens18";

  # The health path belongs to the host. Alchemy matches its routes by host,
  # so a reserved path cannot shadow an application health check.
  healthPath = "/_caddy/health";

  caddyfile = pkgs.writeText "Caddyfile" ''
    {
      admin 127.0.0.1:2019
      auto_https off
      log {
        level ERROR
      }
    }

    :80 {
      handle ${healthPath} {
        respond "cynic caddy ok" 200
      }
    }
  '';
in
{
  services.caddy = {
    enable = true;

    # Alchemy owns the application routes and writes them through the local
    # admin API. The autosaved config holds those routes, so a restart keeps
    # them without waiting for the Alchemy controller to reconcile.
    resume = true;

    # A reload applies the Caddyfile through the admin API and replaces the
    # running config, which drops the routes Alchemy added. A config change
    # restarts the service instead, and the restart resumes the autosaved
    # config.
    enableReload = false;

    configFile = caddyfile;
  };

  # mkBefore keeps this rule composable with other modules that open ports
  # on the same interface.
  networking.firewall.interfaces.${lanInterface}.allowedTCPPorts = lib.mkBefore [ 80 ];
}
