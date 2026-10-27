# Alchemy runner on the control host: system user, state directory, submit socket,
# and per-job units. The queue behind the socket is not built yet; the socket service
# only records that fact. Enabled when this host is site.cluster.server, or when
# enable is set (the disposable testground VM).
{ config, lib, pkgs, site, ... }:
let
  cfg = config.services.alchemyRunner;
  operator = site.operator;
  controlHost = config.networking.hostName == site.cluster.server;
in
{
  options.services.alchemyRunner = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = controlHost;
      defaultText = lib.literalExpression "config.networking.hostName == site.cluster.server";
      description = "Install the Alchemy runner user, submit socket, and job units.";
    };

    package = lib.mkOption {
      type = lib.types.package;
      description = "Pinned Alchemy host program (alchemy-runner).";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.alchemy = { };
    users.groups.alchemy-submit = { };

    users.users.alchemy = {
      isSystemUser = true;
      group = "alchemy";
      home = "/var/lib/alchemy";
      createHome = true;
      homeMode = "0700";
    };

    # Operator may connect to the submit socket. Membership in group alchemy (Nomad
    # controller.env reader) stays in the control host's own config until cutover.
    users.users.${operator.name}.extraGroups = [ "alchemy-submit" ];

    environment.systemPackages = [ cfg.package ];

    systemd.sockets.alchemy-submit = {
      description = "Alchemy job submission socket";
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = "/run/alchemy/submit.sock";
        SocketGroup = "alchemy-submit";
        SocketMode = "0660";
        DirectoryMode = "0755";
        Accept = false;
      };
    };

    systemd.services.alchemy-submit = {
      description = "Alchemy job submission (queue not built yet)";
      requires = [ "alchemy-submit.socket" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = pkgs.writeShellScript "alchemy-submit-stub" ''
          ${pkgs.util-linux}/bin/logger -t alchemy-submit "Alchemy queue is not built yet"
          exit 1
        '';
      };
    };

    systemd.services."alchemy-job@" = {
      description = "Alchemy job %i";
      serviceConfig = {
        Type = "oneshot";
        User = "alchemy";
        Group = "alchemy";
        ExecStart = "${cfg.package}/bin/alchemy-runner job %i";
        WorkingDirectory = "/var/lib/alchemy";
        StateDirectory = "alchemy";
        StateDirectoryMode = "0700";
      };
    };
  };
}
