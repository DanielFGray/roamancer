{ site, ... }:
let
  cluster = site.cluster;
in
{
  imports = [ ../modules/nomad-node.nix ];

  systemd.tmpfiles.rules = [
    "d /var/lib/nomad/noneuclid-data 0770 nomad nomad -"
    # The platform postgres image (postgres-image.nix) runs the server as uid 999, as the
    # official image does. In nomad's rootless
    # user namespace (subUidRanges in nomad-node.nix) container uid N maps to host uid
    # 100000 + N - 1, so 100998. The server must own its data volume's mount point;
    # the container's root (host nomad) still reaches it through the namespace.
    "d /var/lib/nomad/postgres-data 0700 100998 nomad -"
    "d /var/lib/nomad/valkey-data 0770 nomad nomad -"
    # The Garage image (garage-image.nix) runs as the container's root, which is host nomad.
    "d /var/lib/nomad/garage-data 0700 nomad nomad -"
  ];

  services.nomadNode.config = ''
    # HTTP stays on loopback: Alchemy, Traefik, the ACL scripts and OpenBao's JWKS
    # fetch all run on this host. RPC is how other machines' Nomad clients reach this
    # server, so it listens on the LAN behind mutual TLS (cluster-tls.nix). Serf
    # carries only server-to-server traffic; it advertises the LAN address because
    # Raft takes the server's peer address from it.
    bind_addr = "127.0.0.1"
    addresses {
      rpc = "${cluster.lanAddress}"
      serf = "${cluster.lanAddress}"
    }
    advertise {
      http = "127.0.0.1"
      rpc = "${cluster.lanAddress}"
      serf = "${cluster.lanAddress}"
    }

    tls {
      http = false
      rpc = true
      ca_file = "${cluster.tlsDir}/nomad-agent-ca.pem"
      cert_file = "${cluster.tlsDir}/global-server-nomad.pem"
      key_file = "${cluster.tlsDir}/global-server-nomad-key.pem"
      verify_server_hostname = true
    }

    server {
      enabled = true
      bootstrap_expect = 1
    }

    client {
      enabled = true
      servers = ["${cluster.lanAddress}:4647"]
      # Measured on 2026-11-01: the host services (Nomad, OpenBao, the job runner, the
      # registry, journald, Tailscale) and the kernel use about 830 MB outside the
      # containers. Nomad schedules only the rest, so the jobs cannot reserve it.
      reserved {
        memory = 768
      }
      # The hypervisor balloons this VM between its Minimum memory (6144 MB) and its maximum, and
      # Nomad would otherwise count whatever the balloon allows when its agent starts. Schedule
      # against the guarantee, so a later balloon cannot take memory that jobs reserve.
      memory_total_mb = 6144
      network_interface = "${cluster.lanInterface}"
      options = {
        "driver.raw_exec.enable" = "0"
        "driver.exec.enable" = "0"
      }

      host_volume "noneuclid-data" {
        path = "/var/lib/nomad/noneuclid-data"
        read_only = false
      }
      host_volume "postgres-data" {
        path = "/var/lib/nomad/postgres-data"
        read_only = false
      }
      host_volume "valkey-data" {
        path = "/var/lib/nomad/valkey-data"
        read_only = false
      }
      host_volume "garage-data" {
        path = "/var/lib/nomad/garage-data"
        read_only = false
      }
    }

    # Jobs log in to OpenBao (openbao.nix) with their workload identity through
    # the jwt-nomad auth mount; Alchemy writes each job's JWT role and policy.
    vault {
      enabled = true
      address = "http://127.0.0.1:8200"
      jwt_auth_backend_path = "jwt-nomad"
      default_identity {
        aud = ["vault.io"]
        ttl = "1h"
      }
    }
  '';
}
