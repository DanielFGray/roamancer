{ site, ... }:
let
  cluster = site.cluster;
  credentials = "/run/credentials/docker-registry.service";
in
{
  # Every node pulls job images here, and the workstation (or a build node) pushes them,
  # over the LAN by the name registryName. It checks no client credentials: the firewall
  # admits only the workstation and the Nomad nodes (cluster-tls.nix, site.toml
  # nodes), and cartridges pin each image by digest, so a pushed tag changes nothing
  # deployed. Deletion is off, so no client can remove an image a job needs.
  services.dockerRegistry = {
    enable = true;
    listenAddress = cluster.lanAddress;
    port = cluster.registryPort;
    enableGarbageCollect = true;
    extraConfig.http.tls = {
      certificate = "${credentials}/cert";
      key = "${credentials}/key";
    };
  };

  systemd.services.docker-registry = {
    # It binds the LAN address, which DHCP assigns.
    wants = [ "network-online.target" ];
    after = [ "network-online.target" ];
    serviceConfig = {
      # The registry user cannot read tlsDir; systemd hands it copies at start.
      LoadCredential = [
        "cert:${cluster.tlsDir}/global-server-nomad.pem"
        "key:${cluster.tlsDir}/global-server-nomad-key.pem"
      ];
      Restart = "on-failure";
    };
  };
}
