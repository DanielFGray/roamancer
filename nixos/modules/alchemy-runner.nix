# Alchemy runner on the control host: system user, state directory, submit socket,
# queue front end, and per-job units. Enabled when this host is site.cluster.server,
# or when enable is set (the disposable testground VM).
{ config, lib, pkgs, site, policy, ... }:
let
  cfg = config.services.alchemyRunner;
  operator = site.operator;
  controlHost = config.networking.hostName == site.cluster.server;

  # policy.toml of the site folder (src/Policy.ts): the apps the runner watches. It
  # reaches the host only through this build, so widening it needs `ops rebuild`.
  watched = policy.apps or { };
  watchedNames = builtins.attrNames watched;
  autoApps = builtins.filter (name: (watched.${name}.deploy or "auto") == "auto") watchedNames;
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

    repositories = lib.mkOption {
      type = lib.types.str;
      default = "/srv/git";
      readOnly = true;
      description = "The apps' bare repositories; tools/alchemy/src/queue/Paths.ts names the same folder.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = map (name: {
      assertion = builtins.match "[a-z0-9]+(-[a-z0-9]+)*" name != null;
      message = "policy.toml: app name '${name}' must be lowercase letters, digits and single hyphens";
    }) watchedNames;

    users.groups.alchemy = { };
    users.groups.alchemy-submit = { };
    users.groups.alchemy-repositories.members = [ operator.name "alchemy" ];

    users.users.alchemy = {
      isSystemUser = true;
      group = "alchemy";
      home = "/var/lib/alchemy";
      createHome = true;
      homeMode = "0700";
    };

    # The operator may connect to the submit socket. Group alchemy (Nomad controller.env
    # readers) holds only the alchemy user: the operator reaches Nomad through jobs.
    users.users.${operator.name}.extraGroups = [ "alchemy-submit" ];

    environment.systemPackages = [ cfg.package ];

    environment.etc."alchemy/policy.json".text = builtins.toJSON policy;

    # The apps' repositories: the operator pushes to `<operator>@<host>:<repositories>/<app>.git`
    # and reconcile reads `main` there (src/Reconcile.ts). The folder is setgid group
    # alchemy-repositories, so each repository and every object a push writes has that group,
    # which can read and not write it: a push changes what releases, and a job cannot change
    # what was pushed. The operator is a member because Linux clears a folder's setgid bit
    # when a user outside its group changes its mode, as git does to each folder it makes.
    systemd.tmpfiles.rules = [ "d ${cfg.repositories} 2750 ${operator.name} alchemy-repositories -" ];

    # Git refuses a repository that another user owns unless protected config (here
    # /etc/gitconfig) lists it, and alchemy reads the operator's repositories.
    programs.git = {
      enable = true;
      config.safe.directory = "${cfg.repositories}/*";
    };

    # Makes a bare repository for each app in the policy that lacks one. An existing
    # repository is never touched: it holds the only pushed copy besides the operator's.
    systemd.services.alchemy-repositories = {
      description = "Bare repositories of the apps in the site policy";
      wantedBy = [ "multi-user.target" ];
      after = [ "systemd-tmpfiles-setup.service" ];
      path = [ pkgs.git ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = operator.name;
      };
      # --shared=0640 keeps every file the operator's and readable by the group, whatever
      # umask a push runs with.
      script = lib.concatMapStringsSep "\n" (name: ''
        if [ ! -e ${cfg.repositories}/${name}.git ]; then
          git init --bare --quiet --shared=0640 -b main ${cfg.repositories}/${name}.git
        fi
      '') watchedNames;
    };

    # Once a minute, queue a reconcile job for each app whose pushes release unattended. The
    # front end queues none for an app that has one waiting or running.
    systemd.services.alchemy-reconcile = lib.mkIf (autoApps != [ ]) {
      description = "Queue Alchemy reconcile jobs";
      serviceConfig = {
        Type = "oneshot";
        User = "alchemy";
        Group = "alchemy";
        ExecStart = "${cfg.package}/bin/alchemy-runner reconcile enqueue";
      };
    };
    systemd.timers.alchemy-reconcile = lib.mkIf (autoApps != [ ]) {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "1min";
        OnUnitActiveSec = "1min";
      };
    };

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

    systemd.services.alchemy-submit = {
      description = "Alchemy job queue front end";
      # The front end binds /run/alchemy/submit.sock itself (Serve.ts says why not socket
      # activation). Group and umask give the socket group alchemy-submit, mode 0770.
      # No StateDirectory: the job units own /var/lib/alchemy as group alchemy, and a
      # second owner would make systemd chown it back and forth. createHome makes it.
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "simple";
        User = "alchemy";
        Group = "alchemy-submit";
        UMask = "0007";
        ExecStart = "${cfg.package}/bin/alchemy-runner queue serve";
        Restart = "on-failure";
        RuntimeDirectory = "alchemy";
        RuntimeDirectoryMode = "0755";
        # Keep /run/alchemy across restarts: it holds the minted OpenBao token.
        RuntimeDirectoryPreserve = "yes";
        WorkingDirectory = "/var/lib/alchemy";
      };
    };

    # The fleet service: the snapshot `ops dash` prints and the fleet page polls. It reads
    # outside the job queue, so it keeps answering while a deploy runs. It runs as alchemy,
    # the only user that can read the queue and the deployment record, with the read-only
    # token that `sudo nomad-acl-issue-fleet` writes once; until then it fails and retries.
    systemd.services.alchemy-fleet = {
      description = "Alchemy fleet snapshot service";
      after = [ "network-online.target" "nomad.service" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "simple";
        User = "alchemy";
        Group = "alchemy";
        ExecStart = "${cfg.package}/bin/alchemy-runner fleet serve";
        # HTTPS 443 on this host's MagicDNS name, to the loopback port in
        # tools/alchemy/src/fleet/Api.ts. Alchemy leases 9000-9099 for app routes, so the
        # two never meet. Tailscale keeps the setting, so repeating it is harmless. "-": a
        # host that is not logged in to Tailscale (the testground) still serves on loopback.
        ExecStartPost = "-${config.services.tailscale.package}/bin/tailscale serve --bg --https=443 http://127.0.0.1:8780";
        Restart = "on-failure";
        RestartSec = 30;
        WorkingDirectory = "/var/lib/alchemy";
      };
    };

    # Jobs run TailscaleServe's `tailscale serve`, which needs root or the Tailscale
    # operator. Tailscale has one operator, so it is the account that deploys.
    services.tailscale.extraSetFlags = [ "--operator=alchemy" ];

    systemd.services."alchemy-job@" = {
      description = "Alchemy job %i";
      # A unit's PATH holds only coreutils and systemd: jobs also run tailscale (TailscaleServe)
      # and psql, pg_dump and pg_restore (PostgresDatabase); a reconcile job runs git and unpacks the tree with tar.
      path = [ config.services.tailscale.package pkgs.postgresql_17 pkgs.git pkgs.gnutar ];
      # A build job (tools/alchemy/src/BuildJob.ts) asks the registry whether it holds the digest a build printed,
      # and names the worker nodes' registry CA folder in the Nomad job. Bun trusts the
      # cluster CA through NODE_EXTRA_CA_CERTS.
      environment = {
        REGISTRY = "${site.cluster.registryName}:${toString site.cluster.registryPort}";
        REGISTRY_CA_DIR = site.cluster.registryCaDir;
        NODE_EXTRA_CA_CERTS = "${site.cluster.registryCaDir}/ca.crt";
      };
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
