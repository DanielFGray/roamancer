# Alchemy deployment trial

This package deploys app cartridges and shared platform services through Alchemy and Nomad. NixOS owns hosts, rootless Podman, and host volumes. Recorded proofs cover Noneuclid on a disposable VM and shared PostgreSQL and Valkey on cynic.

## Operator commands

`ops` is a program in `src/ops.ts`, which `scripts/ops` starts. `ops --help` lists its commands. The release, `rebuild`, `install` and `image` commands run on your machine. Every other command is a job on the control host, reached from your machine. The control host runs the Nomad server, OpenBao, the Alchemy state and the job queue; it is `cluster.server` in the `site.toml` of the folder that `OPS_SITE` names (see the root README), unless `OPS_HOST` names another. `ops` sends each job as one JSON request to `alchemy-runner submit` over SSH, then streams its output with `alchemy-runner wait` (`src/Remote.ts`; the queue is in `docs/design/host-owned-staged-runner.md`). The host runs only the runner its last `ops rebuild` installed, never code from a push, so before the first job `ops` refuses when this checkout's `tools/alchemy`, uncommitted changes included, differs from the runner's revision: commit, then `ops rebuild` that host. `login`, `logs`, `dash` and the secret commands are not jobs; `ops` runs them over SSH directly. `ops signoff` is not a job either: it sends one JSON line to `alchemy-runner signoff` (socket request `signoff`), and `ops signoff list` reads `alchemy-runner signoffs` (socket request `signoffs`); both skip the runner revision check, because the runner only stores and reads these records, and a platform commit here must not stop an app's push to `main`. `dash` prints what the fleet service on the control host serves (`src/fleet/`), so it answers while a deploy runs. Put `scripts` on your `PATH`, or alias it:

```sh
ops login                                  # once every 10 hours: mints an OpenBao token from the root token
ops release ../my-app                # build, push and deploy the app repository's current commit
ops stage ../my-app                  # deploy that commit at its tailnet-only staged route
ops promote ../my-app                # promote the exact staged digest, then discard it
ops discard giglist                        # destroy the staged instance
ops signoff                          # in an app repository: run scripts/verify on HEAD's exported tree, and record that it passed
ops signoff install                  # once per clone: refuse a push to main whose tree has no signoff
ops signoff list giglist             # that app's signoffs on the control host, newest first
ops repo create                        # in an app repository: make its repository on the control host, add the remote, install the hook
git push cynic main                    # release a signed-off main; the minute timer reconciles every app with a repository
ops reconcile giglist                  # release the head of giglist's main now, as the minute timer does; follows the job
ops deployment list giglist                # the recorded deployments, newest first
ops rollback giglist 12                    # deploy recorded deployment 12 again
ops plan --stage giglist                   # Alchemy plan of the newest recorded deployment
ops plan --stage platform-data             # a platform cartridge from this repository; `ops deploy` applies it
ops logs giglist-worker                    # a Nomad job's recent output, or its task events when it is not running; --tail follows
ops secret list                            # in an app repository: each referenced key: set, MISSING, or unused; never values
ops secret check                           # fails when a referenced key is unset
ops secret set github_client_secret        # with the login token; prompts for the value, or reads it piped on stdin
ops secret list platform/observability     # a platform cartridge, from tools/alchemy
ops dash                                   # the fleet service's snapshot: each job's health, containers and why a queued one waits; nodes; apps; runner jobs; addresses
ops place-queued                           # ask Nomad to place jobs with queued allocations again; `ops rebuild` runs it last
ops status giglist                         # each service's newest allocations
ops rebuild                                # host config (with your OPS_SITE folder) for every host in the root flake.nix, one at a time; `ops rebuild cynic` for one. sudo asks for your password on each. It pushes the committed repository and site folder to the host and builds from them; the switch makes a new system generation to roll back to.
ops install cynic root@10.0.0.9         # erase that machine's disk and install the host; asks you to type the host name, or pass --yes. Arguments for nixos-anywhere follow --
ops image garage-image                     # build a platform image (a container image output of the root flake.nix) with Nix in Docker, push it to the cluster registry, and print the reference to pin in its platform cartridge
```

