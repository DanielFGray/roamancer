# The cluster's TLS: the Nomad agent CA for Nomad RPC, OpenBao and the registry's
# server certificate; a separate registry CA for registry client certificates only.
# Nomad clients and the workstation verify the registry server with the Nomad CA.
# Pulls and pushes authenticate with a cert from the registry CA, which Nomad never
# accepts, so a holder of the registry client key cannot join as a Nomad node.
#
# cluster-tls.service creates each CA once. It re-issues a certificate when it has
# less than 30 days left (certificates last a year) or no longer names the addresses
# its clients use, at boot and daily. It runs before the listeners start, so keys
# never pass through the Nix store.
#
# CA keys exist only in tlsDir. Losing either means re-issuing every certificate that
# CA signed, so back them up in the password manager (cluster-tls-operations.md).
{ pkgs, site, ... }:
let
  cluster = site.cluster;
  nomad = pkgs.callPackage ../modules/nomad-package.nix { };
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

      if [ ! -s registry-ca-key.pem ]; then
        if [ -e registry-ca.pem ]; then
          echo "${cluster.tlsDir} has a registry CA but no key; restore the registry CA key" >&2
          exit 1
        fi
        openssl req -x509 -newkey rsa:4096 -sha256 -days 1825 -nodes \
          -keyout registry-ca-key.pem -out registry-ca.pem \
          -subj "/CN=cluster-registry-ca"
      fi

      # True when the certificate has 30 days left, chains to the CA, and passes the
      # name checks given after it.
      current() {
        local cert=$1
        local ca=$2
        shift 2
        openssl x509 -in "$cert" -noout -checkend $((30 * 86400)) >/dev/null 2>&1 &&
          openssl verify -CAfile "$ca" "$@" "$cert" >/dev/null 2>&1
      }

      if ! current global-server-nomad.pem nomad-agent-ca.pem \
          -verify_ip ${cluster.lanAddress} -verify_hostname ${cluster.registryName}; then
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

      # nomad pulls job images; the operator may push from a build node. Both are in
      # registry-client. The client key is from the registry CA (Nomad never accepts it).
      # ca.crt is the Nomad CA, which signs the registry's server certificate.
      client=${cluster.registryClientDir}
      if ! current "$client/client.cert" registry-ca.pem; then
        work=$(mktemp -d)
        openssl req -newkey rsa:4096 -nodes -sha256 \
          -keyout "$work/key.pem" -out "$work/req.csr" \
          -subj "/CN=registry-client"
        openssl x509 -req -in "$work/req.csr" -CA registry-ca.pem -CAkey registry-ca-key.pem \
          -CAcreateserial -out "$work/cert.pem" -days 365 -sha256
        install -d -m 0750 -g registry-client "$client"
        install -m 0644 nomad-agent-ca.pem "$client/ca.crt"
        install -m 0644 "$work/cert.pem" "$client/client.cert"
        install -m 0640 -g registry-client "$work/key.pem" "$client/client.key"
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
    '') (builtins.attrValues cluster.nodes)
    ++ [ ''
      iptables -A nixos-fw -i ${cluster.lanInterface} -s ${cluster.workstation} -p tcp -m multiport --dports 4647,8200,${toString cluster.registryPort} -j nixos-fw-accept
    '' ]
  );
}
