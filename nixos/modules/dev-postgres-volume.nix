# The dev Postgres server's data volume (tools/alchemy/platform/dev-data), on the node that
# `[devdb] node` of site.toml names, or on the control host when the table is absent. The
# volume pins the server to that node, and `ops dev db` reads the same setting for its
# tunnel's address, so both follow one line of site.toml. Nomad merges this file with
# nomad.hcl, host volumes included.
{ config, lib, site, ... }:
let
  node = (site.devdb or { }).node or site.cluster.server;
  file = "nomad.d/dev-postgres.hcl";
in
lib.mkIf (config.networking.hostName == node) {
  # The server runs as the image's uid 999, which is host uid 100998 in nomad's rootless
  # user namespace (cynic/nomad.nix explains the mapping for the live server's volume).
  systemd.tmpfiles.rules = [ "d /var/lib/nomad/postgres-dev-data 0700 100998 nomad -" ];

  environment.etc.${file}.text = ''
    client {
      host_volume "postgres-dev-data" {
        path = "/var/lib/nomad/postgres-dev-data"
        read_only = false
      }
    }
  '';

  systemd.services.nomad.restartTriggers = [ config.environment.etc.${file}.source ];
}