`plan`, `deploy`, `destroy`, `state` and `drift` run Alchemy's own commands. `ops deploy` and every release command first queue a plan job and show it, then ask, then queue a deploy that names that plan; the host refuses the deploy, without running Alchemy, when another deploy, destroy or rollback finished after the plan, or the plan ran another cartridge or runner revision. `destroy`, `discard` and `rollback` ask before they queue. `--yes` skips each question, as a script without a terminal must. Each plan and deploy job checks the cartridge's secrets with the `login` token, which fails when a secret the cartridge references is unset (a task would otherwise wait on its template until the deploy times out) or the token has expired. The stage is a cartridge's `name`; `Cartridge.resolve` finds the cartridge (see [Where cartridges live](#where-cartridges-live)). The other commands are `src/cli.ts`, for what Alchemy has no place for. `ops logs` reads Nomad by job name, which is the resource's name, so it needs no stage and works for a job whose first deploy failed and left no Alchemy state. It prints stdout and stderr of each running task in the newest running allocation, with the time podman recorded for each line (`src/TaskLog.ts`).

`release`, `stage` and `promote` run in an app's repository, by default the current directory, and share one build-and-push step, keyed by HEAD's files. `release`, `stage` and `promote` show the plan and ask before they deploy. They build from the repository's committed `HEAD`, and tag the image with HEAD's tree hash (`git rev-parse HEAD^{tree}`), its image key. The runner records the built digest for that key, only after the registry answers for it. Before a build, `ops` reads that record (`alchemy-runner image find`) and reuses the recorded image when one exists: two commits with the same files, as after a squash merge, share one image. The record decides, not the registry's tag, because the registry takes pushes from every node without credentials; a recorded digest names content that the runner's build pushed and the registry holds. Uncommitted changes stay out of the image and the working tree may stay dirty; `ops` prints how many it left out. The build is a Nomad batch job on a worker node, so neither the workstation nor the operator's account builds. `ops` makes a tar of the exported HEAD and sends it over one ssh call to `alchemy-runner build`, which queues a `build` job. The job uploads the tar to the `builds` bucket in Garage, with a key only the runner holds (the `builds` platform cartridge declares the bucket and key; deploy it once with `ops deploy --stage platform-builds`). It runs a Nomad batch job in the builder user's rootless Podman with Buildah (`--isolation chroot --storage-driver vfs`); Nomad fetches the tree from a presigned URL that expires in ten minutes, so the build holds no credential. The job reserves 256 MB and may use up to 2048 MB; an app cartridge sets another cap with `"build": { "memoryMB": 3072 }` (256 to 4096). The runner reads the digest the job prints, treats it as untrusted, records it only when the registry answers for `<repository>@<digest>`, and deletes the tar. A build holds the queue, so `ops dash` shows it as a job; a build that Nomad cannot place within five minutes fails with the scheduler's reason. The Buildah image is pinned in `src/BuildJob.ts`. Every deploy names the image as `repository@digest`: Nomad's Podman driver refuses a reference with both a tag and a digest. A cartridge that names more than one image repository is refused. `release` builds and pushes the image, copies the repository's `cartridge.json` with the pushed digest in every service, and deploys that copy; the host records it once the deploy succeeds. Nothing is committed. `stage` deploys that digest as `<name>-staged`; the job carries it as `STAGED_IMAGE`, the image a `-staged` deploy runs. `promote` never builds: it looks up the image with HEAD's key, refuses when there is none, refuses unless every staged job is stable and runs that digest, then releases it. Destroy uses `state.run.ts`, which shares the cartridge stack name, providers, and state but declares no resources. It deletes only resources in Alchemy state, so discard works even if Nomad never registered a staged job and needs no image. `rollback` deploys a recorded deployment again, spec and image together, and records it as the newest; migrations stay applied (see `nixos/backup-operations.md` for restoring data).

