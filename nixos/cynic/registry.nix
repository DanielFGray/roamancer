{ site, ... }:
let
  cluster = site.cluster;
  credentials = "/run/credentials/docker-registry.service";
in
{
  # Every node pulls job images here, and the workstation (or a build node) pushes them,
  # over the LAN by the name registryName. The server certificate is the cluster's Nomad
  # server cert. Client authentication trusts only the registry CA (cluster-tls.nix), so a
  # Nomad client-agent certificate cannot push or pull. Cartridges pin each image by
  # digest, so a tag pushed again changes nothing deployed.
  services.dockerRegistry = {
    enable = true;
    listenAddress = cluster.lanAddress;
    port = cluster.registryPort;
    enableDelete = true;
    enableGarbageCollect = true;
    extraConfig.http.tls = {
      certificate = "${credentials}/cert";
      key = "${credentials}/key";
      clientcas = [ "${credentials}/clientca" ];
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
        "clientca:${cluster.tlsDir}/registry-ca.pem"
      ];
      Restart = "on-failure";
    };
  };
}
