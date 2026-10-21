# Custom PostgreSQL builds and database branches

Research date: 2026-10-11. These are proposals for the Alchemy and Nomad goal. They do not change project decisions.

The current production deployment uses one PostgreSQL server. The goal for planned moves is practical continuity, with a short read-only handoff. See [PostgreSQL availability and migrations](postgres-availability-and-migrations.md) for the proposed IaC foundation. Permanent replicas and automatic failover remain open design work.

## Fit with the current platform

The proposed platform can run a custom PostgreSQL build. Nomad's Podman driver runs OCI images, the standard container image format, and mounts persistent volumes. PostgreSQL and its extensions can be built into that image. Nomad does not impose an extension catalogue. [Nomad Podman driver](https://developer.hashicorp.com/nomad/plugins/drivers/podman)

PostgreSQL's PGXS extension build system uses `pg_config` to select the PostgreSQL installation. Native extensions, which contain compiled machine code, need the correct server version and runtime libraries. Extensions that need `shared_preload_libraries` also need server startup configuration. A custom server patch needs a compatible extension build. These are image build and verification concerns. [Extension build system](https://www.postgresql.org/docs/current/extend-pgxs.html), [C-language functions](https://www.postgresql.org/docs/current/xfunc-c.html), [Library preload settings](https://www.postgresql.org/docs/current/runtime-config-client.html)