The secret commands read the `cartridge.json` in the given folder, default the current directory, so a key added to the cartridge can be set before it is released. An app folder is held to its namespace; a folder under `platform/` is trusted. Each command then makes one `ssh` to the control host and runs `alchemy-runner secret` there with only KV paths and key names as arguments. For `list` and `check`, the host reads the OpenBao root token, typed or piped (`pass show infra/openbao-token | ops secret list`), mints a 5-minute child of it, and uses that child only in that process; neither token reaches a file or a job. `secret set` uses the `login` token instead: the runner's front end writes the key with it at once and never queues the value. So while the operator is logged in, any process that can use the operator's ssh key can set secrets, as it can deploy. The value is typed at the host's prompt, or piped (`printf '%s\n' "$value" | ops secret set api_key`); one trailing newline of a piped value is dropped. Reads return key names, never values. `secret set` accepts only a key that the cartridge references, with a `KvSecret` or as the `token` of its `dashboards`, at that reference's path, so a misspelled key fails before anything is stored. It keeps the other keys at that path. Nomad restarts a running task when a value it reads changes. Jobs read the Nomad controller token from `/var/lib/nomad-acl/controller.env` as the runner user `alchemy`; `ops logs` reads Nomad with the operator's read-only token, so no command needs sudo.

## The fleet page

The fleet service also serves a page with the same snapshot, at `https://<control host>.<tailnet>.ts.net/` on the tailnet. It reads the snapshot again every 5 seconds. Each job row links to the job's addresses and its metrics. Each app card links to the live app's public hosts and lists each staged copy (`<app>-staged`) with the commit it runs and its tailnet address. The addresses come from Alchemy's state, so a resource gets its link when its deploy finishes. The page is a Solid app in `web/`, built with Vite (`bun run build:web` writes `web/dist`). Nix builds it as the `fleet-page` package, and the runner's wrapper gives the fleet service its path as `FLEET_WEB_ROOT`. To work on it, forward the service's port and run Vite's dev server, which forwards `/api` to it:

```sh
ssh -L 8780:127.0.0.1:8780 cynic
bunx vite web
```

The page's build tools are devDependencies, so `bun.nix` is generated from the full `bun.lock`; the runner installs only `bun-production.lock`. Run `bun run nix:deps` after a dependency change.

## Where cartridges live

A platform cartridge lives in this package at `platform/<folder>/cartridge.json`. An app cartridge lives at the root of the app's own repository, and names its image repository without a digest. This package holds no app cartridge, so it knows no app until one is deployed; `examples/apps` holds sample cartridges that the tests load.

On the control host, an app's cartridge comes from one of two places. When `ops` sends one (`release`, `stage`, or `CARTRIDGE=<file>` with `plan`, `deploy` or `drift`), the job row carries its JSON, and the job writes it to a private temporary file passed as `CARTRIDGE_FILE`. Otherwise the host reads the newest recorded deployment, so `plan`, `drift` and the deploy-time secret check work without the app's repository.

`src/Deployments.ts` keeps the record in a `deployments` table of `.alchemy/operations.sqlite`: the app name, the repository's root commit, the released commit, and the cartridge exactly as deployed, with its digests. A release must pin every image, and the first deployment of a name binds it to its repository: a cartridge with the same name from a repository with another root commit is refused. A root commit names a repository whatever its remotes are called.

## Plan and deploy

A cartridge is a versioned JSON file that describes services and their data needs. The platform orders jobs by their dependencies, and the stage selects a cartridge by its `name`. Connect to the target Nomad API before planning or deploying. This example assumes a local API or an SSH forward on port `4646`:

```sh
export NOMAD_ADDR=http://127.0.0.1:4646
cd tools/alchemy
CARTRIDGE_FILE=../my-app/cartridge.json bun run plan --stage my-app
CARTRIDGE_FILE=../my-app/cartridge.json bun run deploy --stage my-app
```

`NOMAD_TOKEN` is optional only on an ACL-free testground. State is local and separated by stage. Use the same control machine and state directory for later plans. `bun run destroy --stage my-app` removes that cartridge's managed resources, not the Nix host volume. Use `--stage platform-data` for the shared server cartridge.

The Nomad provider records reconcile and delete operations in `.alchemy/operations.sqlite`. If a process stops after an operation starts but before it records the result, the next plan detects that pending operation and reconciles the resource against live Nomad state. Inspect the history with `bun run history`. Keep the journal and Alchemy state under `.alchemy` together. This is local operation history, not shared state. On cynic, `restic-backups-alchemy` backs up the state and a consistent copy of the journal (`nixos/backup-operations.md`). On the control host, Nix installs `alchemy-runner` (`src/cli.ts`) as the `alchemy` user with state under `/var/lib/alchemy`; submissions go to `/run/alchemy/submit.sock` (queue not built yet).

