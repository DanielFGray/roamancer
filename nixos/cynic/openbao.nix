# OpenBao, the secret store for the platform jobs.
#
# The default listener binds loopback and serves plain HTTP for this host: Nomad's
# Vault integration, Alchemy and the unseal check. The lan listener serves other
# machines' Nomad clients over mutual TLS.
#
# OpenBao unseals itself at start with a static seal key. The key sits on disk only as a
# systemd credential encrypted with the VM's TPM, so a copy of the disk without the TPM
# state cannot open it. The operator's password manager holds the only other copy; with
# an auto seal the recovery keys cannot decrypt the data, so losing both copies loses
# every secret. openbao-operations.md covers creating and restoring the key.
{ pkgs, ... }:
let
  sealKeyCredential = "/var/lib/openbao-seal/seal-key.cred";
  cluster = import ../cluster.nix;
in
{
  services.openbao = {
    enable = true;
    settings = {
      ui = false;
      listener.default = {
        type = "tcp";
        address = "127.0.0.1:8200";
        tls_disable = true;
      };
      # Nomad clients on other machines fetch their jobs' secrets here. Only holders of a
      # cluster client certificate (cluster-tls.nix) get past the handshake.
      listener.lan = {
        type = "tcp";
        address = "${cluster.lanAddress}:8200";
        tls_cert_file = "/run/credentials/openbao.service/cert";
        tls_key_file = "/run/credentials/openbao.service/key";
        tls_client_ca_file = "/run/credentials/openbao.service/ca";
        tls_require_and_verify_client_cert = true;
      };
      api_addr = "http://127.0.0.1:8200";
      cluster_addr = "http://127.0.0.1:8201";
      storage.raft.path = "/var/lib/openbao";
      seal.static = {
        current_key_id = "cynic-1";
        current_key = "file:///run/credentials/openbao.service/seal-key";
      };
    };
  };

  systemd.tmpfiles.rules = [ "d /var/lib/openbao-seal 0700 root root -" ];

  # Creates the seal key credential, or restores it from the password manager after a
  # rebuild gives the VM a new TPM. Run as root from an interactive ssh session: the key is
  # shown once on the terminal and otherwise stays in memory. It refuses to replace an
  # existing credential, because the store stays encrypted with the key it was sealed with.
  environment.systemPackages = [
    (pkgs.writeShellApplication {
      name = "openbao-seal-key";
      runtimeInputs = [ pkgs.coreutils pkgs.systemd ];
      text = ''
        credential=${sealKeyCredential}
        if [ -e "$credential" ]; then
          echo "$credential already exists; refusing to replace it" >&2
          exit 1
        fi
        case "''${1:-new}" in
          new)
            key=$(head -c 32 /dev/urandom | base64 -w0)
            printf 'OpenBao seal key (key id cynic-1):\n\n%s\n\n' "$key"
            read -rp "Press Enter once the key is saved in the password manager. "
            printf '\033[2J\033[H'
            ;;
          --restore)
            read -rsp "Paste the seal key (base64): " key
            echo
            ;;
          *)
            echo "usage: openbao-seal-key [--restore]" >&2
            exit 2
            ;;
        esac
        printf %s "$key" | base64 -d \
          | systemd-creds encrypt --with-key=tpm2 --tpm2-pcrs= --name=seal-key - "$credential"
        echo "Wrote $credential. Restart OpenBao: systemctl restart openbao"
      '';
    })
  ];

  systemd.services.openbao.serviceConfig = {
    LoadCredentialEncrypted = "seal-key:${sealKeyCredential}";
    LoadCredential = [
      "cert:${cluster.tlsDir}/global-server-nomad.pem"
      "key:${cluster.tlsDir}/global-server-nomad-key.pem"
      "ca:${cluster.tlsDir}/nomad-agent-ca.pem"
    ];
  };

  # A job whose allocation starts while OpenBao is sealed fails its Vault hook, and Nomad
  # does not retry that failure. Nomad therefore waits until OpenBao reports unsealed.
  # Wants rather than Requires: when the seal cannot open, Nomad still starts after the
  # timeout, so jobs without secrets keep running.
  systemd.services.openbao-unsealed = {
    description = "Wait until OpenBao is unsealed";
    after = [ "openbao.service" ];
    wants = [ "openbao.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      TimeoutStartSec = "2min";
    };
    path = [ pkgs.curl pkgs.jq ];
    script = ''
      until curl -sf http://127.0.0.1:8200/v1/sys/seal-status | jq -e '.sealed == false' >/dev/null; do
        sleep 2
      done
    '';
  };

  systemd.services.nomad = {
    after = [ "openbao-unsealed.service" ];
    wants = [ "openbao-unsealed.service" ];
  };
}
