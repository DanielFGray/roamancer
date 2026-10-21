# Nomad ACL configuration for the cynic host.
#
# The Nomad listeners are bound to loopback, so only local processes can reach
# the API. Loopback is not an identity: a workload that can reach the host
# loopback can call the API. This module turns on Nomad's ACL enforcement and
# gives the Alchemy controller its own narrow token.
#
# Credentials never enter the Nix store. The store holds the ACL policy and
# the operator scripts; the tokens live in root-owned runtime files under
# /var/lib/nomad-acl.

{ config, lib, pkgs, ... }:

let
  credentialDir = "/var/lib/nomad-acl";
  policyFile = "/etc/nomad-acl/controller-policy.hcl";
  policyName = "alchemy-controller";

  # The capabilities below are the union of what the Alchemy controller calls
  # and what Nomad checks for those calls. Each line is justified by an API
  # call in tools/alchemy/src/Nomad.ts; nomad-acl-operations.md lists the
  # mapping.
  controllerPolicy = ''
    namespace "default" {
      capabilities = [
        "list-jobs",
        "read-job",
        "submit-job",
      ]
    }

    host_volume "noneuclid-data" {
      capabilities = ["mount-readwrite"]
    }

    host_volume "postgres-data" {
      capabilities = ["mount-readwrite"]
    }

    host_volume "valkey-data" {
      capabilities = ["mount-readwrite"]
    }
  '';

  # Bootstrapping the ACL system is an operator action, never an automatic
  # initializer. The script refuses to run when the ACL system is already
  # bootstrapped, so a second run cannot lose the management token.
  bootstrapScript = pkgs.writeShellScriptBin "nomad-acl-bootstrap" ''
    set -euo pipefail

    dir=${credentialDir}
    file="$dir/bootstrap.token"

    if [ -s "$file" ]; then
      echo "ACLs are already bootstrapped: $file exists." >&2
      echo "Nothing changed. See nomad-acl-operations.md for recovery." >&2
      exit 1
    fi

    umask 077
    tmp=$(mktemp "$dir/bootstrap.XXXXXXXX")
    trap 'rm -f "$tmp"' EXIT

    if ! nomad acl bootstrap -t '{{ .SecretID }}' > "$tmp"; then
      echo "Bootstrap failed and no token was stored." >&2
      echo "A message about 'ACL bootstrap already done' means the ACL system" >&2
      echo "holds tokens this host no longer has. Recover with the reset index;" >&2
      echo "see nomad-acl-operations.md." >&2
      exit 1
    fi

    if [ ! -s "$tmp" ]; then
      echo "Bootstrap produced no token." >&2
      exit 1
    fi

    mv -f "$tmp" "$file"
    chmod 0600 "$file"
    trap - EXIT

    echo "Bootstrap token stored in $file"
  '';

  # Issues the controller token from the stored bootstrap token. The policy is
  # applied first, so the token and the policy never drift apart.
  issueScript = pkgs.writeShellScriptBin "nomad-acl-issue-controller" ''
    set -euo pipefail

    dir=${credentialDir}
    bootstrap="$dir/bootstrap.token"
    token="$dir/controller.token"
    env_file="$dir/controller.env"
    policy=${policyFile}
    name=${policyName}

    if [ ! -s "$bootstrap" ]; then
      echo "No bootstrap token at $bootstrap." >&2
      echo "Run nomad-acl-bootstrap first." >&2
      exit 1
    fi

    if [ ! -f "$policy" ]; then
      echo "Missing policy file $policy." >&2
      exit 1
    fi

    umask 077
    tmp=$(mktemp "$dir/controller.XXXXXXXX")
    trap 'rm -f "$tmp"' EXIT

    NOMAD_TOKEN=$(cat "$bootstrap")
    export NOMAD_TOKEN

    nomad acl policy apply "$name" "$policy" > /dev/null
    nomad acl token create \
      -name="$name" \
      -type=client \
      -policy="$name" \
      -t '{{ .SecretID }}' > "$tmp"

    unset NOMAD_TOKEN

    if [ ! -s "$tmp" ]; then
      echo "Token creation produced no token." >&2
      exit 1
    fi

    mv -f "$tmp" "$token"
    chmod 0600 "$token"
    trap - EXIT

    printf 'NOMAD_TOKEN=%s\n' "$(cat "$token")" > "$env_file"

    # The Alchemy account reads the environment file. Give it to that group
    # when the group exists, and say so plainly when it does not.
    if getent group alchemy > /dev/null; then
      chown root:alchemy "$dir"
      chmod 0710 "$dir"
      chown root:alchemy "$env_file"
      chmod 0640 "$env_file"
      echo "Controller token stored in $token"
      echo "Runner environment file $env_file is readable by the alchemy group"
    else
      chmod 0600 "$env_file"
      echo "Controller token stored in $token"
      echo "Runner environment file $env_file is readable by root only." >&2
      echo "The alchemy account cannot read it until that account exists." >&2
    fi
  '';
in
{
  # Nomad merges every .hcl file in its configuration directory, so the ACL
  # block lives in its own file. The server, client, and plugin blocks in
  # nomad.hcl stay as they are.
  environment.etc."nomad.d/acl.hcl".text = ''
    acl {
      enabled = true
    }
  '';

  # The policy file cannot live in /etc/nomad.d: the agent would try to read it
  # as agent configuration and refuse to start.
  environment.etc."nomad-acl/controller-policy.hcl".text = controllerPolicy;

  # The credential directory holds tokens. It is created at boot, owned by
  # root, and holds nothing until an operator issues a token.
  systemd.tmpfiles.rules = [
    "d ${credentialDir} ${if config.users.groups ? alchemy then "0710 root alchemy" else "0700 root root"} -"
  ];

  # Restart Nomad when the ACL configuration changes. The guard keeps this
  # module safe to import on its own: without the base Nomad configuration
  # there is no Nomad service to restart.
  systemd.services = lib.mkIf (config.environment.etc ? "nomad.d/nomad.hcl") {
    nomad.restartTriggers = [ config.environment.etc."nomad.d/acl.hcl".source ];
  };

  environment.systemPackages = [
    bootstrapScript
    issueScript
  ];
}