The platform reads the versioned cartridge and checks its API version and job fields against the supported schema, then translates each service declaration into a Nomad job. The initial bridge-network update produced job version 2. In that proof, a cartridge update and restoration left job version 4 healthy, HTTP returned 200, and the final Alchemy plan reported no changes. These are saved results, not a current VM status check.

Each service contains its image, published and container ports, optional persistent volume name and mount path, optional health check, CPU and memory, explicit network mode, environment, service connections, and OpenBao secret references. Nix must declare the requested host volume. The image must already be available to Nomad. Keep the CLI working directory at `tools/alchemy` so local Alchemy state stays in the same location.

A route without `access` is public and uses Traefik. A tailnet route is `{ "access": "tailnet" }`; Tailscale Serve publishes it at the host's MagicDNS name on a leased HTTPS port from 9000 through 9099. Serve forwards to Traefik's `tailnet` entrypoint on the ingress node, under the path `/_tailnet/<job>/`, and Traefik finds the job on any node through its service tags (see `platform/ingress/README.md`). The job keeps the host port it declares. Alchemy runs as the operator on the control host. Configure that account as a Tailscale operator so the provider can run `tailscale serve` without sudo. The tailnet route needs no public DNS record or Traefik certificate. A cartridge whose routes are all tailnet routes is a private service: `ops release` deploys it, keeps its URL across redeploys, and prints the URL when the deploy ends. The leased port is kept in Alchemy state. Any device on the tailnet can reach the service, and staged copies draw from the same 100 ports.

## Update rollout proof

On the disposable `rootless-nomad` VM, changing the cartridge CPU reservation from 2000 to 2001 caused Alchemy to update the existing job. The update completed and Nomad reported a healthy allocation. HTTP probes at about 250 ms intervals recorded 22 consecutive failures in a 5.7 second window. Restoring the original cartridge completed a second update and returned the job to CPU 2000; the final plan reported no changes.

The job has one allocation and reserves fixed host port 18518. Nomad's history shows the old allocation stopping before the replacement starts. The HTTP interruption occurred during this replacement. This is consistent with a stop-before-start rollout on one fixed port, though the probe did not isolate the port as the only cause. Most samples returned HTTP 200; the 23.1 second Alchemy operation was not a 23.1 second outage. A stable endpoint with health-checked traffic cutover is still needed for practical zero-downtime updates.

The probes checked HTTP from the workstation. They did not exercise game input, active user sessions, app writes, or database contents. The SQLite file remained mounted and existed afterward, but its bytes were not compared. The test did not force a failed deployment, so Nomad's automatic revert behavior remains unproven.

For later rollout checks, run `bash scripts/probe-http-rollout.sh URL [INTERVAL_SECONDS] [REQUEST_TIMEOUT_SECONDS] [DURATION_SECONDS]` from `tools/alchemy`. Start it before the deploy command. Keep it running until Nomad reports the new allocation healthy, and choose a duration that covers the full deploy. It prints the HTTP status, curl exit code, response time, and gap from the previous sample in separate columns. A failed request means curl exited non-zero or the HTTP status was not 200. Summarize samples with `bash scripts/probe-http-rollout.sh --summarize SAMPLE_FILE [MAX_SAMPLE_GAP_MS [WINDOW_START_UTC WINDOW_END_UTC]]`. The summary reports the first and last sample timestamps, failed samples, the longest failure run, and the largest sample gap. Add the expected rollout window bounds to get `INCONCLUSIVE` if the samples do not cover that whole interval. Without bounds, it returns `PASS` only when every request succeeds and the largest gap is at most 500 ms, `FAIL` if any request fails, or `INCONCLUSIVE` if there are no samples, the file format is invalid, or there are no failed requests but the gap is larger than the limit. Save the deploy start and end times with the sample file; the summary cannot infer which deploy a probe covered.

Noneuclid stores editable levels in one SQLite file on the shared host volume. Do not start two versions against that writable file until a single-writer handoff is designed and tested. A dynamic port alone does not make overlapping versions safe.

## Host runner and staged releases

