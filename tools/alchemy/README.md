# Alchemy deployment trial

This package deploys the Noneuclid app to a NixOS testground VM. Alchemy owns the Nomad job. NixOS owns the host, rootless Podman, and the `noneuclid-data` host volume. Nomad runs the container.

## Plan and deploy

The existing Noneuclid deployment runs on the earlier testground VM. Its Nomad API is forwarded to port `4646` on the workstation. A cartridge is a versioned JSON file that describes an ordered set of Nomad jobs. The app repository owns `deploy/cartridge.json`; set its path before planning or deploying:

```sh
export NOMAD_ADDR=http://127.0.0.1:4646
export ALCHEMY_CARTRIDGE=/path/to/noneuclid/deploy/cartridge.json
cd tools/alchemy
bun run plan
bun run deploy
```

`NOMAD_TOKEN` is optional on the ACL-free testground. Alchemy stores stage `trial` in local state. Use the same control machine and state directory for later plans. `bun run destroy` removes the Alchemy-owned Nomad job. It does not remove the Nix host volume.

The Nomad provider records reconcile and delete operations in `.alchemy/operations.sqlite`. If a process stops after an operation starts but before it records the result, the next plan detects that pending operation and reconciles the resource against live Nomad state. Inspect the history with `bun run history`. Keep the journal and Alchemy state under `.alchemy` together. This is local operation history, not shared state or a backup. The staged plan, deploy, destroy, and controller paths use `staged-host-runner.sh`, which snapshots input and serializes applies through one lock. The NixOS module gives the controller and operator command the same `/var/lib/alchemy` state directory.

The platform reads the versioned cartridge and checks its API version and job fields against the supported schema, then translates each service declaration into a Nomad job. The initial bridge-network update produced job version 2. After a cartridge update and restoration, the current job is healthy at version 4, the app returns HTTP 200, and the final Alchemy plan reports no changes.

Each service contains its image, published and container ports, optional persistent volume name and mount path, optional health check, CPU and memory, explicit network mode, environment, service connections, and OpenBao secret references. Nix must declare the requested host volume. The image must already be available to Nomad. Keep the CLI working directory at `tools/alchemy` so local Alchemy state stays in the same location.

## Update rollout proof

On the disposable `rootless-nomad` VM, changing the cartridge CPU reservation from 2000 to 2001 caused Alchemy to update the existing job. The update completed and Nomad reported a healthy allocation. HTTP probes at about 250 ms intervals recorded 22 consecutive failures in a 5.7 second window. Restoring the original cartridge completed a second update and returned the job to CPU 2000; the final plan reported no changes.

The job has one allocation and reserves fixed host port 18518. Nomad's history shows the old allocation stopping before the replacement starts. The HTTP interruption occurred during this replacement. This is consistent with a stop-before-start rollout on one fixed port, though the probe did not isolate the port as the only cause. Most samples returned HTTP 200; the 23.1 second Alchemy operation was not a 23.1 second outage. A stable endpoint with health-checked traffic cutover is still needed for practical zero-downtime updates.

The probes checked HTTP from the workstation. They did not exercise game input, active user sessions, app writes, or database contents. The SQLite file remained mounted and existed afterward, but its bytes were not compared. The test did not force a failed deployment, so Nomad's automatic revert behavior remains unproven.

For later rollout checks, run `bash scripts/probe-http-rollout.sh URL [INTERVAL_SECONDS] [REQUEST_TIMEOUT_SECONDS] [DURATION_SECONDS]` from `tools/alchemy`. Start it before the deploy command. Keep it running until Nomad reports the new allocation healthy, and choose a duration that covers the full deploy. It prints the HTTP status, curl exit code, response time, and gap from the previous sample in separate columns. A failed request means curl exited non-zero or the HTTP status was not 200. Summarize samples with `bash scripts/probe-http-rollout.sh --summarize SAMPLE_FILE [MAX_SAMPLE_GAP_MS [WINDOW_START_UTC WINDOW_END_UTC]]`. The summary reports the first and last sample timestamps, failed samples, the longest failure run, and the largest sample gap. Add the expected rollout window bounds to get `INCONCLUSIVE` if the samples do not cover that whole interval. Without bounds, it returns `PASS` only when every request succeeds and the largest gap is at most 500 ms, `FAIL` if any request fails, or `INCONCLUSIVE` if there are no samples, the file format is invalid, or there are no failed requests but the gap is larger than the limit. Save the deploy start and end times with the sample file; the summary cannot infer which deploy a probe covered.

