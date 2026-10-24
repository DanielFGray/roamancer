# The cluster's TLS: one CA, and a server certificate for cynic that both Nomad RPC
# and OpenBao's LAN listener present. Nomad clients on other machines get client
# certificates from the same CA, so only machines holding one can join or reach
# OpenBao.
#
# cluster-tls.service creates the CA once and renews the server certificate when it
# has less than 30 days left (certificates last a year), at boot and daily. It runs
# before Nomad and OpenBao start, so keys never pass through the Nix store.
#
# The CA key exists only in tlsDir. Losing it means re-issuing every client's
# certificate, so back it up in the password manager (cluster-tls-operations.md).
{ pkgs, ... }:
let
  cluster = import ./cluster.nix;
  nomad = pkgs.callPackage ./nomad-package.nix { };
in
{
  systemd.services.cluster-tls = {
    description = "Cluster CA and server certificate";
    before = [ "nomad.service" "openbao.service" ];
    requiredBy = [ "nomad.service" "openbao.service" ];
    serviceConfig = {
      Type = "oneshot";
      UMask = "0077";
    };
    path = [ nomad pkgs.openssl pkgs.systemd ];
    script = ''
      set -euo pipefail
      mkdir -p ${cluster.tlsDir}
      cd ${cluster.tlsDir}
      if [ ! -s nomad-agent-ca-key.pem ]; then
        # A missing CA beside existing certificates means the CA was lost, not that this
        # is the first start. A new CA would silently cut off every client.
        if [ -e global-server-nomad.pem ]; then
          echo "${cluster.tlsDir} has certificates but no CA key; restore the CA key" >&2
          exit 1
        fi
        nomad tls ca create
      fi
      if ! openssl x509 -in global-server-nomad.pem -noout -checkend $((30 * 86400)) 2>/dev/null; then
        rm -f global-server-nomad.pem global-server-nomad-key.pem
        nomad tls cert create -server -region global -additional-ipaddress ${cluster.lanAddress}
        # Nomad rereads its certificate files on SIGHUP. OpenBao reads copies that
        # systemd makes at start (LoadCredential), so it restarts; it unseals itself.
        # --no-block: OpenBao requires this unit, so waiting for its restart from here
        # deadlocks until this unit exits.
        if systemctl is-active --quiet nomad.service; then systemctl kill -s HUP nomad.service; fi
        systemctl --no-block try-restart openbao.service
      fi
    '';
  };

  # A host can run longer than the renewal window, so check daily as well as at boot.
  systemd.timers.cluster-tls = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "daily";
      Persistent = true;
    };
  };

  # Sources in clientSources may reach Nomad RPC and OpenBao's LAN listener.
  networking.firewall.extraCommands = builtins.concatStringsSep "\n" (map (source: ''
    iptables -A nixos-fw -i ${cluster.lanInterface} -s ${source} -p tcp -m multiport --dports 4647,8200 -j nixos-fw-accept
  '') cluster.clientSources);
}