Nix installs `alchemy-runner` on the control host (`nixos/modules/alchemy-runner.nix`): the `alchemy` user owns `/var/lib/alchemy`, and the operator submits on `/run/alchemy/submit.sock` (group `alchemy-submit`). The socket service is a stub until the queue lands; jobs will run as `alchemy-job@<id>.service`. Mutating `ops` commands still reach `src/cli.ts` over SSH today; the socket replaces sudo for enqueue. See `docs/design/host-owned-staged-runner.md`.

`ops stage` / `ops promote` deploy a cartridge's staged instance through that host program (Traefik tags on Nomad services; see `platform/ingress/README.md`). The Nix production lock is `bun-production.lock`; regenerate it and `bun.nix` with `bun run nix:deps`.

## Composed services and OpenBao secrets

The cartridge declares an `apiVersion: "server-ansible/v2"` document with `name`, optional `servers`, `postgres`, `valkey`, and a `services` array. Each service becomes its own Alchemy-managed job. Services can refer to other services in the cartridge by job name, in any declaration order. `Cartridge.ts` uses `effect/Graph` to place providers before consumers; the schema rejects duplicate names, undeclared connections, and dependency cycles. PostgreSQL database and Valkey access resources are derived from `postgres` and `valkey`; their outputs supply credential paths to dependent jobs. A cartridge either provides servers or requests PostgreSQL and Valkey access. Shared-server dependencies across cartridges are not part of this graph. Network mode is explicit per service. Ports can be fixed or dynamic, and each service can use an HTTP or TCP health check.

Use `secrets` on each service to request runtime credentials. Each job's OpenBao role is derived as `alchemy-<job name>`; no role field is declared by hand. A secret reference names either an OpenBao KV-v2 path and key or a declared PostgreSQL or Valkey need, plus destination environment-variable names. Nomad authenticates its workload identity to OpenBao and renders the secret into the task environment. Secret values are not inputs to Alchemy and are not included in its state or operation journal. `NomadJob.ts` writes the OpenBao ACL policy and the job-bound JWT role on reconcile; configure Nomad's Vault-compatible integration and OpenBao JWT auth endpoint separately. Do not put secret values in the cartridge's ordinary `environment` entries.

On 2026-10-20, a fresh disposable VM ran an Alchemy-managed PostgreSQL job and a dependent client job. Nomad obtained both jobs' credentials from OpenBao through job-bound JWT roles. The client discovered PostgreSQL's dynamic endpoint through the generated Nomad service template and successfully queried the database. Both Alchemy resources reached healthy status. A check of the Alchemy state and operation journal found no copy of the test password. The proof used a disposable PostgreSQL role and database, not shared production data.

This proves ordered multi-job deployment, runtime secret delivery, and an authenticated query on one disposable node. The v2 platform provides a shared PostgreSQL server and database provider; idempotent app-role provisioning is handled by the OpenBao database plugin. The proof configured its test secret, OpenBao policy, and job-bound roles directly. It did not test persistent database data, replacement recovery, multiple nodes, or private cross-node routing. Do not use the proof's broad test policy or root token pattern in a deployment.

### Shared Valkey service and app access

In v2 a platform cartridge (see `platform/data/cartridge.json`) declares the shared servers once. An app cartridge declares what it needs with `postgres`, `valkey` and `objectStore`; the platform derives the role names, login names and Valkey key prefix from the app name. Every other identity an app cartridge declares must lie in the app's namespace: each database equals the app name (with `_` for `-`) or starts with it and `_`, each service name and host volume equals the app name or starts with it and `-`, and each KV path equals `secret/data/<app>` or lies under it. A service's OpenBao role is `alchemy-<service name>`, so it is in the namespace too. The app name alone then decides what an app can reach, and no app cartridge can claim another app's database, secrets or volume. Route hostnames cannot follow from the name, so the operator reviews them. Platform cartridges declare shared identities such as `postgres` and `traefik`; they are not held to the namespace because they live in this repository. `platform/data` provides `PostgresServer "postgres"`, `ValkeyServer "valkey"` and `GarageServer "garage"`; each generates its own admin password or token through `Generated.Secret`.

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

### Object store

`"objectStore": {}` gives the app an S3 bucket named after the app on the `garage` server, and a key that can read and write only that bucket. The `ObjectStoreCredentials` secret puts any of these into the task's environment: `endpointEnv` (the S3 address, from the Nomad service), `regionEnv`, `bucketEnv`, `accessKeyIdEnv` and `secretAccessKeyEnv`.

