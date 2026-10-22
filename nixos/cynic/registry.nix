{ ... }:
{
  # Images built off this host reach Nomad here. It listens on loopback only:
  # builds push through an SSH tunnel, and the nomad user's Podman pulls locally.
  # Cartridges pin each image by digest, so a tag pushed again changes nothing deployed.
  services.dockerRegistry = {
    enable = true;
    listenAddress = "127.0.0.1";
    port = 5000;
    enableDelete = true;
    enableGarbageCollect = true;
  };

  # Loopback traffic needs no TLS.
  virtualisation.containers.registries.insecure = [ "127.0.0.1:5000" ];
}
