{ config, pkgs, ... }:
let
  nomad = pkgs.stdenvNoCC.mkDerivation {
    pname = "nomad";
    version = "2.0.7";
    src = pkgs.fetchurl {
      url = "https://releases.hashicorp.com/nomad/2.0.7/nomad_2.0.7_linux_amd64.zip";
      hash = "sha256-TJuKCFDW/Zyq27qwmz5v34t3qnd3KVQ8cMYbhazKaME=";
    };
    nativeBuildInputs = [ pkgs.autoPatchelfHook pkgs.unzip ];
    buildInputs = [ pkgs.glibc pkgs.zlib ];
    dontUnpack = true;
    dontBuild = true;
    installPhase = ''
      unzip -p $src nomad > nomad
      install -Dm755 nomad $out/bin/nomad
    '';
  };

  podmanDriver = pkgs.stdenvNoCC.mkDerivation {
    pname = "nomad-driver-podman";
    version = "0.6.5";
    src = pkgs.fetchurl {
      url = "https://releases.hashicorp.com/nomad-driver-podman/0.6.5/nomad-driver-podman_0.6.5_linux_amd64.zip";
      hash = "sha256-eGsE7p0ALmtCMdvLjd46tlxv4KcooB/K0U6HpoHkjOE=";
    };
    nativeBuildInputs = [ pkgs.autoPatchelfHook pkgs.unzip ];
    buildInputs = [ pkgs.glibc pkgs.zlib ];
    dontUnpack = true;
    dontBuild = true;
    installPhase = ''
      unzip -p $src nomad-driver-podman > nomad-driver-podman
      install -Dm755 nomad-driver-podman $out/bin/nomad-driver-podman
    '';
  };
in
{
  users.users.nomad = {
    isSystemUser = true;
    uid = 1001;
    group = "nomad";
    home = "/var/lib/nomad-user";
    createHome = true;
    subUidRanges = [{ startUid = 100000; count = 65536; }];
    subGidRanges = [{ startGid = 100000; count = 65536; }];
  };
  users.groups.nomad = { };

  systemd.tmpfiles.rules = [
    # A unit bind mount would hide Nomad's secrets tmpfs from rootless Podman.
    # Keep the ip executable visible without giving Nomad a private mount namespace.
    "L+ /sbin/ip - - - - ${pkgs.iproute2}/bin/ip"
    "f /var/lib/systemd/linger/nomad 0644 root root -"
    "d /var/lib/nomad/noneuclid-data 0770 nomad nomad -"
    # The platform postgres image (postgres-image.nix) runs the server as uid 999, as the
    # official image does. In nomad's rootless
    # user namespace (subUidRanges above) container uid N maps to host uid
    # 100000 + N - 1, so 100998. The server must own its data volume's mount point;
    # the container's root (host nomad) still reaches it through the namespace.
    "d /var/lib/nomad/postgres-data 0700 100998 nomad -"
    "d /var/lib/nomad/valkey-data 0770 nomad nomad -"
    "d /var/lib/nomad/openobserve-data 0770 nomad nomad -"
  ];

  virtualisation.podman = {
    enable = true;
    dockerCompat = false;
    defaultNetwork.settings.dns_enabled = true;
  };

  systemd.user.sockets.podman = {
    wantedBy = [ "sockets.target" ];
    socketConfig = {
      ListenStream = [ "" "%t/podman.sock" ];
      SocketMode = "0660";
    };
  };
  systemd.user.services.podman = {
    description = "Rootless Podman API service";
    requires = [ "podman.socket" ];
    environment.PATH = pkgs.lib.mkForce "/run/wrappers/bin:/run/current-system/sw/bin:/run/current-system/sw/sbin";
    serviceConfig = {
      ExecStart = [ "" "${pkgs.podman}/bin/podman system service --time=0" ];
      Restart = "on-failure";
    };
  };

  systemd.services.nomad = {
    description = "Nomad server and client";
    restartTriggers = [ config.environment.etc."nomad.d/nomad.hcl".source ];
    wantedBy = [ "multi-user.target" ];
    wants = [ "network-online.target" "tailscaled.service" ];
    after = [ "network-online.target" "tailscaled.service" "user@1001.service" ];
    requires = [ "user@1001.service" ];
    serviceConfig = {
      ExecStart = "${nomad}/bin/nomad agent -config=/etc/nomad.d";
      Restart = "on-failure";
      LimitNOFILE = 65536;
    };
  };

  environment.etc."nomad.d/nomad.hcl".text = ''
    data_dir = "/var/lib/nomad"
    plugin_dir = "${podmanDriver}/bin"
    # Local Alchemy commands and the agent share this host. Remote operators
    # use SSH, so control-plane listeners need no LAN or tailnet exposure.
    bind_addr = "127.0.0.1"
    advertise {
      http = "127.0.0.1"
      rpc = "127.0.0.1"
      serf = "127.0.0.1"
    }

    server {
      enabled = true
      bootstrap_expect = 1
    }

    # The platform's OpenTelemetry collector scrapes /v1/metrics in Prometheus format
    # (tools/alchemy/platform/observability). Nomad serves only JSON without this.
    telemetry {
      prometheus_metrics = true
      publish_allocation_metrics = true
      publish_node_metrics = true
    }

    client {
      enabled = true
      servers = ["127.0.0.1:4647"]
      network_interface = "ens18"
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
      # Route files include absolute symlinks into the Nix store.
      host_volume "traefik-routes" {
        path = "/var/lib/traefik-routes"
        read_only = true
      }
      host_volume "nix-store" {
        path = "/nix/store"
        read_only = true
      }
      host_volume "openobserve-data" {
        path = "/var/lib/nomad/openobserve-data"
        read_only = false
      }
    }

    plugin "nomad-driver-podman" {
      config {
        socket_path = "unix:///run/user/1001/podman.sock"
        volumes {
          enabled = true
        }
        networking {
          default_rootless_mode = "pasta"
        }
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

  environment.systemPackages = [ nomad pkgs.iproute2 pkgs.podman pkgs.curl pkgs.jq ];
}