```json
{
  "_tag": "ObjectStoreCredentials",
  "endpointEnv": "S3_ENDPOINT",
  "regionEnv": "S3_REGION",
  "bucketEnv": "S3_BUCKET",
  "accessKeyIdEnv": "S3_ACCESS_KEY_ID",
  "secretAccessKeyEnv": "S3_SECRET_ACCESS_KEY"
}
```

The `Garage.Bucket` resource (`src/GarageBucket.ts`) gives a new Garage node its storage role, creates the bucket and the key, and keeps the key in OpenBao at `secret/data/garage/<app>`. Garage shows a key's secret only when it creates the key, so OpenBao holds the only copy. Clients must sign for the region `garage` and use path-style addresses (`http://endpoint/bucket/object`). The store has no public route: an app serves its files through its own routes, and presigned URLs do not work outside the cluster. A staged copy gets its own key, `<app>-staged`, on the live bucket. Destroying the resource deletes the key and keeps the bucket and its objects. The design is in `docs/design/object-store.md`.

### Generated secrets

A `GeneratedSecret` reference asks the platform for a random value, such as a session signing key, so no operator makes or stores one by hand:

```json
{ "_tag": "GeneratedSecret", "key": "secret_key_base", "env": "SECRET_KEY_BASE", "bytes": 64 }
```

The first deploy writes each key at `secret/data/<app>/generated` as the hex text of `bytes` random bytes (at least 32), so `bytes: 64` gives 128 characters. Later deploys keep the stored value, even when `bytes` changes, and destroying the app keeps it too. To replace the values, run `bao kv metadata delete secret/<app>/generated` on the control host, then deploy: the next deploy makes every generated key of the app again. A plain `bao kv delete` keeps the path's version history; the next write still succeeds, check-and-set against that history, and writes only the keys it sets (soft-deleted data is not merged back). A staged copy reads the live app's values, because its database is a copy of the live one. The `Generated.Secret` resource (`src/GeneratedSecret.ts`) also makes each server's admin password. `ops secret` commands handle only the keys an operator sets, so a generated key is never reported as missing.

A job's `ports` list adds container ports beside the service port. Each one gets a dynamic host port and the Nomad service `<job>-<name>`. The Garage job serves S3 on its service port and its admin API on the `admin` port, so the provider finds the admin API as `garage-admin`. Named ports need bridge or pasta networking.

### PostgreSQL extensions and logins

A `postgres` entry can list the extensions its app needs, for example `{ "database": "app_needs", "extensions": ["pgtap", "vector"] }`. Before any migration runs, the provider connects to the app's database as the server admin, a superuser, and runs `CREATE EXTENSION IF NOT EXISTS` for each one. Untrusted extensions work the same way, so apps do not create extensions in their migrations. The provider checks every name against `pg_available_extensions` first. If any extension is missing from the server image, it creates none and fails with an error that names the missing ones.

The shared server runs the image that `nixos/cynic/postgres-image.nix` builds. That file lists the extensions the platform supports. To support a new one, add it there, then run `ops image postgres-image`, which builds the image from the committed repository and pushes it to cynic's registry (the workstation's setup is in `nixos/cynic/cluster-tls-operations.md`), and pin the reference it prints in `platform/data/cartridge.json`. An extension that nixpkgs lacks, such as `pg_hashids`, is a short Nix package in the same file. The image initializes data with the builtin `C.UTF-8` locale. That locale does not depend on glibc, so a nixpkgs update cannot change how stored text sorts. An app that needs human sort order names an ICU collation on the column or query.

Each release gets a new migration login, which starts every session as the database's owner role. The tables it creates therefore belong to the owner role, and later releases can alter them. The API login does not inherit the visitor role. It switches to that role with `SET ROLE`, so row-level security applies to its queries.

The database providers connect directly to the address that Nomad registers for each server, so Alchemy must run on the host. Run from a workstation, `Postgres.Database` fails with `connect to PostgreSQL`. See `docs/design/host-owned-staged-runner.md`.

Destroying a `ValkeyAccess` revokes and persists the ACL user. Its OpenBao KV value is retained so a later recreation can reuse the credential. The server admin value is also retained when the Nomad job is destroyed. Remove these KV values through the OpenBao lifecycle when they are no longer needed.

