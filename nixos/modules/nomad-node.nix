# What every Nomad node shares: the agent, the rootless Podman it runs jobs in, and the
# Podman task driver. Each host adds the rest of its agent configuration in
# services.nomadNode.config: server or client, TLS, host volumes, OpenBao.
{ config, lib, pkgs, site, ... }:
let
  nomad = pkgs.callPackage ./nomad-package.nix { };
  cluster = site.cluster;

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
  imports = [ ./dev-postgres-volume.nix ];

  options.services.nomadNode.config = lib.mkOption {
    type = lib.types.lines;
    description = "This host's part of the Nomad agent configuration, in HCL.";
  };

  config = {
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
      environment.PATH = lib.mkForce "/run/wrappers/bin:/run/current-system/sw/bin:/run/current-system/sw/sbin";
      serviceConfig = {
        ExecStart = [ "" "${pkgs.podman}/bin/podman system service --time=0" ];
        Restart = "on-failure";
      };
    };

    systemd.services.nomad = {
      description = "Nomad agent";
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

      # The platform's OpenTelemetry collector scrapes /v1/metrics in Prometheus format
      # (tools/alchemy/platform/observability). Nomad serves only JSON without this.
      telemetry {
        prometheus_metrics = true
        publish_allocation_metrics = true
        publish_node_metrics = true
      }

      plugin "nomad-driver-podman" {
        config {
          socket_path = "unix:///run/user/1001/podman.sock"
          # Labels each container com.hashicorp.nomad.job_name and .task_name, so
          # host tools (backups.nix) can find a job's container without a Nomad token.
          extra_labels = ["job_name", "task_name"]
          volumes {
            enabled = true
          }
          networking {
            default_rootless_mode = "pasta"
          }
        }
      }

      ${config.services.nomadNode.config}
    '';

    environment.systemPackages = [ nomad pkgs.iproute2 pkgs.podman pkgs.curl pkgs.jq ];

    # Jobs pull their images from cynic's registry by this name (registry.nix).
    networking.hosts.${cluster.lanAddress} = [ cluster.registryName ];
    # Podman trusts the registry's server certificate with the CA in this folder (ca.crt).
    # On cynic, cluster-tls.service writes it; other nodes get it at install.
    environment.etc."containers/certs.d/${cluster.registryName}:${toString cluster.registryPort}".source =
      cluster.registryCaDir;
  };
}
