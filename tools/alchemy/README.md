# Alchemy deployment trial

This package deploys app cartridges and shared platform services through Alchemy and Nomad. NixOS owns hosts, rootless Podman, and host volumes. Recorded proofs cover Noneuclid on a disposable VM and shared PostgreSQL and Valkey on cynic.

## Operator commands

`scripts/ops` runs every operator command on the control host from your machine. The control host runs the Nomad server, OpenBao and the Alchemy state; it is `cynic.dlab` unless `OPS_HOST` names another. `ops` syncs this folder to `~/alchemy` there, then runs `scripts/ops-on-host.sh` over SSH. The sync leaves the host's Alchemy state and `node_modules` alone. Put `scripts` on your `PATH`, or alias it:

```sh
ops login                                  # once every 2 hours: mints an OpenBao token from the root token
ops plan --stage giglist                   # Alchemy plan; `ops deploy --stage giglist` applies it
ops logs giglist-worker                    # a Nomad job's recent output, or its task events when it is not running; --tail follows
ops secret list giglist                    # each referenced key: set, MISSING, or unused; never values
ops secret check giglist                   # fails when a referenced key is unset; plan and deploy run it first
ops secret set giglist github_client_secret  # prompts for the value
ops status giglist                         # each service's newest allocations
ops release giglist ~/build/setlist         # build, push, pin and deploy the app's current commit
```

`plan`, `deploy`, `destroy`, `state` and `drift` are Alchemy's own commands. Before `plan` and `deploy` the runner runs `ops secret check <stage>`, which fails when a secret the cartridge references is unset (a task would otherwise wait on its template until the deploy times out) or the OpenBao token has expired. Before `destroy` and `drift` it checks the token only. The stage is a cartridge's `name`: the stack finds that cartridge under `apps/*/` or `platform/*/`. The other commands are `src/cli.ts`, for what Alchemy has no place for. `ops logs` reads Nomad by job name, which is the resource's name, so it needs no stage and works for a job whose first deploy failed and left no Alchemy state. It prints stdout and stderr of each running task in the newest running allocation, with the time podman recorded for each line (`src/TaskLog.ts`, which also serves `alchemy logs`).

`release` runs on your machine, not the control host, because your Docker holds the registry's client certificate (`nixos/cynic/cluster-tls-operations.md`). It refuses a build folder with uncommitted changes, since the image is tagged with the commit. It builds and pushes the image, writes the pushed digest into every service of the cartridge that uses that image, runs `ops deploy`, and commits the cartridge. A cartridge that names more than one image, such as `platform-data`, is refused. To roll back, put the old digest back in the cartridge and run `ops deploy`; migrations stay applied (see `nixos/backup-operations.md` for restoring data).

`secret set` accepts only a key that the cartridge references with a `KvSecret`, at that reference's path, so a misspelled key fails before anything is stored. It keeps the other keys at that path. Nomad restarts a running task when a value it reads changes. The runner reads the Nomad token from `/var/lib/nomad-acl/controller.env`, so no command needs sudo.

## Plan and deploy

A cartridge is a versioned JSON file that describes services and their data needs. The platform orders jobs by their dependencies. Each cartridge lives in this package at `apps/<name>/cartridge.json` or `platform/<name>/cartridge.json`, and the stage selects it by its `name`. Connect to the target Nomad API before planning or deploying. This example assumes a local API or an SSH forward on port `4646`:

```sh
export NOMAD_ADDR=http://127.0.0.1:4646
cd tools/alchemy
bun run plan --stage noneuclid
bun run deploy --stage noneuclid
```

`NOMAD_TOKEN` is optional only on an ACL-free testground. State is local and separated by stage. Use the same control machine and state directory for later plans. `bun run destroy --stage noneuclid` removes that cartridge's managed resources, not the Nix host volume. Use `--stage platform-data` for the shared server cartridge.

The Nomad provider records reconcile and delete operations in `.alchemy/operations.sqlite`. If a process stops after an operation starts but before it records the result, the next plan detects that pending operation and reconciles the resource against live Nomad state. Inspect the history with `bun run history`. Keep the journal and Alchemy state under `.alchemy` together. This is local operation history, not shared state or a backup. The staged plan, deploy, and destroy commands use `staged-host-runner.sh`, which snapshots input and serializes applies through one lock. The NixOS module gives the operator command the `/var/lib/alchemy` state directory.

