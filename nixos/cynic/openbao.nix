# OpenBao, the secret store for the platform jobs.
#
# The listener binds loopback and serves plain HTTP. Nomad reaches it on the same
# host (its Vault integration points at 127.0.0.1:8200 in nomad-podman.nix), so TLS
# would only protect loopback traffic. OpenBao starts sealed and holds no data until
# it is initialized and unsealed, which the platform does as a separate step.
{ ... }:
{
  services.openbao = {
    enable = true;
    settings = {
      ui = false;
      listener.default = {
        type = "tcp";
        address = "127.0.0.1:8200";
        tls_disable = true;
      };
      api_addr = "http://127.0.0.1:8200";
      cluster_addr = "http://127.0.0.1:8201";
      storage.raft.path = "/var/lib/openbao";
    };
  };
}
