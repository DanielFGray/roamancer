{ config, lib, ... }:
let
  cfg = config.services.alchemyStaged;
in
{
  options.services.alchemyStaged = {
    enable = lib.mkEnableOption "the host-owned Alchemy staged release runner";

    package = lib.mkOption {
      type = lib.types.package;
      description = "Pinned Alchemy runtime and staged host commands.";
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
      # The account owns the state directory. Without a service to create it,
      # the operator command needs the home directory to exist.
      home = "/var/lib/alchemy";
      createHome = true;
      homeMode = "0700";
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
  };
}