On 2026-10-21, Alchemy deployed the `platform-data` cartridge on cynic. PostgreSQL and Valkey accepted their generated admin credentials and rejected incorrect credentials. Valkey also rejected unauthenticated commands. After Nomad replaced both containers, PostgreSQL retained its initialized data directory and Valkey retained its default ACL user. A scan found neither admin password in Alchemy state or the operation journal. The final plan reported no changes. This did not deploy an app database or app-scoped Valkey access, test application writes, or prove backup and restore.

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

On 2026-10-20, a separate disposable VM probe ran PostgreSQL 16 in one rootless allocation and a `psql` client in another. The client discovered a dynamic endpoint through a Nomad service template and queried the database successfully. Stopping the database allocation caused Nomad to replace it; a new client allocation discovered the replacement and queried it successfully. This used PostgreSQL `trust` authentication for the disposable probe. It does not prove Alchemy database resources, generated roles, OpenBao secrets, persistent data, or multi-node routing.

This proves one-node reachability through a published host port. It does not prove private addressing between production nodes, health-filtered discovery, or multi-node placement. Nomad native service discovery supplies addresses through templates; it does not provide DNS. Production nodes need routable private addresses and firewall rules for published service ports.

The implementation follows the [Nomad Podman driver's network modes](https://github.com/hashicorp/nomad-driver-podman#task-configuration) and [Nomad native service discovery templates](https://developer.hashicorp.com/nomad/docs/job-declare/service-discovery).

## Verify the NixOS testground

A fresh VM booted from the current flake build reports NixOS 26.11, Nomad 2.0.7, rootless Podman 5.8.8, and `crun` from the Nix store. Its Nomad metrics endpoint responds with Prometheus data:

```sh
curl -fsS 'http://127.0.0.1:4647/v1/metrics?format=prometheus' \\
  | rg -i 'nomad_client_host_cpu|nomad_client_allocated_(cpu|memory)'
```

In the recorded proof, port `4647` forwarded to the fresh build and port `4646` to the earlier Noneuclid VM. These were separate disposable environments. Check the current VM and tunnel configuration before using those ports.

Nomad's node and allocation metrics are available for a scraper. The endpoint does not retain resource history. OpenObserve keeps that history, and its Nomad cluster dashboard shows it (see [Dashboards](#dashboards)).

## Platform observability

`platform/observability/cartridge.json` declares two Nomad jobs that the platform runs for every app:

- `openobserve` stores traces, logs and metrics. It uses the `openobserve-data` host volume and the `alchemy-openobserve` OpenBao role. Its root password comes from `secret/data/platform/openobserve`, key `root_password`. A web login lasts a year (`ZO_COOKIE_MAX_AGE`), so the browser asks for the password about once a year.
- `otel-collector` runs on the host network and receives OTLP over HTTP on the node's LAN address, port 4318, OTLP/HTTP's standard port. It also scrapes Nomad's `/v1/metrics` endpoint and forwards everything to `openobserve`. It uses the `alchemy-otel-collector` role and the same password. Its config is the `OTEL_CONFIG` environment value, read with `--config=env:OTEL_CONFIG`.

Every Nomad task that Alchemy renders gets `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.containers.internal:4318`. Inside a rootless Podman container the node's LAN address is the container's own address, so only `host.containers.internal` reaches the collector on the host. The value stays the same when the collector restarts, and no task restarts with it. A task's own `environment` entry of the same name replaces it. An app exports a signal only when its cartridge also sets that signal's exporter, for example `OTEL_TRACES_EXPORTER=otlp` and `OTEL_LOGS_EXPORTER=otlp`.

Every task of an app that `ops release`, `ops stage`, `ops promote` or `ops rollback` deploys also gets `GIT_COMMIT`, the short commit that deploy runs, so a health endpoint can report it. The commit comes from the deploy, not from a Docker build argument, because one image can serve every commit with the same tree (`../../docs/design/pr-previews.md`). Platform cartridges get none. A task's own `environment` entry of the same name replaces it.

Plan it in its own stage, named after the cartridge. The stage separates its resources from the platform-data and app resources in local state:

```sh
bun run plan --stage platform-observability
```

Before the first deploy, write the root password to OpenBao and configure the platform mounts and Nomad JWT authentication. `NomadJob` creates the job-bound roles and policies during reconciliation, so the Alchemy process needs permission to write them. Narrowing that permission remains security work.

Checked on the workstation with OpenObserve v1.1.2 and the collector v0.131.0 image. OpenObserve accepted OTLP traces, logs and metrics. The collector scraped a stand-in Nomad endpoint and sent an app-style trace through its OTLP receiver. Both reached OpenObserve and were queryable. The collector config validates. The loader now accepts either declaration order and places OpenObserve before its collector consumer.

Checked on cynic on 2026-10-23: giglist and noneuclid traces and logs reach OpenObserve through the collector. The Nomad scrape failed there for two reasons: Nomad served no Prometheus format until its `telemetry` block turned it on, and a bridge-network container cannot reach Nomad, which listens only on the host's loopback address (`host.containers.internal` reaches the host's other addresses only). The collector therefore runs on the host network, scrapes `127.0.0.1:4646`, and binds its OTLP receiver to `NOMAD_ADDR_service`, the node's LAN address and port 4318. Tasks reach that receiver through `host.containers.internal`; checked from a bridge container on 2026-10-23, where `10.13.37.196:4318` timed out. Not checked: the memory use of OpenObserve under real load.

