{ config, lib, ... }:
let
  cfg = config.services.alchemyStaged;
in
{
  options.services.alchemyStaged = {
    enable = lib.mkEnableOption "the host-owned Alchemy staged release controller";

    package = lib.mkOption {
      type = lib.types.package;
      description = "Pinned Alchemy runtime and staged host commands.";
    };

    nomadTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional systemd environment file for the Nomad ACL token.";
    };

    operatorGroups = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "wheel" ];
      description = "Groups allowed to run staged Alchemy commands as the alchemy account.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.alchemy = { };
    users.users.alchemy = {
      isSystemUser = true;
      group = "alchemy";
      home = "/var/lib/alchemy";
      createHome = false;
    };

    security.sudo.extraRules = map (group: {
      groups = [ group ];
      runAs = "alchemy";
      commands = [
        {
          command = "${cfg.package}/bin/alchemy-staged";
          options = [ "NOPASSWD" ];
        }
      ];
    }) cfg.operatorGroups;

    environment.systemPackages = [ cfg.package ];

    systemd.services.alchemy-staged-controller = {
      description = "Reconcile staged Nomad releases with Alchemy";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" "nomad.service" "caddy.service" ];
      after = [ "network-online.target" "nomad.service" "caddy.service" ];
      unitConfig = lib.mkIf (cfg.nomadTokenFile != null) {
        ConditionPathExists = cfg.nomadTokenFile;
      };
      serviceConfig = {
        User = "alchemy";
        Group = "alchemy";
        StateDirectory = "alchemy";
        StateDirectoryMode = "0700";
        WorkingDirectory = "/var/lib/alchemy";
        UMask = "0077";
        Environment = [
          "HOME=/var/lib/alchemy"
          "NOMAD_ADDR=http://127.0.0.1:4646"
          "CADDY_ADMIN_ADDR=http://127.0.0.1:2019"
          "ALCHEMY_HOST_RUNNER=${cfg.package}/bin/alchemy-staged"
        ] ++ lib.optional (cfg.nomadTokenFile != null) "NOMAD_TOKEN_ENV_FILE=${cfg.nomadTokenFile}";
        EnvironmentFile = lib.optional (cfg.nomadTokenFile != null) cfg.nomadTokenFile;
        ExecStart = "${cfg.package}/bin/alchemy-controller";
        Restart = "on-failure";
        RestartSec = "3s";
        # Peak use measured at about 287 MB on Bun 1.4.2. An earlier reconcile hit this cap under an older runtime and was killed.
        MemoryMax = "512M";
        KillMode = "control-group";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ "/var/lib/alchemy" ];
        PrivateTmp = true;
      };
    };
  };
}