A PostgreSQL major version upgrade needs an explicit data upgrade or logical transfer. Replacing the image alone does not upgrade the stored data. Extension upgrades can also change stored data or schema. An older image is not necessarily safe after those changes. [PostgreSQL upgrades](https://www.postgresql.org/docs/current/upgrading.html)

The [current trial](../../tools/alchemy/README.md) proves one app job with a persistent host volume. It does not yet prove PostgreSQL builds, backups, restore, or production security. The [NixOS configuration](../../nixos/testground/configuration.nix) defines only the `noneuclid-data` volume. It does not select a PostgreSQL storage filesystem.

Proposal: keep the custom database image, data volume, backup, and migration release distinct. Pin the image by its content digest. Keep data across job replacement and Alchemy resource deletion. A database branch is an isolated copy of database data, separate from an Alchemy stage. This proposal does not revive stage-specific production deployment plans.

## Required extensions and build freedom

The user requires `pg_hashids`, `pgsodium`, and pgTAP now. The extension name for "pg-sodium" is `pgsodium`. Future builds need pgvector and PostGIS. Experimental extensions and patched PostgreSQL servers are in scope. A fixed extension catalogue or a vanilla-server restriction would fail this requirement.

| Extension | Requirement | Build and restore concern |
| --- | --- | --- |
| [pg_hashids](https://github.com/iCyberon/pg_hashids) | Required now. Encodes integers as short reversible identifiers. | Builds against the selected `pg_config`. Its README lists old tested server versions, so prove the selected modern server version. Preserve output behavior across updates. |
| [pgsodium](https://github.com/michelp/pgsodium) | Required now. Cryptographic functions using libsodium. | Includes native code and the libsodium runtime. Server-managed key mode needs preload configuration and an external startup key source. |
| [pgTAP](https://pgtap.org/documentation.html) | Required now. SQL assertions for database tests. | Install the `pgtap` extension files. Provide `pg_prove`, the test runner, in the test environment. |
| [pgvector](https://github.com/pgvector/pgvector) | Future. Vector storage and similarity search. | Compile against the chosen server. SQL extension name is `vector`. Verify queries and index behavior on restored data. |
| [PostGIS](https://postgis.net/docs/postgis_installation.html) | Future. Spatial types and operations. | Pin GEOS, PROJ, and other build dependencies. Raster support also needs GDAL. Choose required modules before building. |

Proposal: keep one source-controlled image recipe with pinned PostgreSQL source, optional patch files, and extension sources. Each extension can include its build instructions and runtime dependencies. Adding an experimental extension changes that recipe and produces a new image digest. Nomad and Alchemy continue to consume the image reference without an extension-specific provider change. Build extensions against the exact server produced by the recipe. Record server source, patches, extension revisions, and dependencies with the image.

The deployment declaration accepts a caller-built image. The provided recipe is a convenience, not the only way to build PostgreSQL. Each database selects a host server with the required image and configuration. Databases that share a server share that image. Experimental builds run against isolated data copies before production use.

The sources establish build mechanisms. They do not prove that the chosen versions work together. Exact version compatibility, patched-server behavior, upgrades, and restore remain executable proof requirements. The next proof uses all three required extensions rather than a generic PostgreSQL image.

### pgsodium keys in restore branches

pgsodium has two modes. Functions can take keys supplied by the caller. Its optional server-managed mode loads a root key from an external script at startup and derives keys from it. The root key stays outside SQL. Server-managed mode uses `shared_preload_libraries` and `pgsodium.getkey_script`. [pgsodium server key management](https://github.com/michelp/pgsodium#server-key-management)

A restored branch that decrypts production data needs the original key material and the corresponding key metadata. A new random root key cannot decrypt existing data. Proposal: fetch the key at runtime through an OpenBao secret reference and a narrowly scoped purpose-specific token. Keep the key out of images and application properties. The restore proof must demonstrate decryption after restart and after restore. Retain keys needed by backups across rotation. [pgsodium key derivation](https://github.com/michelp/pgsodium#server-key-derivation)

A branch with that key can decrypt copied production data. A sanitized branch instead needs a controlled transformation before wider access. Replace sensitive data and, where required, encrypt replacement values under a branch-specific key. A sanitized branch cannot prove that the original production ciphertext restores and decrypts. The protected restore proof and the sanitized development branch serve different purposes. These are design conclusions from pgsodium's documented key derivation.

## Shared servers and Effect dependencies

Several apps can use one PostgreSQL server. A server contains separate named databases; roles are shared across the server. A connection selects one database. Proposal: give unrelated apps separate databases and login roles by default. Apps that share tables explicitly select the same database, with separate login roles and one migration owner. [PostgreSQL databases and schemas](https://www.postgresql.org/docs/current/ddl-schemas.html)

Keep server identity, database identity, and app access distinct. The server selects the PostgreSQL image, persistent storage, and startup settings. The database selects its name, extensions, and migration owner. App access selects permissions and an OpenBao secret reference. Extension files must exist in the selected server image before a database can enable them. All databases on that server use the same server binary and installed library versions. [CREATE EXTENSION](https://www.postgresql.org/docs/current/sql-createextension.html)

Proposal: declare servers and databases once in the platform composition. An app deployment requires a database dependency. Supply that dependency through an Effect Layer, which constructs the required service. The supplied value keeps its Alchemy resource references so the deployment can track prerequisites. A Layer must not replace resource identity with an untracked connection string. The provider still needs to verify readiness, permissions, and extension compatibility.

Inside the running app, a separate Layer constructs its SQL connection pool from the supplied database configuration. This pool belongs to that process and closes when its scope ends. The runtime Layer does not create the PostgreSQL server or run deployment migrations. Missing dependency checks prove that code has a supplied service; they do not prove that a database is reachable or that an extension works.

This pseudocode shows the proposed interface. `PostgresServer`, `PostgresDatabase`, `OrdersDeploy`, `BillingDeploy`, and `DatabaseDependency.layer` are proposed names, not implemented APIs.

```ts
const shared = yield* PostgresServer("shared", { image: essentialImage })
const special = yield* PostgresServer("special", { image: experimentalImage })
const orders = yield* PostgresDatabase("orders", { server: shared })
const billing = yield* PostgresDatabase("billing", { server: shared })

yield* OrdersDeploy.pipe(Effect.provide(DatabaseDependency.layer(orders)))
yield* BillingDeploy.pipe(Effect.provide(DatabaseDependency.layer(billing)))
```

For a new database, changing `server: shared` to `server: special` selects the special build without changing app query code. For an existing database, the same edit requests a data move. Deployment must report the required transfer rather than create an empty replacement. Keep the source writable during the bulk copy. Use the explicit replacement operation in [the PostgreSQL availability plan](postgres-availability-and-migrations.md) for the final handoff.

Physical snapshots and physical backup restores copy the whole PostgreSQL data directory, including all databases on that server. A single-app rehearsal therefore needs a logical database copy or an isolated restored server containing the shared databases. Physical restore alone does not isolate one app's database. Shared servers also share restart, resource, and failure effects. [Filesystem backup scope](https://www.postgresql.org/docs/current/backup-file.html)

The design comparison favored explicit server and database resources for clear ownership. Layer injection supplies the selected database to each app definition. An ambient hosting Layer that implicitly creates app databases would hide database identity and shared migration ownership. Keep one resource declaration path and use Layers to supply those references.

The current [stack](../../tools/alchemy/alchemy.run.ts) reads one app-owned cartridge and creates one Nomad job. Its [job model](../../tools/alchemy/src/Job.ts) has no PostgreSQL resource, secret delivery, or database readiness check. This section describes the next design, not proven functionality.

## What commit and rollback can mean

A migration changes the database schema or stored data. A branch can test a migration on an isolated copy. That copy starts at a fixed production state. Later production writes do not appear in the copy automatically.

The goal is practical continuity during a release. The first procedure below rehearses a migration while production stays writable. The second is a direct clone replacement and causes a long write pause during the final copy and handoff.

1. Production continues to accept writes during rehearsal. Test the migration and candidate app on a branch. To release, apply the same reviewed migration to the current production database, then deploy the app. Commit means release the tested migration code. It does not mean replace production with the old rehearsal copy. Additive schema changes can let the previous app keep working during a release. Destructive changes need separate timing.
2. Direct clone replacement stops production writes during the final clone, migration, validation, and connection change. It can cause a long outage, so use replication for host moves and compatible PostgreSQL upgrades.

These are design conclusions from PostgreSQL's snapshot and recovery behavior. Restoring an earlier state restores that state, not later independent changes. After the promoted clone accepts writes, returning to the old database discards those writes unless a separate, verified transfer process preserves them. The write pause therefore includes the final clone, migration, validation, and connection change. An earlier rehearsal reduces risk but does not remove this pause. [Filesystem backups](https://www.postgresql.org/docs/17/backup-file.html), [Recovery and timelines](https://www.postgresql.org/docs/17/continuous-archiving.html)

PostgreSQL transactions can roll back many schema changes before commit. They are not a full release rollback mechanism. For example, `CREATE INDEX CONCURRENTLY` cannot run in a transaction block. External app effects also need their own treatment. [CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html)

Online migrations can still acquire locks that briefly block writers. The proof must measure lock duration and use lock timeouts to prevent a migration from causing an extended write stall. Continuous application availability is not a guarantee that every write completes without delay. [PostgreSQL locks](https://www.postgresql.org/docs/current/explicit-locking.html)

Logical replication transfers row changes, but it is not a general branch merge. It does not replicate schema commands, sequence state, or large objects. Changed schemas can stop replication. A release that uses replication needs a specific, tested schema and switchover design. [Logical replication restrictions](https://www.postgresql.org/docs/current/logical-replication-restrictions.html)

Nomad job rollback restores job configuration. It does not undo PostgreSQL writes or database migrations.

## Branch implementation choices

| Choice | Custom build fit | Practical limit |
| --- | --- | --- |
| Restore to a separate volume with pgBackRest | Uses ordinary PostgreSQL and the matching custom image | Copies data and replays logs. Measure restore time and disk use. |
| ZFS snapshot and writable clone | Uses ordinary PostgreSQL and the matching custom image | Needs host storage management. Shared blocks reduce initial copy cost, but branch changes consume space. |
| Btrfs writable snapshot | Uses ordinary PostgreSQL and the matching custom image | Snapshots do not include nested subvolumes. All PostgreSQL files need a consistent copy. |
| PostgresAI DBLab Engine | Explicit custom image support | Existing clone manager, but Docker and host storage requirements need evaluation against rootless Podman and lifecycle ownership. |
| Self-hosted Neon | Requires Neon's patched PostgreSQL | Native extensions need verification against the Neon server and storage design. Custom server patches add integration work. |

### Restore branches with pgBackRest

pgBackRest can restore a backup to a different data directory and recover to a chosen point using PostgreSQL's write-ahead log, the record of changes used for crash recovery. This gives a portable first branch implementation without choosing ZFS or Btrfs. The restored instance needs independent credentials, ports, and backup archive behavior. It must not write into production's archive under the same identity. [pgBackRest user guide](https://pgbackrest.org/user-guide.html)

Proposal: prove backup and restore first, using the actual custom image and representative data. This produces both a recovery path and a migration rehearsal database. Local snapshots can improve branch creation time later. A same-host snapshot alone does not protect against loss of the host disk.

### Filesystem branches

PostgreSQL supports a consistent filesystem snapshot of a running server. The snapshot must include the whole database cluster and its write-ahead log. External tablespaces and separate log volumes need simultaneous consistent snapshots, or the server needs to stop during the copy. Startup of a live snapshot performs crash recovery. [Filesystem backup requirements](https://www.postgresql.org/docs/17/backup-file.html)

ZFS provides writable clones of snapshots. `zfs promote` changes snapshot dependency ownership so the original can later be removed. It does not merge database writes or change app connections. [ZFS clone](https://openzfs.github.io/openzfs-docs/man/master/8/zfs-clone.8.html), [ZFS promote](https://openzfs.github.io/openzfs-docs/man/master/8/zfs-promote.8.html)

Btrfs supports writable snapshots with shared unchanged blocks. A snapshot excludes the content of nested subvolumes. One database layout with data and logs together avoids a consistency problem across independent snapshots. [Btrfs subvolume documentation](https://btrfs.readthedocs.io/en/latest/btrfs-subvolume.html)

Proposal: Nix configures storage and a narrowly scoped host operation for snapshots and clones. Rootless database containers receive their own prepared volumes. No database container needs host disk administration rights. This still needs a real trial of user ownership, permissions, recovery, and cleanup.

### DBLab Engine

DBLab already manages thin clones, which share unchanged disk blocks. Its source describes ZFS and LVM storage, API and command-line control, and physical or logical initial copies. The supported-database documentation explicitly permits custom Docker images with extra extensions through `dockerImage`. This is a closer fit for arbitrary ordinary PostgreSQL images than a replacement storage engine. [DBLab source](https://github.com/postgres-ai/database-lab-engine), [Custom image support](https://v2.postgres.ai/docs/database-lab/supported-databases)

Its installation guide requires Docker and ZFS or LVM. That does not prove compatibility with the current rootless Podman model. DBLab creates and manages clone containers itself, so Nomad would not own those individual container lifecycles through the existing provider. Proposal: evaluate DBLab if frequent clones justify a dedicated clone service. Do not assume it supplies promotion with preservation of concurrent production writes. [DBLab installation](https://v2.postgres.ai/docs/dblab-howtos/administration/install-dle-manually)

### Self-hosted Neon

Neon's source provides local branch creation. It uses a patched PostgreSQL server, a pageserver for stored database pages, and safekeepers for durable change logs. This adds services and changes PostgreSQL's storage implementation. Its extension-loading design supports compiled extension artifacts, but it is not a promise that every extension or custom PostgreSQL patch works unchanged. [Neon source and local branch example](https://github.com/neondatabase/neon), [Extension-loading design](https://github.com/neondatabase/neon/blob/main/docs/rfcs/024-extension-loading.md)

Neon's production preview example applies tested migrations to the primary branch after code merge. That is migration rehearsal, not a data merge. Some Neon examples describe branch restore as a merge in an isolated development workflow. Such replacement does not establish that unrelated writes in two databases can be preserved automatically. [Neon preview release workflow](https://neon.com/blog/branching-with-preview-environments), [Neon development branch restore example](https://neon.com/blog/the-hidden-ops-layer-of-agent-platforms)

Proposal: keep Neon as a separate experiment if remote storage and frequent instant branches become requirements. Custom PostgreSQL with restored or filesystem-cloned rehearsal data remains the build choice. The single-host trial proves parts of that workflow; production also needs the planned replacement procedure described in the availability proposal.

## Remaining decisions and proof

The extension set and migration process are described. Exact source versions, PostgreSQL patches, and the pgsodium key mode remain build choices. The goal is practical continuity during compatible schema changes and planned host moves. Keep production writable during bulk copy and migration rehearsal. Use an app reconnect path during primary changes. Ordinary single-node writes have local durability and no host-failure protection. Isolated migration rehearsal followed by online production migrations remains the recommendation. Use expand and contract: add compatible schema first, move the app to that schema, and remove obsolete schema after the rollback window. Returning to the previous app is safe only while the production schema and stored data remain compatible with that app. This procedure gives no general rollback guarantee for destructive migrations.

The proposed first proof is one custom image with `pg_hashids`, `pgsodium`, and pgTAP, an isolated persistent volume, a backup restored to a branch, and a migration tested against that branch. Demonstrate that branch writes do not affect production. Demonstrate recovery and required decryption with the original image. Then prove that old and new apps can run against production's additive schema while writes continue. Online replication-based promotion needs exact proof for the schema, extensions, sequences, and writer handoff. It is not a general commit operation.
