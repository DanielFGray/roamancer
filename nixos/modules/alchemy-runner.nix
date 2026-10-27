# Alchemy runner on the control host: system user, state directory, submit socket,
# queue front end, and per-job units. Enabled when this host is site.cluster.server,
# or when enable is set (the disposable testground VM).
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

    # alchemy may start only alchemy-job@*.service (the queue front end serialises work).
    security.polkit.extraConfig = ''
      polkit.addRule(function(action, subject) {
        if (subject.user !== "alchemy") return;
        if (action.id !== "org.freedesktop.systemd1.manage-units") return;
        var unit = action.lookup("unit");
        var verb = action.lookup("verb");
        if (unit && verb === "start" && /^alchemy-job@.+\.service$/.test(unit)) {
          return polkit.Result.YES;
        }
      });
    '';

    systemd.sockets.alchemy-submit = {
      description = "Alchemy job submission socket";
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = "/run/alchemy/submit.sock";
        SocketUser = "alchemy";
        SocketGroup = "alchemy-submit";
        SocketMode = "0660";
        DirectoryMode = "0755";
        Accept = false;
      };
    };

    systemd.services.alchemy-submit = {
      description = "Alchemy job queue front end";
      requires = [ "alchemy-submit.socket" ];
      after = [ "alchemy-submit.socket" ];
      serviceConfig = {
        Type = "simple";
        User = "alchemy";
        Group = "alchemy";
        ExecStart = "${cfg.package}/bin/alchemy-runner queue serve";
        WorkingDirectory = "/var/lib/alchemy";
        StateDirectory = "alchemy";
        StateDirectoryMode = "0700";
      };
    };

    systemd.services."alchemy-job@" = {
      description = "Alchemy job %i";
      serviceConfig = {
        Type = "oneshot";
        User = "alchemy";
        Group = "alchemy";
        ExecStart = "${cfg.package}/bin/alchemy-runner job run %i";
        # On every exit: finalise a stuck queued/running row, then ask the front end for next.
        ExecStopPost = "${cfg.package}/bin/alchemy-runner job finished %i";
        WorkingDirectory = "/var/lib/alchemy";
        StateDirectory = "alchemy";
        StateDirectoryMode = "0700";
      };
    };
  };
}
