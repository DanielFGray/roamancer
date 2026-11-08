# Object store

## Goal

An app declares that it needs file storage, and the platform gives it its own bucket on an S3-compatible server, with an access key that can reach only that bucket. A staged copy of the app uses the live bucket with its own key. The store is backed up every night with the other platform data.

The first users are dfg.rocks (uploaded materials) and rfchat (icons, emoji and chat attachments). Today dfg.rocks writes files to a host volume, and `ops stage` refuses a service that writes a host volume (`StagedCartridge.ts`, `WritableStorage`).

## Terms

- **Garage.** The S3-compatible server the platform runs (https://garagehq.deuxfleurs.fr). It is one binary, it is in nixpkgs, and its admin API (version 2) creates buckets and keys over HTTP.
- **S3 API.** The port that apps use to read and write objects.
- **Admin API.** The port that the platform uses to create buckets and keys. Apps never get its token.
- **Layout.** Garage's record of which nodes store data and how much. A new Garage node stores nothing until a layout gives it a role.

## Decisions

### Garage, not MinIO

MinIO's community edition went into maintenance mode in December 2025, and its repository is archived. Garage is maintained, is light (it runs in well under 256 MB), and nixpkgs packages it.

### A Nix-built image, like Postgres

`nixos/cynic/garage-image.nix` builds `platform-garage` from the nixpkgs `garage_2` package (Garage 2.4.1 in the pinned nixpkgs; `garage` is still 1.3.1, which has no admin API version 2), the same way `postgres-image.nix` builds `platform-postgres`. The image holds `/etc/garage.toml`, where the `garage` command also finds it, and its start script runs `garage server`. The file holds only settings that are not secret:

- `replication_factor = 1`, because there is one node.
- `s3_region = "garage"`. Garage refuses a request signed for any other region.
- `db_engine = "lmdb"`, the default.
- The S3 API on port 3900, the RPC port on 127.0.0.1:3901, and the admin API on port 3903.

The admin token comes from OpenBao as `GARAGE_ADMIN_TOKEN`, which Garage reads in place of the config file value. It is the server's admin credential, made by `Generated.Secret` like the Postgres and Valkey passwords.

The RPC secret authenticates one Garage node to another. With one node, only the server and the `garage` command inside the same container use it, over 127.0.0.1. So the start script makes a new random 32-byte secret at each start and writes it to a file in the container that `garage.toml` names. It never leaves the container, and OpenBao does not store it. A second node would need a shared secret in OpenBao.

### A server kind and an app need, like Valkey

The platform data cartridge declares a `GarageServer` with its service, as it declares `PostgresServer` and `ValkeyServer`. Compose gives it an admin credential (`secret/data/garage/servers/<server>`), as it does for the other two servers.

An app cartridge declares `"objectStore": {}`. Expand turns it into one `Garage.Bucket` resource. Its provider uses the admin API to:

1. Give the node a role in the layout and apply it, when the layout has no role yet. The role has the zone `dc1` and a capacity of 50 GB. With one node the capacity only has to be larger than zero; it does not limit what the node stores. A later reconcile finds the role and changes nothing.
2. Create the bucket `<app>` when it is missing.
3. Create the key `<app>` when OpenBao has no key for the app, and store its id and secret in OpenBao at `secret/data/garage/<app>`. Garage shows a secret key only once, when it creates the key, so OpenBao is the only copy. When OpenBao has a key that Garage does not, the provider creates a new key and replaces the stored value.
4. Allow the key to read and write that bucket and no other.

A secret reference `{ "_tag": "ObjectStoreCredentials", ... }` renders the endpoint, region, bucket name, key id and secret key into environment names that the app chooses. Clients must use path-style addresses (`<endpoint>/<bucket>/<key>`), because the store has no host name for each bucket. The endpoint comes from the Nomad service of the S3 API, as the Valkey URL comes from the Valkey service.

### A job can register a second port

A Garage job needs two ports: the S3 API for apps and the admin API for the platform. Today a job has one port, which Nomad registers as the service `<job>`. A job gains an optional list of more ports. Each entry has a name and a container port, gets a dynamic host port, and Nomad registers it as the service `<job>-<name>`. Garage declares one more port, `admin`, so the provider finds the admin API as the service `garage-admin`.

### Staged copies share the live bucket

A staged copy gets its own key, `<app>-staged`, which can read and write the live bucket `<app>`. It gets no bucket of its own and no copy of the objects. Its database is a copy of the live database, so its rows name the live objects, and they work without a copy step. The key is its own so that removing the staged copy revokes only the staged key.

The owner chose this on 2026-11-08 and accepted the risk: a staged copy can overwrite or delete a live object, and an upload in a staged copy lands in the live bucket. An app that names each object by a hash of its content (dfg.rocks does) cannot overwrite another object, and an upload from a staged copy leaves only an object that no live row names. A delete in a staged copy still removes the live object. `staged-releases.md` allows this exception.

### Garage runs on cynic

Postgres, Valkey and the nightly restic backups run on cynic, so the backup reads the Garage volume on the same machine.

### Apps serve their own files

The store has no public route. An app reads an object with its key and streams it to the browser through its own route. A presigned URL does not work, because it names the store's own address, which no browser can reach. So the store needs no TLS and no host name, and the key is the only way to read a bucket.

### Backups

Garage stores objects as blocks that it never changes after it writes them, and it keeps its metadata in LMDB. A copy of a live LMDB file can be torn. So each night the backup first runs `garage meta snapshot` in the container (as nomad, the way the Postgres dump runs `pg_dumpall`), then restic backs up the whole volume except the live database. The node key and the cluster layout are small files beside the database, and a restore needs them too. A restore puts back the volume and makes the newest snapshot the live database (`nixos/backup-operations.md`).

The snapshot and the data match except for writes during the restic run. An object written after the snapshot leaves blocks with no metadata, which Garage can remove. An object deleted after the snapshot can lose its blocks: Garage deletes a block only some time after nothing names it, so this needs a delete during the run and a restore of that night's backup.

## Work

Items 1 to 8 are done. `ops image garage-image` builds and pushes the image.

1. Job: a list of more ports, each registered as `<job>-<name>`.
2. Image: `garage-image.nix`, the host volume, and its Nomad ACL entry.
3. Cartridge: `GarageServer` in the platform data cartridge.
4. Provider: `Garage.Bucket`, with layout, bucket, key and permission steps.
5. Secret reference: `ObjectStoreCredentials`.
6. Staged copies: the `<app>-staged` key on the live bucket.
7. Backups and restore steps in `nixos/backup-operations.md`.
8. README: the memory table and the cartridge reference.
9. dfg.rocks: move `server/services/storageService.ts` to the S3 API and drop its host volume. rfchat does the same in its own repository.
