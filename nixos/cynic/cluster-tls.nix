# The cluster's TLS: one CA, and a server certificate for cynic that every LAN listener
# presents: Nomad RPC, OpenBao's LAN listener and the image registry. Nomad clients and
# the workstation get client certificates from the same CA, so only machines holding
# one can join the cluster, reach OpenBao, or pull and push images.
#
# cluster-tls.service creates the CA once. It re-issues a certificate when it has less
# than 30 days left (certificates last a year) or no longer names the addresses its
# clients use, at boot and daily. It runs before the listeners start, so keys never pass
# through the Nix store.
#
# The CA key exists only in tlsDir. Losing it means re-issuing every client's
# certificate, so back it up in the password manager (cluster-tls-operations.md).
{ pkgs, ... }:
let
  cluster = import ./cluster.nix;
  nomad = pkgs.callPackage ./nomad-package.nix { };
  listeners = [ "nomad.service" "openbao.service" "docker-registry.service" ];
in
{
  systemd.services.cluster-tls = {
    description = "Cluster CA and certificates";
    before = listeners;
    requiredBy = listeners;
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

      # True when the certificate has 30 days left, chains to the CA, and passes the
      # name checks given after it.
      current() {
        local cert=$1
        shift
        openssl x509 -in "$cert" -noout -checkend $((30 * 86400)) >/dev/null 2>&1 &&
          openssl verify -CAfile nomad-agent-ca.pem "$@" "$cert" >/dev/null 2>&1
      }

      if ! current global-server-nomad.pem -verify_ip ${cluster.lanAddress} -verify_hostname ${cluster.registryName}; then
        rm -f global-server-nomad.pem global-server-nomad-key.pem
        nomad tls cert create -server -region global \
          -additional-ipaddress ${cluster.lanAddress} -additional-dnsname ${cluster.registryName}
        # Nomad rereads its certificate files on SIGHUP. OpenBao and the registry read
        # copies that systemd makes at start (LoadCredential), so they restart; OpenBao
        # unseals itself. --no-block: they require this unit, so waiting for their
        # restart from here deadlocks until this unit exits.
        if systemctl is-active --quiet nomad.service; then systemctl kill -s HUP nomad.service; fi
        systemctl --no-block try-restart openbao.service docker-registry.service
      fi

      # cynic's rootless Podman pulls job images as the nomad user, so its registry
      # client certificate lives outside tlsDir, readable by that user. Podman reads the
      # files on each pull.
      client=${cluster.registryClientDir}
      if ! current "$client/client.cert"; then
        work=$(mktemp -d)
        (cd "$work" && nomad tls cert create -client -region global \
          -ca ${cluster.tlsDir}/nomad-agent-ca.pem -key ${cluster.tlsDir}/nomad-agent-ca-key.pem)
        install -d -m 0750 -g nomad "$client"
        install -m 0644 nomad-agent-ca.pem "$client/ca.crt"
        install -m 0644 "$work/global-client-nomad.pem" "$client/client.cert"
        install -m 0640 -g nomad "$work/global-client-nomad-key.pem" "$client/client.key"
        rm -rf "$work"
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

  # Nodes reach every TCP port. The workstation reaches only the listeners behind the CA.
  networking.firewall.extraCommands = builtins.concatStringsSep "\n" (
    map (node: ''
      iptables -A nixos-fw -i ${cluster.lanInterface} -s ${node} -p tcp -j nixos-fw-accept
    '') cluster.nodes
    ++ [ ''
      iptables -A nixos-fw -i ${cluster.lanInterface} -s ${cluster.workstation} -p tcp -m multiport --dports 4647,8200,${toString cluster.registryPort} -j nixos-fw-accept
    '' ]
  );
}