The platform reads the versioned cartridge and checks its API version and job fields against the supported schema, then translates each service declaration into a Nomad job. The initial bridge-network update produced job version 2. In that proof, a cartridge update and restoration left job version 4 healthy, HTTP returned 200, and the final Alchemy plan reported no changes. These are saved results, not a current VM status check.

Each service contains its image, published and container ports, optional persistent volume name and mount path, optional health check, CPU and memory, explicit network mode, environment, service connections, and OpenBao secret references. Nix must declare the requested host volume. The image must already be available to Nomad. Keep the CLI working directory at `tools/alchemy` so local Alchemy state stays in the same location.

## Update rollout proof

On the disposable `rootless-nomad` VM, changing the cartridge CPU reservation from 2000 to 2001 caused Alchemy to update the existing job. The update completed and Nomad reported a healthy allocation. HTTP probes at about 250 ms intervals recorded 22 consecutive failures in a 5.7 second window. Restoring the original cartridge completed a second update and returned the job to CPU 2000; the final plan reported no changes.

The job has one allocation and reserves fixed host port 18518. Nomad's history shows the old allocation stopping before the replacement starts. The HTTP interruption occurred during this replacement. This is consistent with a stop-before-start rollout on one fixed port, though the probe did not isolate the port as the only cause. Most samples returned HTTP 200; the 23.1 second Alchemy operation was not a 23.1 second outage. A stable endpoint with health-checked traffic cutover is still needed for practical zero-downtime updates.

The probes checked HTTP from the workstation. They did not exercise game input, active user sessions, app writes, or database contents. The SQLite file remained mounted and existed afterward, but its bytes were not compared. The test did not force a failed deployment, so Nomad's automatic revert behavior remains unproven.

For later rollout checks, run `bash scripts/probe-http-rollout.sh URL [INTERVAL_SECONDS] [REQUEST_TIMEOUT_SECONDS] [DURATION_SECONDS]` from `tools/alchemy`. Start it before the deploy command. Keep it running until Nomad reports the new allocation healthy, and choose a duration that covers the full deploy. It prints the HTTP status, curl exit code, response time, and gap from the previous sample in separate columns. A failed request means curl exited non-zero or the HTTP status was not 200. Summarize samples with `bash scripts/probe-http-rollout.sh --summarize SAMPLE_FILE [MAX_SAMPLE_GAP_MS [WINDOW_START_UTC WINDOW_END_UTC]]`. The summary reports the first and last sample timestamps, failed samples, the longest failure run, and the largest sample gap. Add the expected rollout window bounds to get `INCONCLUSIVE` if the samples do not cover that whole interval. Without bounds, it returns `PASS` only when every request succeeds and the largest gap is at most 500 ms, `FAIL` if any request fails, or `INCONCLUSIVE` if there are no samples, the file format is invalid, or there are no failed requests but the gap is larger than the limit. Save the deploy start and end times with the sample file; the summary cannot infer which deploy a probe covered.

Noneuclid stores editable levels in one SQLite file on the shared host volume. Do not start two versions against that writable file until a single-writer handoff is designed and tested. A dynamic port alone does not make overlapping versions safe.

## Staged release proof

`staged.run.ts` declares one `Nomad.ReleaseSet` from a JSON manifest. Each release uses a separate Nomad job with a dynamic host port. Routes are Traefik tags on each release job's Nomad service: the selected release carries the stable host and the candidate carries the preview host. Other releases carry no tags. Traefik reads the tags from Nomad, so a moved allocation keeps its route without an Alchemy run. See `platform/ingress/README.md`. Promotion and rollback change the selected release in the manifest. Keep the previous release in `releases` to keep it available for rollback.

A successful staged deploy records the exact applied manifest at `.alchemy/staged-active.json`, so edits to the working manifest do not cause an automatic promotion. A failed deploy attempts to re-apply the accepted manifest and then returns the original failure. No controller re-applies it automatically at boot.

`nixos/modules/alchemy-staged.nix` defines the restricted sudo command for the staged runner. Nix packages the Bun runtime, Alchemy source, production dependency closure, and runner commands. Operators send manifest bytes over SSH:

