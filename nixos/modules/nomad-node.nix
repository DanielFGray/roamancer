# What every Nomad node shares: the agent, the rootless Podman it runs jobs in, and the
# Podman task driver. Each host adds the rest of its agent configuration in
# services.nomadNode.config: server or client, TLS, host volumes, OpenBao.
#
# Worker nodes set services.nomadNode.builder.enable: a second rootless Podman under the
# builder user, named in the driver as socket "builder", with meta.builder for job
# constraints. The control host leaves it off so builds never share a kernel with OpenBao
# and the registry (docs/design/continuous-deployment.md).
{ config, lib, pkgs, site, ... }:
let
  nomad = pkgs.callPackage ./nomad-package.nix { };
  cluster = site.cluster;
  cfg = config.services.nomadNode;
  # After nomad's 100000–165535 range so the two users' containers never share host uids.
  builderSubIdStart = 165536;

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

  # Named sockets when the builder is on; socket_path alone when it is not. The two forms
  # are mutually exclusive in driver 0.6.5.
  podmanSockets =
    if cfg.builder.enable then ''
      socket {
        name = "default"
        socket_path = "unix:///run/user/1001/podman.sock"
      }
      socket {
        name = "builder"
        socket_path = "unix:///run/user/${toString config.users.users.builder.uid}/podman.sock"
      }
    '' else ''
      socket_path = "unix:///run/user/1001/podman.sock"
    '';
  podmanPluginConfig = ''
    plugin "nomad-driver-podman" {
      config {
        ${podmanSockets}
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
  '';
in
{
  imports = [ ./dev-postgres-volume.nix ];

  options.services.nomadNode = {
    config = lib.mkOption {
      type = lib.types.lines;
      description = "This host's part of the Nomad agent configuration, in HCL.";
    };
    builder.enable = lib.mkEnableOption
      "builder user with its own rootless Podman for Nomad batch builds on this worker";
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

    users.users.builder = lib.mkIf cfg.builder.enable {
      isSystemUser = true;
      uid = 1002;
      group = "builder";
      home = "/var/lib/builder";
      createHome = true;
      description = "Nomad batch image builds";
      subUidRanges = [{ startUid = builderSubIdStart; count = 65536; }];
      subGidRanges = [{ startGid = builderSubIdStart; count = 65536; }];
    };
    users.groups.builder = lib.mkIf cfg.builder.enable { gid = config.users.users.builder.uid; };

    systemd.tmpfiles.rules = [
      # A unit bind mount would hide Nomad's secrets tmpfs from rootless Podman.
      # Keep the ip executable visible without giving Nomad a private mount namespace.
      "L+ /sbin/ip - - - - ${pkgs.iproute2}/bin/ip"
      "f /var/lib/systemd/linger/nomad 0644 root root -"
    ] ++ lib.optionals cfg.builder.enable [
      "f /var/lib/systemd/linger/builder 0644 root root -"
    ];

    # Cap every build on the node together and yield CPU to production containers under
    # the nomad user. user-<uid>.slice holds the lingering user manager and its Podman.
    systemd.slices = lib.mkIf cfg.builder.enable {
      "user-${toString config.users.users.builder.uid}".sliceConfig = {
        MemoryMax = "2560M";
        CPUWeight = 20;
      };
    };

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

    # The podman driver removes a task's container when the task stops, but never its image,
    # so every release leaves the previous image in the nomad user's storage. Remove each image
    # that no container uses; a later deploy or rollback pulls it again from the registry. A
    # prune that runs between a pull and its container's start removes that image, and the
    # task fails; Nomad then places it again, and the new pull succeeds.
    systemd.services.nomad-podman-prune = {
      description = "Remove Podman images that no Nomad container uses";
      serviceConfig = {
        Type = "oneshot";
        User = "nomad";
        ExecStart = "${pkgs.podman}/bin/podman --url unix:///run/user/1001/podman.sock image prune --all --force";
      };
    };
    systemd.timers.nomad-podman-prune = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "daily";
        RandomizedDelaySec = "1h";
        Persistent = true;
      };
    };

    systemd.services.nomad = {
      description = "Nomad agent";
      restartTriggers = [ config.environment.etc."nomad.d/nomad.hcl".source ];
      wantedBy = [ "multi-user.target" ];
      # The builder's manager is wanted, not required: a broken builder must not stop
      # production jobs.
      wants = [ "network-online.target" "tailscaled.service" ]
        ++ lib.optionals cfg.builder.enable [ "user@${toString config.users.users.builder.uid}.service" ];
      after = [ "network-online.target" "tailscaled.service" "user@1001.service" ]
        ++ lib.optionals cfg.builder.enable [ "user@${toString config.users.users.builder.uid}.service" ];
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

      ${podmanPluginConfig}

      ${cfg.config}
    '';

    # Merged with the host's client block. Build jobs constrain on this.
    environment.etc."nomad.d/builder-meta.hcl" = lib.mkIf cfg.builder.enable {
      text = ''
        client {
          meta {
            builder = "true"
          }
        }
      '';
    };

    environment.systemPackages = [ nomad pkgs.iproute2 pkgs.podman pkgs.curl pkgs.jq ];

    # Jobs pull their images from cynic's registry by this name (registry.nix).
    networking.hosts.${cluster.lanAddress} = [ cluster.registryName ];
    # Podman trusts the registry's server certificate with the CA in this folder (ca.crt).
    # On cynic, cluster-tls.service writes it; other nodes get it at install.
    environment.etc."containers/certs.d/${cluster.registryName}:${toString cluster.registryPort}".source =
      cluster.registryCaDir;
  };
}