Noneuclid stores editable levels in one SQLite file on the shared host volume. Do not start two versions against that writable file until a single-writer handoff is designed and tested. A dynamic port alone does not make overlapping versions safe.

## Staged release proof

`staged.run.ts` declares one `Nomad.ReleaseSet` from a JSON manifest. Each release uses a separate Nomad job with a dynamic host port. The provider waits for Nomad's health check before it writes Caddy routes. The candidate gets a preview host while the selected release keeps the stable host. Promotion and rollback change the selected release in the manifest. Keep the previous release in `releases` to keep it available for rollback.

`bun run staged:controller` runs the same Alchemy stack as a long-running process. A successful deploy records the exact applied manifest at `.alchemy/staged-active.json`. The controller reads only that snapshot, so edits to the working manifest do not cause an automatic promotion. Allocation events trigger reconcile, and each Nomad stream reconnect starts with a reconcile to cover missed events. Both entry points use `staged-host-runner.sh` and its `flock` lock. Run the controller from this directory with the same `NOMAD_ADDR` and `CADDY_ADMIN_ADDR` as the staged CLI. Stop it with Ctrl+C or its process supervisor.

`nixos/modules/alchemy-staged.nix` defines the NixOS controller service and restricted sudo command. Nix packages the Bun runtime, Alchemy source, production dependency closure, and runner commands. Operators send manifest bytes over SSH:

```sh
cat releases/candidate.json | ssh operator@host sudo -n -u alchemy -- alchemy-staged plan
cat releases/candidate.json | ssh operator@host sudo -n -u alchemy -- alchemy-staged deploy --yes
```

The SSH account must belong to a group listed in `services.alchemyStaged.operatorGroups` (the default is `wheel`). The module does not create an SSH account or install an SSH key.

The Nix production lock is `bun-production.lock`; regenerate it and `bun.nix` with `bun run nix:deps`. Bun 1.4 reads the version 1 lock used here, while the pinned `bun2nix` converter currently rejects Bun's version 2 format. The host service restarts after failure and performs a full reconcile before it watches Nomad events. A failed explicit deploy keeps the old accepted manifest and attempts to restore it. If the host restarts after provider changes but before acceptance, the old accepted manifest remains authoritative.