```sh
cat releases/candidate.json | ssh operator@host sudo -n -u alchemy -- alchemy-staged plan
cat releases/candidate.json | ssh operator@host sudo -n -u alchemy -- alchemy-staged deploy --yes
```

The SSH account must belong to a group listed in `services.alchemyStaged.operatorGroups` (the default is `wheel`). The module does not create an SSH account or install an SSH key.

The Nix production lock is `bun-production.lock`; regenerate it and `bun.nix` with `bun run nix:deps`. Bun 1.4 reads the version 1 lock used here, while the pinned `bun2nix` converter currently rejects Bun's version 2 format. A failed explicit deploy keeps the old accepted manifest and attempts to restore it. If the host restarts after provider changes but before acceptance, the old accepted manifest remains authoritative.

The pinned runtime package now has a fresh disposable-VM proof; see [Current limits](#current-limits). Remote SSH apply and lock contention remain unverified.

This proof uses stateless `whoami` containers. It does not support shared writable volumes, public preview DNS, TLS, A/B traffic splitting, or placing releases on different nodes. The sample `*.localhost` hosts are for local routing checks; a phone cannot reach them. Do not use this flow for Noneuclid while two releases would share its writable SQLite file. Resource settings such as CPU, memory, and health checks apply to every declared release; changing them can update and restart the selected release's job. Keep them fixed during a staged image rollout until job configuration is versioned per release.

The workstation setup uses an SSH port forward to Nomad's loopback API and a Nomad token from the host (see `nixos/cynic/nomad-acl-operations.md`):

```sh
ssh -N -L 14646:127.0.0.1:4646 cynic.dlab &
export NOMAD_ADDR=http://127.0.0.1:14646
```

Keep the SSH tunnel open while planning and deploying. From `tools/alchemy`, start with the live-only manifest:

```sh
export ALCHEMY_RELEASE_SET=examples/staged-probe/live.json
bun run staged:plan
bun run staged:deploy --yes
```

Then use these manifests in order:

1. `candidate.json` keeps v1 selected and adds v2 as the candidate. Open `http://v2.probe.localhost` to inspect the candidate.
2. `promoted.json` selects v2 and clears the candidate. The stable host becomes v2.
3. `rollback.json` selects v1 again. The stable host returns to v1.
4. `single-live.json` removes v2 from desired state and cleans up its job and preview route.

For each change, set `ALCHEMY_RELEASE_SET` to the chosen manifest, run `bun run staged:plan`, then `bun run staged:deploy --yes`. Alchemy local state and the operation journal are stored under `tools/alchemy/.alchemy` in the workstation trial; the NixOS host uses `/var/lib/alchemy/.alchemy`. Back them up together. `ReleaseSet.read` adopts a set when every declared release has exactly one matching owned Nomad job; reconcile then removes extra owned release jobs. On 2026-10-20, a fresh disposable VM ran v1 plus v2 as the candidate. After backing up and moving Alchemy's local state aside while leaving Nomad and Caddy running, a fresh plan adopted the ReleaseSet. Both hosts returned HTTP 200 with the expected `X-Alchemy-Release` headers, Nomad still had exactly one running job per release, and the final plan reported no changes. That proof used the earlier Caddy admin-API routes.

The provider requires the matching allocation to be running, its Nomad deployment health to be successful, and its service health checks to pass. Nomad garbage-collects finished deployments, so a plan reads allocation health, not the deployment record. The host runner is declared in the NixOS module and passed the disposable-VM proof described below.

On 2026-10-21 the same manifests ran on cynic with Traefik routes. Promotion and rollback served every request with HTTP 200 and restarted no allocation. Stopping the selected allocation gave about 5 s of 404 and one 502, then HTTP 200 from the replacement, with no Alchemy run; the next plan reported no changes.

Before that, a disposable VM used Caddy admin-API routes. It returned HTTP 200 with `X-Alchemy-Release: v1` on the stable host, then returned v2 at the preview host while stable traffic remained on v1. Promotion changed the stable header to v2. Rollback changed it to v1. Cleanup removed the v2 job and preview route, and the final plan had no changes. The stable route survived a Caddy restart, and a new Alchemy plan reported no changes. A manual Caddyfile reload removed the route; Alchemy detected and restored it. An allocation reschedule changed its dynamic port; the route returned HTTP 502 until an Alchemy deploy reconciled it. An earlier generated image needed ext4 repair on its disposable overlay; the later fresh-image proof is recorded under [Current limits](#current-limits).

## Composed services and OpenBao secrets

The cartridge declares an `apiVersion: "server-ansible/v2"` document with `name`, optional `servers`, `postgres`, `valkey`, and a `services` array. Each service becomes its own Alchemy-managed job. Services can refer to other services in the cartridge by job name, in any declaration order. `Cartridge.ts` uses `effect/Graph` to place providers before consumers; the schema rejects duplicate names, undeclared connections, and dependency cycles. PostgreSQL database and Valkey access resources are derived from `postgres` and `valkey`; their outputs supply credential paths to dependent jobs. A cartridge either provides servers or requests PostgreSQL and Valkey access. Shared-server dependencies across cartridges are not part of this graph. Network mode is explicit per service. Ports can be fixed or dynamic, and each service can use an HTTP or TCP health check.

Use `secrets` on each service to request runtime credentials. Each job's OpenBao role is derived as `alchemy-<job name>`; no role field is declared by hand. A secret reference names either an OpenBao KV-v2 path and key or a declared PostgreSQL or Valkey need, plus destination environment-variable names. Nomad authenticates its workload identity to OpenBao and renders the secret into the task environment. Secret values are not inputs to Alchemy and are not included in its state or operation journal. `NomadJob.ts` writes the OpenBao ACL policy and the job-bound JWT role on reconcile; configure Nomad's Vault-compatible integration and OpenBao JWT auth endpoint separately. Do not put secret values in the cartridge's ordinary `environment` entries.

On 2026-10-20, a fresh disposable VM ran an Alchemy-managed PostgreSQL job and a dependent client job. Nomad obtained both jobs' credentials from OpenBao through job-bound JWT roles. The client discovered PostgreSQL's dynamic endpoint through the generated Nomad service template and successfully queried the database. Both Alchemy resources reached healthy status. A check of the Alchemy state and operation journal found no copy of the test password. The proof used a disposable PostgreSQL role and database, not shared production data. Its saved input and limits are in [`../../.audit/alchemy-postgres-openbao-proof.txt`](../../.audit/alchemy-postgres-openbao-proof.txt).

This proves ordered multi-job deployment, runtime secret delivery, and an authenticated query on one disposable node. The v2 platform provides a shared PostgreSQL server and database provider; idempotent app-role provisioning is handled by the OpenBao database plugin. The proof configured its test secret, OpenBao policy, and job-bound roles directly. It did not test persistent database data, replacement recovery, multiple nodes, or private cross-node routing. Do not use the proof's broad test policy or root token pattern in a deployment.

### Shared Valkey service and app access

In v2 a platform cartridge (see `platform/data/cartridge.json`) declares the shared servers once. An app cartridge declares what it needs with `postgres` and `valkey`; the platform derives every role name, login name, key prefix, secret path, and OpenBao role from the app name. `platform/data` provides `PostgresServer "postgres"` and `ValkeyServer "valkey"`; each generates its own admin password through `AdminCredential`.

The Valkey server job uses an ACL file on persistent storage and initialises it on first boot so the default user is never passwordless:

```json
{
  "_tag": "ValkeyServer",
  "service": {
    "name": "valkey",
    "image": "docker.io/valkey/valkey:8.1.3",
    "hostPort": "dynamic",
    "containerPort": 6379,
    "cpu": 500,
    "memoryMB": 512,
    "networkMode": "bridge",
    "storage": { "volume": "valkey-data", "mountPath": "/data" },
    "environment": [],
    "command": "sh",
    "args": [
      "-ec",
      "if [ ! -s /data/users.acl ]; then printf 'user default on >%s ~* &* +@all\\n' \"$VALKEY_ADMIN_PASSWORD\" > /data/users.acl; fi; exec valkey-server --appendonly yes --aclfile /data/users.acl"
    ],
    "connections": [],
    "healthCheck": { "type": "tcp" },
    "secrets": []
  }
}
```

An app declares its needs and refers to them in secrets, without `connections` to the shared servers and without any role name, secret path, TTL, admin user, or vault role:

```json
{
  "apiVersion": "server-ansible/v2",
  "name": "app-needs",
  "postgres": [{ "database": "app_needs" }],
  "valkey": {},
  "services": [
    {
      "name": "app-needs",
      "image": "example/app-needs:latest",
      "hostPort": "dynamic",
      "containerPort": 8080,
      "cpu": 200,
      "memoryMB": 256,
      "networkMode": "bridge",
      "environment": [],
      "connections": [],
      "secrets": [
        {
          "_tag": "PostgresCredentials",
          "database": "app_needs",
          "login": "api",
          "usernameEnv": "PGUSER",
          "passwordEnv": "PGPASSWORD",
          "urlEnv": "DATABASE_URL"
        },
        {
          "_tag": "ValkeyCredentials",
          "usernameEnv": "VALKEY_USER",
          "passwordEnv": "VALKEY_PASSWORD",
          "urlEnv": "VALKEY_URL"
        }
      ]
    }
  ]
}
```

The platform creates a `ValkeyAccess` for the app and an ACL user whose key prefix is the app name. `ValkeyCredentials` carries the access name (`app_needs`); composition fills the credential path from the access resource Output, which is also the Alchemy dependency edge. PostgreSQL database roles use the same output-to-job pattern. The URL templates resolve the server host and port through `nomadService`, so apps do not list platform servers in `connections`. Do not use logical database numbers as an isolation boundary.

### PostgreSQL extensions and logins

A `postgres` entry can list the extensions its app needs, for example `{ "database": "app_needs", "extensions": ["pgtap", "vector"] }`. Before any migration runs, the provider connects to the app's database as the server admin, a superuser, and runs `CREATE EXTENSION IF NOT EXISTS` for each one. Untrusted extensions work the same way, so apps do not create extensions in their migrations. The provider checks every name against `pg_available_extensions` first. If any extension is missing from the server image, it creates none and fails with an error that names the missing ones.

The shared server runs the image that `nixos/cynic/postgres-image.nix` builds. That file lists the extensions the platform supports. To support a new one, add it there, then rebuild the image, push it to cynic's registry (`registry.cluster:5000`; the workstation's setup is in `nixos/cynic/cluster-tls-operations.md`), and pin the new digest in `platform/data/cartridge.json`. An extension that nixpkgs lacks, such as `pg_hashids`, is a short Nix package in the same file. The image initializes data with the builtin `C.UTF-8` locale. That locale does not depend on glibc, so a nixpkgs update cannot change how stored text sorts. An app that needs human sort order names an ICU collation on the column or query.

Each release gets a new migration login, which starts every session as the database's owner role. The tables it creates therefore belong to the owner role, and later releases can alter them. The API login does not inherit the visitor role. It switches to that role with `SET ROLE`, so row-level security applies to its queries.

The database providers connect directly to the address that Nomad registers for each server, so Alchemy must run on the host. Run from a workstation, `Postgres.Database` fails with `connect to PostgreSQL`. See `docs/design/host-owned-staged-runner.md`.

Destroying a `ValkeyAccess` revokes and persists the ACL user. Its OpenBao KV value is retained so a later recreation can reuse the credential. The server admin value is also retained when the Nomad job is destroyed. Remove these KV values through the OpenBao lifecycle when they are no longer needed.

On 2026-10-21, Alchemy deployed the `platform-data` cartridge on cynic. PostgreSQL and Valkey accepted their generated admin credentials and rejected incorrect credentials. Valkey also rejected unauthenticated commands. After Nomad replaced both containers, PostgreSQL retained its initialized data directory and Valkey retained its default ACL user. A scan found neither admin password in Alchemy state or the operation journal. The final plan reported no changes. See [the platform-data proof](../../.audit/cynic-platform-data-proof.txt). This did not deploy an app database or app-scoped Valkey access, test application writes, or prove backup and restore.

The ACL behavior was checked separately on a disposable Valkey 8 container. An app user could write within its prefix; writes to another prefix and `FLUSHALL` were denied. A read-only user could read its prefix and could not write. `ACL SAVE` preserved the ACL across container replacement when the ACL file was on persistent storage. The Alchemy `ValkeyAccess` provider still needs an end-to-end app deployment proof. Valkey connections in this setup do not use TLS, so do not send credentials over untrusted networks or treat the disposable proof as production network validation.

## Service connections

The `NomadJob` resource can declare a connection to another Alchemy job. Use the provider resource ID so Alchemy creates the provider before the consumer:

```ts
connections: [
  {
    service: database.id,
    hostEnv: "DATABASE_HOST",
    portEnv: "DATABASE_PORT",
  },
];
```

Alchemy generates an embedded Nomad template that uses `nomadService`. Nomad renders the variables at task start and restarts the task when the rendered values change. The generated template looks up the Nomad service using the provider's job name.

A live probe on the fresh testground VM deployed provider and consumer jobs through Alchemy. Both Nomad deployments reached healthy status. The consumer received `PROBE_HOST=10.0.2.15` and `PROBE_PORT=24567`, then fetched the provider's Nginx page. Alchemy destroyed both jobs after the probe, and Nomad reported no remaining jobs. This verifies one-node provider ordering, template rendering, task environment delivery, and request reachability.

The platform composition step resolves service names within one cartridge. It does not yet load multiple app cartridges or build images. PostgreSQL has an initial database resource, but app-role provisioning and the complete service-to-application flow have not passed an Alchemy-managed disposable integration proof. The PostgreSQL database and Valkey access providers retry service discovery for about two minutes. This tolerates delayed registration; it does not order deployments across cartridge stages or prove that a registered server is ready. A cartridge `PostgresCredentials` secret with `urlEnv` renders a `postgresql://` URL from the dynamic credential and the server address. Its password is inserted without escaping, so the generated password must be URL-safe. A service may declare a `migrate` field with its own `command`, `args`, and `secrets`; Alchemy renders it as a Nomad prestart task in the same task group, so it runs to completion before the service starts and a failed migration keeps the service from starting. The migration task uses the service's image, network mode, and environment, and receives only its own secrets, normally the database's `migration` login, while the service receives only its own, normally the `api` login. For example, postgres.garden also expects root and shadow database URLs, and those need decisions before its deploy. Keep secret values out of Alchemy state.

The live discovery probe used two rootless allocations on the fresh VM. With the Podman driver's `pasta` mode, the client could not reach the server at the node address and published port. With `bridge` mode, Nomad's `nomadService` template provided the server address and port, and the client fetched the Nginx welcome page.

On 2026-10-20, a separate disposable VM probe ran PostgreSQL 16 in one rootless allocation and a `psql` client in another. The client discovered a dynamic endpoint through a Nomad service template and queried the database successfully. Stopping the database allocation caused Nomad to replace it; a new client allocation discovered the replacement and queried it successfully. This used PostgreSQL `trust` authentication for the disposable probe. It does not prove Alchemy database resources, generated roles, OpenBao secrets, persistent data, or multi-node routing. The job files and result are in [`../../.audit/postgres-rootless-service-proof.txt`](../../.audit/postgres-rootless-service-proof.txt).

This proves one-node reachability through a published host port. It does not prove private addressing between production nodes, health-filtered discovery, or multi-node placement. Nomad native service discovery supplies addresses through templates; it does not provide DNS. Production nodes need routable private addresses and firewall rules for published service ports.

The implementation follows the [Nomad Podman driver's network modes](https://github.com/hashicorp/nomad-driver-podman#task-configuration) and [Nomad native service discovery templates](https://developer.hashicorp.com/nomad/docs/job-declare/service-discovery).

## Verify the NixOS testground

A fresh VM booted from the current flake build reports NixOS 26.11, Nomad 2.0.7, rootless Podman 5.8.8, and `crun` from the Nix store. Its Nomad metrics endpoint responds with Prometheus data:

```sh
curl -fsS 'http://127.0.0.1:4647/v1/metrics?format=prometheus' \\
  | rg -i 'nomad_client_host_cpu|nomad_client_allocated_(cpu|memory)'
```

In the recorded proof, port `4647` forwarded to the fresh build and port `4646` to the earlier Noneuclid VM. These were separate disposable environments. Check the current VM and tunnel configuration before using those ports.

Nomad's node and allocation metrics are available for a scraper. The endpoint does not retain resource history. Add a metrics store and dashboard before using resource use to choose where to move apps.

## Platform observability

`platform/observability/cartridge.json` declares two Nomad jobs that the platform runs for every app:

- `openobserve` stores traces, logs and metrics. It uses the `openobserve-data` host volume and the `alchemy-openobserve` OpenBao role. Its root password comes from `secret/data/platform/openobserve`, key `root_password`.
- `otel-collector` runs on the host network and receives OTLP over HTTP on the node's LAN address, port 4318, OTLP/HTTP's standard port. It also scrapes Nomad's `/v1/metrics` endpoint and forwards everything to `openobserve`. It uses the `alchemy-otel-collector` role and the same password. Its config is the `OTEL_CONFIG` environment value, read with `--config=env:OTEL_CONFIG`.

Every Nomad task that Alchemy renders gets `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.containers.internal:4318`. Inside a rootless Podman container the node's LAN address is the container's own address, so only `host.containers.internal` reaches the collector on the host. The value stays the same when the collector restarts, and no task restarts with it. A task's own `environment` entry of the same name replaces it. An app exports a signal only when its cartridge also sets that signal's exporter, for example `OTEL_TRACES_EXPORTER=otlp` and `OTEL_LOGS_EXPORTER=otlp`.

Plan it in its own stage, named after the cartridge. The stage separates its resources from the platform-data and app resources in local state:

```sh
bun run plan --stage platform-observability
```

Before the first deploy, write the root password to OpenBao and configure the platform mounts and Nomad JWT authentication. `NomadJob` creates the job-bound roles and policies during reconciliation, so the Alchemy process needs permission to write them. Narrowing that permission remains security work.

Checked on the workstation with OpenObserve v1.1.2 and the collector v0.131.0 image. OpenObserve accepted OTLP traces, logs and metrics. The collector scraped a stand-in Nomad endpoint and sent an app-style trace through its OTLP receiver. Both reached OpenObserve and were queryable. The collector config validates. The loader now accepts either declaration order and places OpenObserve before its collector consumer.

Checked on cynic on 2026-10-23: giglist and noneuclid traces and logs reach OpenObserve through the collector. The Nomad scrape failed there for two reasons: Nomad served no Prometheus format until its `telemetry` block turned it on, and a bridge-network container cannot reach Nomad, which listens only on the host's loopback address (`host.containers.internal` reaches the host's other addresses only). The collector therefore runs on the host network, scrapes `127.0.0.1:4646`, and binds its OTLP receiver to `NOMAD_ADDR_service`, the node's LAN address and port 4318. Tasks reach that receiver through `host.containers.internal`; checked from a bridge container on 2026-10-23, where `10.13.37.196:4318` timed out. Not checked: the memory use of OpenObserve under real load.

## Current limits

The pinned runtime package and testground image build successfully. On 2026-10-20, a fresh disposable VM booted the host-owned staged controller, which this repository has since removed, deployed the sample ReleaseSet as the `alchemy` account, and reconciled both routes after reboot with a final plan reporting no changes. The controller retried while Nomad was starting and then reconciled; that verified recovery, not startup ordering. Since Traefik follows a moved allocation from its Nomad tags, no long-running watcher is needed. The package includes `util-linux` because the shared runner uses `flock`.

Alchemy supports dependency-ordered Nomad jobs, endpoint templates, health checks, OpenBao workload identity delivery, shared PostgreSQL and Valkey servers, app database and Valkey access resources, and per-service `migrate` prestart tasks. The shared servers passed the cynic proof above; app-scoped provisioning and migrations still need an end-to-end proof. The runner does not build or publish images or configure public TLS. Backup and restore, cross-node routing, state-preserving data rollback, and a production rebuild remain unproven.

On cynic, workload secrets rendered as environment variables worked in the platform-data proof. On 2026-10-22, replacing Nomad's `BindReadOnlyPaths` with a host-visible `/sbin/ip` symlink also restored file visibility. The live probe in `../../testground/probe-nomad-secrets.sh` verified that a bridge-network rootless Podman task reads a dummy template and that the host sees its secrets mount as tmpfs with swap disabled. The probe uses mode `0400` with ownership set to the host Nomad user (`1001`), which maps to container root. Choose ownership for the task's actual user when delivering files. This probe does not test OpenBao login. Keep secret files out of the on-disk task directory.

The testground host firewall is disabled. The VM's QEMU port forwards bind to workstation loopback for local testing. Do not reuse this host configuration for production.