### Dashboards

The cartridge's `dashboards` entry names OpenObserve's service, an OpenObserve service account, the OpenBao key of that account's token, and one file per dashboard under `platform/observability/dashboards`. Each file holds one dashboard in the format that OpenObserve's dashboard page exports (version 8). A deploy of `platform-observability` creates each dashboard through OpenObserve's API (`src/OpenObserveDashboard.ts`), after the `openobserve` job. Only platform cartridges may declare dashboards, because an app's cartridge reaches the host without its other files.

- `services.json` shows requests, errors, p95 latency, routes and database queries from traces, and log lines. Health checks and polling (`/api/health`, `/healthz`, `/api/sync`) are more than 99% of server spans, so each panel leaves them out, except the Background traffic panel that shows only them.
- `nomad.json` shows host CPU, memory and disk, reserved memory and running allocations, and memory, CPU, restarts and failed allocations per job.

The repository holds the dashboards. OpenObserve changes a dashboard's hash on every save, so a plan compares the live hash with the hash the last deploy stored. A dashboard that was saved by hand, or lost with OpenObserve's data, shows as an update, and the deploy writes the file's version back. To change a dashboard, edit it in the UI, export it, replace its file with the export, and deploy. `ops drift platform-observability` repairs the same changes without a deploy.

The service account is `automation`, created once in the OpenObserve UI (IAM, Service Accounts). Store its token with `ops secret set automation_token` in `platform/observability`; a plan fails while the key is unset.

## Current limits

The pinned runtime package and testground image build successfully. On 2026-10-20, a fresh disposable VM booted an earlier host-owned staged controller (since removed), deployed a sample ReleaseSet as the `alchemy` account, and reconciled both routes after reboot with a final plan reporting no changes. Traefik follows a moved allocation from its Nomad tags, so no long-running watcher is needed. The control host now installs `alchemy-runner` from the root flake.

Alchemy supports dependency-ordered Nomad jobs, endpoint templates, health checks, OpenBao workload identity delivery, shared PostgreSQL and Valkey servers, app database and Valkey access resources, and per-service `migrate` prestart tasks. The shared servers passed the cynic proof above; app-scoped provisioning and migrations still need an end-to-end proof. The runner does not build or publish images or configure public TLS. Backup and restore, cross-node routing, state-preserving data rollback, and a production rebuild remain unproven.

On cynic, workload secrets rendered as environment variables worked in the platform-data proof. On 2026-10-22, replacing Nomad's `BindReadOnlyPaths` with a host-visible `/sbin/ip` symlink also restored file visibility. The live probe in `../../testground/probe-nomad-secrets.sh` verified that a bridge-network rootless Podman task reads a dummy template and that the host sees its secrets mount as tmpfs with swap disabled. The probe uses mode `0400` with ownership set to the host Nomad user (`1001`), which maps to container root. Choose ownership for the task's actual user when delivering files. This probe does not test OpenBao login. Keep secret files out of the on-disk task directory.

The testground host firewall is disabled. The VM's QEMU port forwards bind to workstation loopback for local testing. Do not reuse this host configuration for production.
