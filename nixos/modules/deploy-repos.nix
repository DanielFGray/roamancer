# The checkouts `ops` pushes to. They must belong to the operator, so this runs as a
# oneshot under that account rather than as root during activation. An existing
# repository's files and history stay untouched: only a missing checkout is created.
{ config, lib, pkgs, site, ... }:
let
  operator = site.operator;
  home = config.users.users.${operator.name}.home;
  git = "${pkgs.git}/bin/git";
  controlHost = config.networking.hostName == site.cluster.server;
in
{
  systemd.services.deploy-repos = {
    description = "Operator deploy checkouts";
    wantedBy = [ "multi-user.target" ];
    restartIfChanged = true;
    serviceConfig = {
      Type = "oneshot";
      User = operator.name;
    };
    script = ''
      set -euo pipefail
      cd ${lib.escapeShellArg home}
      for repo in server-ansible site; do
        if [ ! -d "$repo/.git" ]; then
          ${git} init -q -b deploy "$repo"
        fi
        ${git} -C "$repo" config receive.denyCurrentBranch updateInstead
      done
    ''
    + lib.optionalString controlHost ''
      # A real folder is the earlier rsync layout; replacing it would hide Alchemy state.
      if [ -d alchemy ] && [ ! -L alchemy ]; then
        echo "~/alchemy is a folder from the rsync layout. Move its .alchemy and node_modules to ~/server-ansible/tools/alchemy, remove it, and rebuild." >&2
        exit 1
      fi
      ln -sfn server-ansible/tools/alchemy alchemy
    '';
  };
}
