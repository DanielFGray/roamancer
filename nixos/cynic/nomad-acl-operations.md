# Nomad ACL operations on cynic

## What this covers

The Nomad listeners on cynic are bound to loopback. Loopback is not an identity:
any local process that can reach the host loopback can call the Nomad API, and
the Nomad API can schedule jobs and bind host volumes. This document covers the
ACL configuration that turns loopback access into an authenticated action, and
the operator steps that create and recover the credentials.

The ACL system is not bootstrapped automatically. A bootstrap that runs by
itself can lose the only management token without anyone noticing. The
operator runs it once, by hand.

## Files

| Path | Owner | Holds |
| --- | --- | --- |
| `nixos/cynic/nomad-acl.nix` | this slice | the module |
| `/etc/nomad.d/acl.hcl` | Nix | the ACL block |
| `/nix/store/...-alchemy-controller-policy.hcl` | Nix | the controller policy, applied by `nomad-cluster-apply` |
| `/nix/store/...-traefik-policy.hcl` | Nix | the Traefik policy and workload association, applied by `nomad-cluster-apply` |
| `/var/lib/nomad-acl/` | runtime | mode 0710 root:alchemy when that group exists; otherwise 0700 root:root |

The Nix store holds the policies and the operator scripts. No token is written to
the store, to source control, to a log, or to Alchemy resource state.

## How the configuration composes

Nomad reads every `.hcl` file in its configuration directory and merges them.
In Nomad 2.0.7 that happens in `command/agent/config.go`: `LoadConfigDir`
sorts the file names and `Config.Merge` merges the blocks. The `acl` block is
merged field by field, so `acl { enabled = true }` in its own file adds ACL
enforcement without touching the `server`, `client`, or `plugin` blocks in
`nomad.hcl`.

The agent log records the merge:

```
==> Loaded configuration from /etc/nomad.d/acl.hcl, /etc/nomad.d/nomad.hcl
```

The policy file cannot live in `/etc/nomad.d`. The agent would read it as
agent configuration and refuse to start.

## Bootstrap, once

ACL enforcement is on as soon as the module is deployed, and the API answers
`403 Permission denied` to every caller that has no token. Until the operator
bootstraps, no one can do anything with the API.

```sh
sudo nomad-acl-bootstrap
```

The script:

1. stops without touching anything when `/var/lib/nomad-acl/bootstrap.token`
   already exists;
2. runs `nomad acl bootstrap` and writes the secret straight to that file with
   mode 0600, so the token never reaches a terminal or a log;
3. stops without writing a file when the bootstrap fails.

Nomad allows one bootstrap. A second attempt fails with
`ACL bootstrap already done (reset index: N)`. That message means the ACL
system holds tokens, not that the run failed. See *Recovery* below.

The token in that file is a management token. It is the operator credential:
use it for `nomad status` and for issuing other tokens, and keep it out of
shell history.

```sh
sudo sh -c 'export NOMAD_TOKEN="$(cat /var/lib/nomad-acl/bootstrap.token)"; exec nomad status'
```

## Refresh policies and scheduler settings without rotating credentials

Every switch that changes them runs the `nomad-cluster-apply` unit, which applies
them with the stored management credential; check it with
`systemctl status nomad-cluster-apply`. To apply them by hand, run:

```sh
sudo nomad-cluster-apply
```

This uses the stored management credential to refresh both declared policies
and to set the scheduler algorithm to `spread`, which places each allocation on
the least-loaded node.
It creates no token and leaves existing token files unchanged. It associates
the Traefik policy with Nomad job `traefik`, group `service`, task `server`:
the ingress job in `tools/alchemy/platform/ingress`, which reads services with
its default workload identity. The token-issuance command also runs this policy
refresh before creating its token.

## The staged Alchemy token

The staged Alchemy commands do not use the management token. They get a client
token bound to one policy. The policy, the token, and the files below keep the
name `controller`: that name is live state on this host. Renaming them is a
separate operator step; it is tracked as follow-up work.

```sh
sudo nomad-acl-issue-controller
```

The script applies the policy, creates a client token named
`alchemy-controller`, and writes:

- `/var/lib/nomad-acl/controller.token`, mode 0600, the token itself;
- `/var/lib/nomad-acl/controller.env`, mode 0640 group `alchemy` when that
  group exists, holding `NOMAD_TOKEN=<secret>` for the runner.

The script prints which of the two it wrote. When the `alchemy` group does not
exist yet, the environment file stays root-only and the script says so.

After the rebuild that creates the `alchemy` group, run
`sudo nomad-acl-issue-controller` once more so the credential directory and
`controller.env` take the group; the runner then reads the env file without
sudo.

The token has no expiry. It can be revoked at any time with
`nomad acl token delete <accessor-id>`.

## The Traefik policy

The ingress job reads Nomad services to build its routes. Its workload identity
can list services implicitly; reading one service needs `read-job`, which the
job-associated `traefik` policy grants in the `default` namespace, and nothing
else. The job needs no token file.

## What the controller policy allows

Every capability below is required by a call that `tools/alchemy/src/Nomad.ts`
makes. The Nomad 2.0.7 source line that checks the capability is named for
each one.

| Alchemy call | Capability | Nomad check |
| --- | --- | --- |
| `GET /v1/jobs?meta=true` | `list-jobs` | `nomad/job_endpoint.go:1417` |
| `GET /v1/job/:id` | `read-job` | `nomad/job_endpoint.go:1202` |
| `GET /v1/job/:id/deployment` | `read-job` | `nomad/deployment_endpoint.go:48` |
| `GET /v1/service/:name` | `read-job` | `nomad/service_registration_endpoint.go:364` |
| `GET /v1/allocation/:id` | `read-job` | `nomad/alloc_endpoint.go:143` |
| `POST /v1/job/:id/plan` | `submit-job` | `nomad/job_endpoint.go:1794` |
| `POST /v1/jobs` | `submit-job` | `nomad/job_endpoint.go:154` |
| `DELETE /v1/job/:id?purge=true` | `submit-job` | `nomad/job_endpoint.go:798` |
| `GET /v1/job/:id/allocations` | `read-job` | `nomad/job_endpoint.go:1514` |
| `GET /v1/client/fs/logs/:alloc` | `read-logs` | `client/fs_endpoint.go:385` |
| `GET /v1/allocations?resources=true` | `read-job` | not traced |
| `GET /v1/job/:id/evaluations` | `read-job` | not traced |
| `GET /v1/nodes?resources=true` | `node` `read` | not traced |
| `GET /v1/client/stats?node_id=` | `node` `read` | not traced |
| job with a `host` volume | `mount-readwrite` on that volume | `nomad/job_endpoint.go:168` |

The policy grants nothing else. The token can read nodes for `ops dash`, but
cannot drain or change them. It cannot read operator state, cannot read
allocations of other namespaces, and cannot reach the `default` namespace
outside the three job capabilities.

The `host_volume` rules are not decoration. A token with the namespace
capabilities but without them is refused when it registers a job that mounts a
host volume:

```
Permission denied
```

## Delivering the token to the runner

The Alchemy host program (`alchemy-runner` → `tools/alchemy/src/cli.ts`) reads
`NOMAD_TOKEN` from `/var/lib/nomad-acl/controller.env` when a command needs Nomad
(`tools/alchemy/src/NomadConfig.ts`). The file must be readable by the `alchemy`
group; `nomad-acl-issue-controller` sets that mode when the group exists. The
root flake enables the runner module on the control host.

## Recovery

**The staged Alchemy token is lost.** Run `nomad-acl-issue-controller` again. It
applies the policy and writes a new token. Revoke the old one:

```sh
sudo sh -c 'export NOMAD_TOKEN="$(cat /var/lib/nomad-acl/bootstrap.token)"; exec nomad acl token list'
sudo sh -c 'export NOMAD_TOKEN="$(cat /var/lib/nomad-acl/bootstrap.token)"; exec nomad acl token delete <accessor-id>'
```

**The bootstrap token is lost.** Nomad keeps a reset index for the bootstrap
token. Ask for it:

```sh
sudo nomad acl bootstrap > /dev/null
```

