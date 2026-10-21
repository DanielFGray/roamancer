{ config, lib, pkgs, ... }:
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
  system.stateVersion = "25.11";
  networking.hostName = "rootless-nomad";
  networking.firewall.enable = false;
  networking.dhcpcd.wait = "ipv4";
  boot.kernelParams = [ "systemd.unified_cgroup_hierarchy=1" ];

  users.users.nomad = {
    isSystemUser = true;
    uid = 1001;
    group = "nomad";
    home = "/var/lib/nomad-user";
    createHome = true;
    subUidRanges = [{ startUid = 100000; count = 65536; }];
    subGidRanges = [{ startGid = 100000; count = 65536; }];
  };
  users.groups.nomad = {};
  systemd.tmpfiles.rules = [
    "f /var/lib/systemd/linger/nomad 0644 root root -"
    "d /var/lib/nomad/noneuclid-data 0770 nomad nomad -"
    "d /var/lib/nomad/postgres-data 0770 nomad nomad -"
    "d /sbin 0755 root root -"
    "L+ /sbin/ip - - - - ${pkgs.iproute2}/bin/ip"
  ];

  virtualisation.podman.enable = true;
  virtualisation.podman.dockerCompat = false;
  virtualisation.podman.defaultNetwork.settings.dns_enabled = true;

  # Alchemy will change application routes through Caddy's local admin API.
  # Resume the autosaved JSON config after a process restart. A NixOS Caddyfile
  # reload replaces API-managed routes; Alchemy must reconcile them afterward.
  # The Caddyfile provides the bootstrap route to the Nomad UI.
  services.caddy = {
    enable = true;
    resume = true;
    enableReload = false;
    extraConfig = ''
      http://nomad.localhost {
        reverse_proxy 127.0.0.1:4646
      }
    '';
  };

  # Testground exposes SSH only through a QEMU port forward bound to host loopback.
  # Caddy's admin API stays on guest loopback and is reached through an SSH tunnel.
  services.openssh = {
    enable = true;
    settings = {
      PermitRootLogin = "prohibit-password";
      PasswordAuthentication = false;
    };
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
    environment.PATH = lib.mkForce "/run/wrappers/bin:/run/current-system/sw/bin:/run/current-system/sw/sbin";
    serviceConfig = {
      ExecStart = [
        ""
        "${pkgs.podman}/bin/podman system service --time=0"
      ];
      Restart = "on-failure";
    };
  };

  systemd.services.nomad = {
    description = "Nomad local server and client";
    wantedBy = [ "multi-user.target" ];
    wants = [ "network-online.target" ];
    after = [ "network-online.target" "user@1001.service" ];
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
    bind_addr = "0.0.0.0"
    telemetry {
      publish_allocation_metrics = true
      publish_node_metrics = true
      prometheus_metrics = true
    }
    server {
      enabled = true
      bootstrap_expect = 1
    }
    client {
      enabled = true
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
  services.getty.autologinUser = "root";
}
