{ ... }:
let
  cluster = import ../cluster.nix;
  credentials = "/run/credentials/docker-registry.service";
in
{
  # Every node pulls job images here, and the workstation pushes them, over the LAN by
  # the name registryName. Like Nomad RPC, it serves only clients with a certificate from
  # the cluster CA (cluster-tls.nix): the bridge is shared, and anyone who reached it
  # could delete manifests. Cartridges pin each image by digest, so a tag pushed again
  # changes nothing deployed.
  services.dockerRegistry = {
    enable = true;
    listenAddress = cluster.lanAddress;
    port = cluster.registryPort;
    enableDelete = true;
    enableGarbageCollect = true;
    extraConfig.http.tls = {
      certificate = "${credentials}/cert";
      key = "${credentials}/key";
      clientcas = [ "${credentials}/ca" ];
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
        "ca:${cluster.tlsDir}/nomad-agent-ca.pem"
      ];
      Restart = "on-failure";
    };
  };
}