The failure message carries the index: `ACL bootstrap already done (reset
index: 42)`. The server reads that index from a file in its own data
directory, which on this host is `/var/lib/nomad/server`. Write the number
there, then bootstrap again and store the secret without printing it:

```sh
sudo sh -c 'echo 42 > /var/lib/nomad/server/acl-bootstrap-reset'
sudo nomad-acl-bootstrap
```

The new token can reuse the old secret. `nomad acl bootstrap -` reads a token
from standard input, and the token must be a UUID:

```sh
sudo sh -c 'printf %s "<old-uuid>" | nomad acl bootstrap -t "{{ .SecretID }}" - > /var/lib/nomad-acl/bootstrap.token'
sudo chmod 0600 /var/lib/nomad-acl/bootstrap.token
```

The reset index changes with every bootstrap. Delete the reset file once the
bootstrap succeeded, or a later attempt fails with `Invalid bootstrap reset
index`. The file holds the new management token either way. Check that the
file exists and is not empty before you rely on it.

**The ACL state is already bootstrapped and the token file is gone.** Do not
delete the Nomad data directory and do not try to bootstrap again from
scratch. Use the reset index above. Re-bootstrapping adds a second management
token; it does not remove the first one.

## Checks to run after deployment

Run these on the host as the operator. The checks need a job body with one
task group:

```json
{"Job":{"ID":"acl-probe","Name":"acl-probe","Type":"service","Datacenters":["dc1"],"TaskGroups":[{"Name":"g","Count":1,"Tasks":[{"Name":"t","Driver":"raw_exec","Config":{"command":"/bin/true"}}]}]}}
```

Save it as `job.json` in a scratch directory. The probe job asks for the
raw_exec driver, which this node disables, so the job stays pending and
nothing runs. Registering the job is what the checks exercise.

**Unauthenticated callers are refused.**

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4646/v1/jobs \
  --data-binary @job.json
```

Expect `403`. The response body is `Permission denied`.

**The `alchemy-controller` token may submit.**

```sh
sudo sh -c 'printf "header = \"X-Nomad-Token: %s\"\n" "$(cat /var/lib/nomad-acl/controller.token)" | curl --config - -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:4646/v1/jobs --data-binary @job.json'
```

Expect `200`. A job body needs at least one task group; the API rejects an
empty one with `500 Missing job task groups` before it checks the token, so a
`500` there proves nothing about the ACL.

**The token is still narrow.**

```sh
sudo sh -c 'export NOMAD_TOKEN="$(cat /var/lib/nomad-acl/controller.token)"; exec nomad node status'
```

Expect `403 Permission denied`. The token has no node access.

**A restart keeps enforcement.** Restart Nomad, then repeat the anonymous
call. Expect `403` again. The tokens live in files under `/var/lib/nomad-acl`
and in the Nomad state store, so they survive a restart.

**The token still works after the restart.** Repeat the authorized
submission. Expect `200`.

**Recovery works.** Follow *Recovery* above with a scratch token and confirm
that the runner can authenticate afterwards.

## Known limits

- **Node registration is not covered by ACLs.** The client registers on the
  RPC port with a node identity, and the default introduction enforcement is
  `warn`, so a registration without an introduction token is logged and
  allowed. A local process that can reach the RPC port can register a node.
  Setting `server { client_introduction { enforcement = "strict" } }` closes
  that path, and the client then needs an introduction token
  (`nomad node intro create`, delivered through
  `/var/lib/nomad/client/intro_token.jwt`). That is a separate change with
  its own first-start behaviour, so it is not part of this slice.
- **RPC and gossip are still unauthenticated.** The control listeners are
  loopback-only and SSH is the operator transport. mTLS and gossip protection
  have to be settled before another node joins or a private control-plane
  listener is exposed.
- **ACL permission for allocation checks still needs live confirmation.** The
  Alchemy client now calls `/v1/client/allocation/:id/checks`
  (`api/allocations.go:134`). Nomad 2.0.7 also accepts
  `/v1/allocation/:id/checks`; both paths call the same handler in
  `command/agent/alloc_endpoint.go`. Verify the `alchemy-controller` policy permits this request
  during the authenticated host check.
