# PostgreSQL availability and migrations

Research date: 2026-10-11. This is a proposed design for Alchemy, Nomad, and custom PostgreSQL builds. The replacement operation is not implemented.

## Current single server and target availability

The current deployment has one PostgreSQL server. The backup command writes a `pg_dumpall` archive under `/opt/backups/postgres` on that host. Off-host copies and restores are not yet proven. A server or host restart interrupts the database because no live replacement exists. The goal for planned moves is practical continuity, with a few-second read-only interval at the final handoff.

Keep the service available while the replacement copies data. A few-second read-only interval for the final handoff is acceptable. PostgreSQL cannot move an open client connection or an in-flight transaction to another server, so clients must reconnect after promotion.

An always-running replica can shorten a planned move. A replica created only for a move does not protect the service from a host failure before it exists. The planned replacement procedure below is a foundation for explicit data movement. It is not automatic failover.

The transitional move uses temporary replication. It follows create-before-destroy: prepare the replacement before removing the original. A database also needs the explicit data and primary handoff described below. Temporary replication does not provide recovery from a sudden host loss before the replica exists. Backups provide a separate recovery path.

The proposed infrastructure-as-code model has one stable logical PostgreSQL cluster and a variable set of members. A cluster includes all databases served by the PostgreSQL process. Apps depend on database access within that cluster, through a stable address for its current primary. Adding or removing a member changes placement without changing the app dependency.

Alchemy declares members, images, storage, and access. Nomad runs those members. An explicit replacement operation owns the data copy and primary change. Ordinary reconciliation must not promote a member, delete the current primary's storage, or move traffic merely because a placement or image declaration changed. These are proposed responsibilities, not existing provider APIs.

The operation needs one exclusive owner and a durable record of its completed steps, source, target, and primary identity. It resumes by checking actual database state before repeating an action. Promotion and routing changes require explicit recorded completion. This prevents an interrupted deployment from restarting the old primary or promoting twice.

## Planned replacement

The primary needs `wal_level = replica`, enough WAL sender and replication slot capacity, and a dedicated replication role that can connect from the target. The operation also needs network access between the hosts.

The proposed operation has these steps:

1. Start a new member on the target host, with separate persistent storage. Verify PostgreSQL, extension libraries, and pgsodium key compatibility.
2. Create a persistent replication slot. Copy the entire cluster with `pg_basebackup -X stream -S <slot>`. Configure the standby to use the same slot after the copy. Production continues to accept writes during the copy. [PostgreSQL base backups](https://www.postgresql.org/docs/current/app-pgbasebackup.html)
3. Retain WAL until the replica has received it. Bound and monitor the move-specific slot so a slow replica cannot fill the primary's disk. If the slot limit removes WAL the replica needs, rebuild the replica. Remove the move-specific slot after replacement. [PostgreSQL replication slots](https://www.postgresql.org/docs/current/warm-standby.html#STREAMING-REPLICATION-SLOTS), [WAL retention limits](https://www.postgresql.org/docs/current/runtime-config-replication.html#GUC-MAX-SLOT-WAL-KEEP-SIZE)
4. Pause every source of production writes, including workers, scheduled jobs, migrations, and existing sessions. Drain or abort transactions. Record `pg_current_wal_flush_lsn()` from the source only after writer exclusion is established.
5. Keep the replica connected while you stop the source cleanly. PostgreSQL does not complete shutdown until it transfers outstanding WAL to connected standbys. After shutdown, compare the replica's last received log sequence number (LSN) with the source position and its last replayed LSN. The received LSN must be at or past the source position, and the replayed LSN must match the received LSN. Fence the source so Nomad or systemd cannot restart it as a writable primary. If clean shutdown, complete replay, or fencing cannot be proved, stop the operation. [PostgreSQL standby shutdown behavior](https://www.postgresql.org/docs/current/warm-standby.html#SYNCHRONOUS-REPLICATION), [PostgreSQL standby recovery functions](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-RECOVERY-CONTROL)
6. Promote the target and verify that it accepts writes. Move the stable primary address, reconnect app pools, and resume writers. Existing connections cannot transfer between servers. [PostgreSQL recovery and promotion functions](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-RECOVERY-CONTROL)
7. Retain the stopped source until target validation and backups pass. To move back, rebuild the old host as a replica of the new primary and repeat the operation. Use a fresh base backup, or prove the prerequisites for `pg_rewind`, which repairs a data directory after histories diverge. Switching traffic to the stale old data directory loses newer writes. [PostgreSQL pg_rewind](https://www.postgresql.org/docs/current/app-pgrewind.html)

This procedure pauses writes during the final handoff and requires clients to reconnect. Keep reads available from the source or the read-only standby where possible. The goal is a few-second read-only interval, not an uninterrupted database connection. Copy duration depends on data size and available disk, network, and CPU capacity. The operation must verify capacity before allocating the temporary member. It copies all databases on a shared cluster, not one app's database.

## IaC boundaries

Alchemy should declare the logical database, image, access, and storage. Nomad should place and run its members. A planned replacement must be an explicit operation that copies data and changes the primary endpoint. A normal desired-state update must not create an empty database, promote a member, or delete the current primary's storage.

Keep one owner for a replacement operation. Record its source, target, and completed actions so it can inspect live state and resume safely. Keep a stable endpoint for applications. Preserve the source until the target serves requests and a backup completes. These rules support the planned move without selecting a permanent replica manager or cluster size.

An asynchronous replica can miss recent writes if its source fails before they reach the target. Synchronous replication reduces that risk but adds write latency and can block writes when a required replica is unavailable. The current single server has local durability only. Leave permanent failure handling as an open design choice. [PostgreSQL synchronous replication](https://www.postgresql.org/docs/current/warm-standby.html#SYNCHRONOUS-REPLICATION)

A physical replica requires compatible PostgreSQL versions, architecture, and extension libraries. Major PostgreSQL versions require a different transfer method. Keep the same tested custom image for ordinary host moves. All members need the original pgsodium keys to decrypt existing data, supplied through OpenBao references. [PostgreSQL standby compatibility](https://www.postgresql.org/docs/current/warm-standby.html#STANDBY-PLANNING), [pgsodium server keys](https://github.com/michelp/pgsodium#server-key-management)

## Schema migrations and major upgrades

Physical replicas receive schema changes and remain read-only until promotion. Failover cannot undo a migration or provide an independently migrated database branch. [PostgreSQL hot standby](https://www.postgresql.org/docs/current/hot-standby.html)

Each database has one deployment migration owner. App Layers manage connection pools rather than competing to migrate at startup. The owner records migration identifiers and checksums, obtains a database lock, and checks the record again before acting. Transactional schema changes commit with their migration record. After an uncertain commit, inspect that record before retrying. Reacquire locks after reconnecting.

Use compatible schema changes. Add structure, copy existing data in resumable batches, move apps to the new structure, and remove old structure after the rollback period. Test locks and write delays under load. Nontransactional work needs state inspection before resuming. An interrupted concurrent index build can leave an invalid index that needs documented cleanup. [PostgreSQL locks](https://www.postgresql.org/docs/current/explicit-locking.html), [Concurrent index creation](https://www.postgresql.org/docs/current/sql-createindex.html)

A branch is an isolated rehearsal copy. Apply its tested migration code to current production. Replacing production with the branch discards intervening writes. Keep backups outside database hosts and prove restore separately because replicas also receive deletions and mistakes.

A major upgrade or incompatible extension change requires a separate target cluster and a different transfer plan. Logical replication transfers row changes across versions but omits schema changes, sequence state, and large objects. Verify custom types and patches. The final handoff still needs writer exclusion and complete data transfer. Once the target receives new writes, returning to the old cluster requires a proved reverse transfer or restore plan. [PostgreSQL upgrades](https://www.postgresql.org/docs/current/upgrading.html), [Logical replication restrictions](https://www.postgresql.org/docs/current/logical-replication-restrictions.html)

## Required proof

Prove the custom image with `pg_hashids`, `pgsodium`, and pgTAP. Restore a backup and verify encrypted data with the original pgsodium keys.

On two disposable hosts, copy a live database while it accepts writes. Exercise a short read-only handoff, final WAL check, promotion, stable endpoint update, client reconnect, and return move. Verify that the operation loses no acknowledged writes and that the old primary cannot accept writes after promotion.

Interrupt each promotion and routing step. Confirm that the system resumes from observed database state and never promotes an incomplete replica. Test WAL retention limits, old-primary fencing, recovery of a former primary, and a second switch back. Rehearse a compatible schema release with concurrent writes and an interrupted migration owner. None of this proof has passed yet.
