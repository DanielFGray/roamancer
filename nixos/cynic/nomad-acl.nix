# Nomad ACL configuration for the cynic host.
#
# The Nomad listeners are bound to loopback, so only local processes can reach
# the API. Loopback is not an identity: a workload that can reach the host
# loopback can call the API. This module turns on Nomad's ACL enforcement and
# gives the staged Alchemy commands a narrow token, the operator and the fleet
# service read-only tokens, and the ingress job a narrow policy.
#
# Credentials never enter the Nix store. The store holds the ACL policy and
# the operator scripts; the tokens live in root-owned runtime files under
# /var/lib/nomad-acl.

{ config, lib, pkgs, site, ... }:

let
  credentialDir = "/var/lib/nomad-acl";
  operatorName = site.operator.name;

  # The capabilities below are the union of what the staged Alchemy commands
  # call and what Nomad checks for those calls. Each line is justified by an API
  # call in tools/alchemy/src/Nomad.ts; nomad-acl-operations.md lists the
  # mapping.
  controllerPolicy = ''
    namespace "default" {
      capabilities = [
        "list-jobs",
        "read-job",
        "submit-job",
        "read-logs",
      ]
    }

    host_volume "noneuclid-data" {
      capabilities = ["mount-readwrite"]
    }

    host_volume "twitter-bookmarks-data" {
      capabilities = ["mount-readwrite"]
    }

    host_volume "postgres-data" {
      capabilities = ["mount-readwrite"]
    }

    host_volume "postgres-dev-data" {
      capabilities = ["mount-readwrite"]
    }

    host_volume "valkey-data" {
      capabilities = ["mount-readwrite"]
    }

    host_volume "traefik-routes" {
      capabilities = ["mount-readonly"]
    }

    host_volume "nix-store" {
      capabilities = ["mount-readonly"]
    }

    host_volume "openobserve-data" {
      capabilities = ["mount-readwrite"]
    }

    host_volume "traefik-acme" {
      capabilities = ["mount-readwrite"]
    }
  '';

  # Read-only token for the human operator: jobs, allocations, allocation logs,
  # nodes, and namespaces. No submit, dispatch, or alloc-exec.
  # Listing namespaces needs any capability on a namespace (Nomad
  # /v1/namespaces); list-jobs on default is enough for that.
  operatorPolicy = ''
    namespace "default" {
      capabilities = [
        "list-jobs",
        "read-job",
        "read-logs",
      ]
    }

    node {
      policy = "read"
    }
  '';

  # The ingress job (tools/alchemy/platform/ingress) reads Nomad services with its
  # workload identity. Listing services is implicit, but reading one service needs
  # read-job, which this job-associated policy grants.
  traefikPolicy = ''
    namespace "default" {
      capabilities = ["read-job"]
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

  # Applies the cluster state Nomad keeps in Raft rather than in its config files: the
  # ACL policies, and the scheduler algorithm (the server config's
  # default_scheduler_config is read only when a cluster is first created).
  applyCluster = pkgs.writeShellScriptBin "nomad-cluster-apply" ''
    set -euo pipefail
    bootstrap=${credentialDir}/bootstrap.token
    if [ ! -s "$bootstrap" ]; then
      echo "No bootstrap token at $bootstrap. Run nomad-acl-bootstrap first." >&2
      exit 1
    fi
    NOMAD_TOKEN=$(cat "$bootstrap")
    export NOMAD_TOKEN
    # A switch that changes Nomad restarts it at the same time as this unit; its API
    # answers some seconds later. A failed first attempt fails the whole switch.
    for _ in $(seq 60); do
      leader=$(nomad operator api -X GET /v1/status/leader 2>/dev/null) || leader=
      case $leader in *:*) break ;; esac
      sleep 1
    done
    nomad acl policy apply alchemy-controller ${pkgs.writeText "alchemy-controller-policy.hcl" controllerPolicy}
    nomad acl policy apply alchemy-operator ${pkgs.writeText "alchemy-operator-policy.hcl" operatorPolicy}
    # The ingress job reads single services, which needs read-job.
    nomad acl policy apply -namespace default -job traefik -group service -task server \
      traefik ${pkgs.writeText "traefik-policy.hcl" traefikPolicy}
    # spread places each allocation on the least-loaded node. A job with a host volume
    # still lands on the node that declares that volume.
    nomad operator scheduler set-config -scheduler-algorithm=spread
  '';

  # Issues a client token from the stored bootstrap token. The policy is
  # applied first, so the token and the policy never drift apart. The token
  # goes to <file>.token and an environment file holding NOMAD_TOKEN goes to
  # <file>.env.
  #
  # readerGroup: group-readable env file (0640) for the Alchemy runner.
  # readerUser: owner-only files (0400) for the human operator.
  # The credential directory (tmpfiles, 0711 root) lets each reader traverse to the
  # file it may read; every file carries its own owner and mode.
  # tokenName: the name `nomad acl token list` shows; the policy name unless set.
  issueScript = { command, policyName, file, tokenName ? policyName, readerGroup ? null, readerUser ? null }:
    pkgs.writeShellScriptBin command (''
      set -euo pipefail

      dir=${credentialDir}
      bootstrap="$dir/bootstrap.token"
      token="$dir/${file}.token"
      env_file="$dir/${file}.env"
      name=${tokenName}
      policy=${policyName}

      if [ ! -s "$bootstrap" ]; then
        echo "No bootstrap token at $bootstrap." >&2
        echo "Run nomad-acl-bootstrap first." >&2
        exit 1
      fi

      umask 077
      tmp=$(mktemp "$dir/${file}.XXXXXXXX")
      trap 'rm -f "$tmp"' EXIT

      NOMAD_TOKEN=$(cat "$bootstrap")
      export NOMAD_TOKEN

      ${applyCluster}/bin/nomad-cluster-apply > /dev/null
      nomad acl token create \
        -name="$name" \
        -type=client \
        -policy="$policy" \
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
      chmod 0600 "$env_file"
      echo "Token stored in $token"
    '' + lib.optionalString (readerGroup != null) ''
      if getent group ${readerGroup} > /dev/null; then
        chown root:${readerGroup} "$env_file"
        chmod 0640 "$env_file"
        echo "Environment file $env_file is readable by the ${readerGroup} group"
      else
        echo "Environment file $env_file is readable by root only." >&2
        echo "The ${readerGroup} account cannot read it until that account exists." >&2
      fi
    '' + lib.optionalString (readerUser != null) ''
      if getent passwd ${readerUser} > /dev/null; then
        chown ${readerUser} "$token" "$env_file"
        chmod 0400 "$token" "$env_file"
        echo "Token files are readable only by ${readerUser} (0400)"
      else
        echo "User ${readerUser} does not exist; token files stay root-only." >&2
      fi
    '' + ''
      echo "Revoke the token this one replaces with nomad acl token delete <accessor-id>."
    '');

  issueController = issueScript {
    command = "nomad-acl-issue-controller";
    policyName = "alchemy-controller";
    file = "controller";
    readerGroup = "alchemy";
  };

  issueOperator = issueScript {
    command = "nomad-acl-issue-operator";
    policyName = "alchemy-operator";
    file = "operator";
    readerUser = operatorName;
  };

  # The fleet service (alchemy-fleet, as the runner user) reads what the operator
  # reads, with a token of its own so either can be revoked alone.
  issueFleet = issueScript {
    command = "nomad-acl-issue-fleet";
    tokenName = "alchemy-fleet";
    policyName = "alchemy-operator";
    file = "fleet";
    readerUser = "alchemy";
  };
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

  # The credential directory holds tokens. It is created at boot, owned by
  # root, and holds nothing until an operator issues a token. Mode 0711 lets
  # the operator traverse to operator.env without listing the directory; the
  # alchemy group still reaches controller.env the same way.
  systemd.tmpfiles.rules = [
    "d ${credentialDir} 0711 root root -"
  ];

  # Restart Nomad when the ACL configuration changes. The guard keeps this
  # module safe to import on its own: without the base Nomad configuration
  # there is no Nomad service to restart.
  systemd.services = lib.mkIf (config.environment.etc ? "nomad.d/nomad.hcl") {
    nomad.restartTriggers = [ config.environment.etc."nomad.d/acl.hcl".source ];

    # Policies and the scheduler setting live in Nomad's Raft state, not its config
    # files, so a rebuild would otherwise leave Nomad on the old ones. A new script
    # (any change to a policy changes its store path) restarts this unit on switch.
    # It is skipped until the operator bootstraps ACLs, and retries while a fresh Nomad
    # starts.
    nomad-cluster-apply = {
      description = "Apply Nomad ACL policies and scheduler settings";
      after = [ "nomad.service" ];
      requires = [ "nomad.service" ];
      wantedBy = [ "multi-user.target" ];
      path = [ (pkgs.callPackage ../modules/nomad-package.nix { }) ];
      restartTriggers = [ applyCluster ];
      unitConfig.ConditionPathExists = "${credentialDir}/bootstrap.token";
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${applyCluster}/bin/nomad-cluster-apply";
        Restart = "on-failure";
        RestartSec = 5;
      };
    };
  };

  environment.systemPackages = [
    bootstrapScript
    applyCluster
    issueController
    issueOperator
    issueFleet
  ];
}
