# atheist is a Nomad client of cynic's server. Jobs reach OpenBao through cynic's LAN
# listener. Nomad RPC, OpenBao and the image registry all accept only clients with a
# certificate from the cluster CA; atheist's one client certificate serves all three.
{ site, ... }:
let
  cluster = site.cluster;
  ca = "${cluster.tlsDir}/nomad-agent-ca.pem";
  cert = "${cluster.tlsDir}/client.pem";
  key = "${cluster.tlsDir}/client-key.pem";
in
{
  imports = [ ../modules/nomad-node.nix ];

  # The install copies these in (nixos/install-host.sh) with the installer's owner and
  # modes; these rules set the ones the readers need.
  systemd.tmpfiles.rules = [
    "z ${cluster.tlsDir} 0700 root root -"
    "z ${ca} 0600 root root -"
    "z ${cert} 0600 root root -"
    "z ${key} 0600 root root -"
    "z ${cluster.registryClientDir} 0750 root nomad -"
    "z ${cluster.registryClientDir}/ca.crt 0640 root nomad -"
    "z ${cluster.registryClientDir}/client.cert 0640 root nomad -"
    "z ${cluster.registryClientDir}/client.key 0640 root nomad -"
    # Traefik's Let's Encrypt account and certificates. Losing them means asking for
    # every certificate again, which Let's Encrypt rate-limits.
    "d /var/lib/nomad/traefik-acme 0770 nomad nomad -"
    # Volumes of jobs that fit here and not on cynic, whose memory holds the shared
    # PostgreSQL and Valkey.
    "d /var/lib/nomad/twitter-bookmarks-data 0770 nomad nomad -"
    "d /var/lib/nomad/openobserve-data 0770 nomad nomad -"
  ];

  # The ingress runs in nomad's rootless Podman with host networking, so the nomad user
  # binds 80 and 443 itself.
  boot.kernel.sysctl."net.ipv4.ip_unprivileged_port_start" = 80;

  services.nomadNode.config = ''
    # HTTP stays on loopback, where the ingress reads the service catalogue. RPC
    # advertises the LAN address, which the server dials back over the client's own
    # connection for logs and exec.
    bind_addr = "127.0.0.1"
    advertise {
      http = "127.0.0.1"
      rpc = "${cluster.nodes.atheist}"
      serf = "127.0.0.1"
    }

    tls {
      http = false
      rpc = true
      ca_file = "${ca}"
      cert_file = "${cert}"
      key_file = "${key}"
      verify_server_hostname = true
    }

    client {
      enabled = true
      servers = ["${cluster.lanAddress}:4647"]
      network_interface = "${cluster.lanInterface}"
      options = {
        "driver.raw_exec.enable" = "0"
        "driver.exec.enable" = "0"
      }

      # Route files include absolute symlinks into the Nix store.
      host_volume "traefik-routes" {
        path = "/var/lib/traefik-routes"
        read_only = true
      }
      host_volume "nix-store" {
        path = "/nix/store"
        read_only = true
      }
      host_volume "traefik-acme" {
        path = "/var/lib/nomad/traefik-acme"
        read_only = false
      }
      host_volume "twitter-bookmarks-data" {
        path = "/var/lib/nomad/twitter-bookmarks-data"
        read_only = false
      }
      host_volume "openobserve-data" {
        path = "/var/lib/nomad/openobserve-data"
        read_only = false
      }
    }

    vault {
      enabled = true
      address = "https://${cluster.lanAddress}:8200"
      ca_file = "${ca}"
      cert_file = "${cert}"
      key_file = "${key}"
      jwt_auth_backend_path = "jwt-nomad"
      default_identity {
        aud = ["vault.io"]
        ttl = "1h"
      }
    }
  '';
}