The pinned runtime package and controller now have a fresh disposable-VM proof; see [Current limits](#current-limits) for controller restart and reboot results. Remote SSH apply and lock contention remain unverified.

This proof uses stateless `whoami` containers. It does not support shared writable volumes, public preview DNS, TLS, A/B traffic splitting, or placing releases on different nodes. The sample `*.localhost` hosts are for local routing checks; a phone cannot reach them. Do not use this flow for Noneuclid while two releases would share its writable SQLite file. Resource settings such as CPU, memory, and health checks apply to every declared release; changing them can update and restart the selected release's job. Keep them fixed during a staged image rollout until job configuration is versioned per release.

The working workstation setup used a local Nomad port forward, a local SSH tunnel to Caddy's loopback-only admin API, and these environment variables:

```sh
export NOMAD_ADDR=http://127.0.0.1:4647
export CADDY_ADMIN_ADDR=http://127.0.0.1:2019
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

For each change, set `ALCHEMY_RELEASE_SET` to the chosen manifest, run `bun run staged:plan`, then `bun run staged:deploy --yes`. Alchemy local state and the operation journal are stored under `tools/alchemy/.alchemy` in the workstation trial; the NixOS host uses `/var/lib/alchemy/.alchemy`. Back them up together. `ReleaseSet.read` adopts a set when every declared release has exactly one matching owned Nomad job; reconcile then removes extra owned release jobs. On 2026-10-20, a fresh disposable VM ran v1 plus v2 as the candidate. After backing up and moving Alchemy's local state aside while leaving Nomad and Caddy running, a fresh plan adopted the ReleaseSet. Deploy restored a deliberately deleted preview route. Both hosts returned HTTP 200 with the expected `X-Alchemy-Release` headers, Nomad still had exactly one running job per release, Caddy had exactly one route per host, and the final plan reported no changes. The test state backup is under `/tmp/opencode/alchemy-state-recovery/` on the test machine. Caddy route IDs are derived from the stack FQN and domain, not Alchemy's generated instance ID, so a recovered stack can address its existing routes. Earlier trial routes use the old ID format and must be removed before testing recovery with this code. The Caddy client sends the configured admin URL as the `Origin` header because Caddy 2.11 rejects these admin API requests without an allowed origin.

The stable Caddy route stores the Nomad service address and dynamic port observed during deploy. If Nomad later replaces or moves an allocation, the route can point at the old port. The operator-run `staged:controller` now listens for Nomad allocation events and invokes the same Alchemy deployment when a managed release changes. On the disposable VM, stopping v1's allocation made the stable route return HTTP 502. Nomad started a replacement on a new port; the controller ran Alchemy, and the route returned HTTP 200 with `X-Alchemy-Release: v1`. A later plan reported no changes.

The provider requires the matching allocation to be running, its Nomad deployment health to be successful, and its service health checks to pass. Nomad removes completed deployments from its active-deployment lookup, so that lookup cannot be the durable readiness record. The controller and host runner are declared in the NixOS module and passed the disposable-VM recovery proof described below.

`services.caddy.resume = true` restored API-managed routes after a Caddy process restart. A manual Caddyfile reload removed the API-managed route; the stable host returned HTTP 200 without `X-Alchemy-Release`. Alchemy's plan detected the missing route, and deploy restored it. Caddy starts from its saved API configuration while that autosave exists, so changes to the NixOS Caddyfile may not become active. Verify NixOS Caddyfile changes before production use.

The disposable VM returned HTTP 200 with `X-Alchemy-Release: v1` on the stable host, then returned v2 at the preview host while stable traffic remained on v1. Promotion changed the stable header to v2. Rollback changed it to v1. Cleanup removed the v2 job and preview route, and the final plan had no changes. The stable route survived a Caddy restart, and a new Alchemy plan reported no changes. A manual Caddyfile reload removed the route; Alchemy detected and restored it. An allocation reschedule changed its dynamic port; the route returned HTTP 502 until an Alchemy deploy reconciled it. An earlier generated image needed ext4 repair on its disposable overlay; the later fresh-image proof is recorded under [Current limits](#current-limits).

## Composed services and OpenBao secrets

The cartridge declares an `apiVersion: "server-ansible/v2"` document with `name`, optional `servers`, `postgres`, `valkey`, and an ordered `services` array. Each service becomes its own Alchemy-managed job. Services can refer to earlier services by job name; Alchemy resolves the dependency before it renders the `nomadService` template. PostgreSQL database and Valkey access resources are derived from `postgres` and `valkey` and participate in this order. The schema rejects duplicate names and dependencies that appear after their consumers. Network mode is explicit per service. Ports can be fixed or dynamic, and each service can use an HTTP or TCP health check.

Use `secrets` on each service to request runtime credentials. Each job's OpenBao role is derived as `alchemy-<job name>`; no role field is declared by hand. A secret reference contains only an OpenBao KV-v2 path, key, and destination environment-variable name. Nomad authenticates its workload identity to OpenBao and renders the secret into the task environment. Secret values are not inputs to Alchemy and are not included in its state or operation journal. `NomadJob.ts` writes the OpenBao ACL policy and the job-bound JWT role on reconcile; configure Nomad's Vault-compatible integration and OpenBao JWT auth endpoint separately. Do not put secret values in the cartridge's ordinary `environment` entries.

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
        { "_tag": "PostgresCredentials", "database": "app_needs", "login": "api", "usernameEnv": "PGUSER", "passwordEnv": "PGPASSWORD", "urlEnv": "DATABASE_URL" },
        { "_tag": "ValkeyCredentials", "usernameEnv": "VALKEY_USER", "passwordEnv": "VALKEY_PASSWORD", "urlEnv": "VALKEY_URL" }
      ]
    }
  ]
}
```

The platform creates a `ValkeyAccess` for the app and an ACL user whose key prefix is the app name. `ValkeyCredentials` carries the access name (`app_needs`); composition fills the credential path from the access resource Output, which is also the Alchemy dependency edge. PostgreSQL database roles use the same output-to-job pattern. The URL templates resolve the server host and port through `nomadService`, so apps do not list platform servers in `connections`. Do not use logical database numbers as an isolation boundary.

Destroying a `ValkeyAccess` revokes and persists the ACL user. Its OpenBao KV value is retained so a later recreation can reuse the credential. The server admin value is also retained when the Nomad job is destroyed. Remove these KV values through the OpenBao lifecycle when they are no longer needed.

The ACL behavior was checked on a disposable Valkey 8 container. An app user could write within its prefix; writes to another prefix and `FLUSHALL` were denied. A read-only user could read its prefix and could not write. `ACL SAVE` preserved the ACL across container replacement when the ACL file was on persistent storage. The Alchemy provider itself has not yet been deployed end to end. Valkey connections in this setup do not use TLS, so do not send credentials over untrusted networks or treat the disposable proof as production network validation.

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

The platform composition step resolves service names within one cartridge. It does not yet load multiple app cartridges or build images. PostgreSQL has an initial database resource, but app-role provisioning and the complete service-to-application flow have not passed an Alchemy-managed disposable integration proof. Database-backed and Valkey-backed services wait up to two minutes for their Nomad service to register before they fail, so a first deploy does not race its dependency. A `PostgresCredentials` secret with `url: { env }` renders a `postgresql://` URL from the dynamic credential and the server address. Its password is inserted without escaping, so the generated password must be URL-safe. A service may declare a `migrate` field with its own `command`, `args`, and `secrets`; Alchemy renders it as a Nomad prestart task in the same task group, so it runs to completion before the service starts and a failed migration keeps the service from starting. The migration task uses the service's image, network mode, and environment, and receives only its own secrets, normally the database's `migration` login, while the service receives only its own, normally the `api` login. For example, postgres.garden also expects root and shadow database URLs, and those need decisions before its deploy. Keep secret values out of Alchemy state.

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

Port `4647` is the fresh build. Port `4646` is the earlier VM with the Noneuclid app. The fresh VM is a separate disposable environment and does not contain that app.

Nomad's node and allocation metrics are available for a scraper. The endpoint does not retain resource history. Add a metrics store and dashboard before using resource use to choose where to move apps.

## Platform observability

`platform/observability/cartridge.json` declares two Nomad jobs that the platform runs for every app:

- `openobserve` stores traces, logs and metrics. It uses the `openobserve-data` host volume and the `alchemy-openobserve` OpenBao role. Its root password comes from `secret/data/platform/openobserve`, key `root_password`.
- `otel-collector` receives OTLP over HTTP on the job's dynamic port. It also scrapes Nomad's `/v1/metrics` endpoint and forwards everything to `openobserve`. It uses the `alchemy-otel-collector` role and the same password. Its config is the `OTEL_CONFIG` environment value, read with `--config=env:OTEL_CONFIG`.

Apply it with its own state directory, because one cartridge describes one stack:

```sh
ALCHEMY_CARTRIDGE=$PWD/platform/observability/cartridge.json bun run plan
```

Before the first deploy, write the root password to OpenBao, then create the two job-bound roles and their policies the same way the PostgreSQL proof did.

Checked on the workstation with OpenObserve v1.1.2 and the collector v0.131.0 image. OpenObserve accepted OTLP traces, logs and metrics. The collector scraped a stand-in Nomad endpoint and sent an app-style trace through its OTLP receiver. Both reached OpenObserve and were queryable. The collector config validates, and the loader rejects a collector declared before OpenObserve.

Not checked: that Nomad's `/v1/metrics` returns data to the collector on the testground VM, that `host.containers.internal` reaches Nomad from a bridge network, that Nomad leaves the `${env:...}` references in `OTEL_CONFIG` unchanged, and the memory use of OpenObserve under real load. Cynic is not changed. Its Nomad config needs the same host volume, a Nomad ACL token for the scrape, and approval.

## Current limits

The pinned runtime package and testground image build successfully. On 2026-10-20, a fresh disposable VM booted the host-owned controller, deployed the sample ReleaseSet as the `alchemy` account, restored a deleted preview route after controller restart, and reconciled both routes after reboot. A final plan reported no changes. The controller retried while Nomad was starting and then reconciled; this verifies recovery, not startup ordering. The package includes `util-linux` because the shared runner uses `flock`.

Alchemy supports ordered Nomad service jobs, service endpoint templates, health checks, OpenBao workload identity delivery, an initial PostgreSQL database resource, initial Valkey server/access resources, and a per-service `migrate` prestart task. The PostgreSQL resource and Valkey provider have not completed end-to-end disposable Alchemy validation. It does not build or publish images, provide a shared PostgreSQL server resource, or provide authenticated public ingress and TLS. The trial has not exercised persistent database replacement, backup and restore, cross-node routing, state-preserving data rollback, or a production NixOS rebuild.

The testground host firewall is disabled. The VM's QEMU port forwards bind to workstation loopback for local testing. Do not reuse this host configuration for production.
