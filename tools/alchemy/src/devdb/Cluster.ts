/**
 * Shared local Postgres 17 cluster for `ops dev db`: the same image production
 * pins in platform/data/cartridge.json, container ops-dev-pg17, provision +
 * list + reset + down.
 */
import * as path from "node:path";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Cartridge from "../Cartridge.ts";
import { OpsError, output, run, succeeds } from "../Exec.ts";
import {
  provisionPostgresDatabase,
  type PostgresDatabaseDeclaration,
} from "../PostgresProvisioning.ts";

export const CONTAINER = "ops-dev-pg17";
export const VOLUME = "ops-dev-pg17-data";
export const HOST = "127.0.0.1";
export const PORT = 5417;
export const LABEL_KEY = "server-ansible.ops-dev-db";
export const LABEL_VALUE = "17";
export const PGDATA = "/var/lib/postgresql/data/pgdata";

/** tools/alchemy — holds platform/data/cartridge.json. */
const alchemyRoot = () => path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

const adminLayer = (adminPassword: Redacted.Redacted<string>) => (database: string) =>
  PgClient.layerFrom(
    PgClient.makeClient({
      host: HOST,
      port: PORT,
      database,
      username: "postgres",
      password: adminPassword,
      applicationName: "ops-dev-db",
    }),
  );

/** The Postgres server image the platform cartridge pins (digest reference). */
export const platformPostgresImage = Effect.fn("devdb.platformPostgresImage")(function* () {
  const cartridge = yield* Cartridge.decodeFile(
    path.join(alchemyRoot(), "platform/data/cartridge.json"),
    Cartridge.Cartridge,
  );
  const server = cartridge.servers.find((entry) => entry._tag === "PostgresServer");
  if (server === undefined) {
    return yield* new OpsError({
      message: "platform/data/cartridge.json declares no PostgresServer",
    });
  }
  return server.service.image;
});

/** Pull the platform pin when this workstation does not already have it. */
export const ensureImage = Effect.fn("devdb.ensureImage")(function* () {
  const image = yield* platformPostgresImage();
  const present = yield* succeeds("docker", ["image", "inspect", image]);
  if (!present) yield* run("docker", ["pull", image]);
  return image;
});

const containerExists = Effect.fn("devdb.containerExists")(function* () {
  return yield* succeeds("docker", ["inspect", CONTAINER]);
});

const containerLabel = Effect.fn("devdb.containerLabel")(function* () {
  const text = (yield* output("docker", [
    "inspect",
    "-f",
    `{{index .Config.Labels "${LABEL_KEY}"}}`,
    CONTAINER,
  ])).trim();
  return text;
});

/** Refuse reset/psql/list against a container we do not manage. */
export const requireManagedContainer = Effect.fn("devdb.requireManagedContainer")(function* () {
  if (!(yield* containerExists())) {
    return yield* new OpsError({
      message: `container ${CONTAINER} is not running; run ops dev db up first`,
    });
  }
  const label = yield* containerLabel();
  if (label !== LABEL_VALUE) {
    return yield* new OpsError({
      message: `container ${CONTAINER} is not the managed ops-dev-pg17 cluster (missing label ${LABEL_KEY}=${LABEL_VALUE})`,
    });
  }
});

const waitReady = Effect.fn("devdb.waitReady")(function* () {
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = yield* succeeds("docker", [
      "exec",
      CONTAINER,
      "pg_isready",
      "-U",
      "postgres",
      "-h",
      "127.0.0.1",
    ]);
    if (ready) return;
    yield* Effect.sleep("500 millis");
  }
  return yield* new OpsError({ message: `${CONTAINER} did not become ready` });
});

/**
 * The platform image runs as uid 999. A fresh Docker named volume is root-owned,
 * so initdb cannot create PGDATA until the mount is chowned (Nomad hosts do this
 * with a state directory; locally we fix the volume once using the platform image).
 */
const ensureVolumeOwnership = Effect.fn("devdb.ensureVolumeOwnership")(function* (image: string) {
  yield* run("docker", ["volume", "create", VOLUME]);
  yield* run("docker", [
    "run",
    "--rm",
    "--user",
    "0",
    "--entrypoint",
    "chown",
    "-v",
    `${VOLUME}:/data`,
    image,
    "-R",
    "999:999",
    "/data",
  ]);
  yield* run("docker", [
    "run",
    "--rm",
    "--user",
    "0",
    "--entrypoint",
    "chmod",
    "-v",
    `${VOLUME}:/data`,
    image,
    "700",
    "/data",
  ]);
});

export const ensureContainer = Effect.fn("devdb.ensureContainer")(function* (
  adminPassword: Redacted.Redacted<string>,
) {
  const image = yield* ensureImage();
  if (yield* containerExists()) {
    const label = yield* containerLabel();
    if (label !== LABEL_VALUE) {
      return yield* new OpsError({
        message: `a container named ${CONTAINER} exists without label ${LABEL_KEY}=${LABEL_VALUE}; refuse to reuse it`,
      });
    }
    yield* run("docker", ["start", CONTAINER]);
  } else {
    yield* ensureVolumeOwnership(image);
    // -e NAME (no =value): docker inherits NAME from this process env — keeps the
    // password off the argv that `ps` and Exec error text would otherwise show.
    yield* run(
      "docker",
      [
        "run",
        "-d",
        "--name",
        CONTAINER,
        "--label",
        `${LABEL_KEY}=${LABEL_VALUE}`,
        "--restart",
        "unless-stopped",
        "-e",
        "POSTGRES_PASSWORD",
        "-e",
        `PGDATA=${PGDATA}`,
        "-v",
        `${VOLUME}:${path.dirname(PGDATA)}`,
        "-p",
        `${HOST}:${PORT}:5432`,
        image,
      ],
      { POSTGRES_PASSWORD: Redacted.value(adminPassword) },
    );
  }
  yield* waitReady();
});

export const stopContainer = Effect.fn("devdb.stopContainer")(function* () {
  yield* requireManagedContainer();
  yield* run("docker", ["stop", CONTAINER]);
});

export const provisionAll = Effect.fn("devdb.provisionAll")(function* (
  declarations: ReadonlyArray<PostgresDatabaseDeclaration>,
  adminPassword: Redacted.Redacted<string>,
) {
  const layer = adminLayer(adminPassword);
  yield* Effect.forEach(
    declarations,
    (declaration) =>
      provisionPostgresDatabase(declaration, layer).pipe(
        Effect.mapError(
          (error) =>
            new OpsError({
              message:
                error._tag === "PostgresProvisioningError"
                  ? error.message
                  : `postgres provision failed for ${declaration.name}`,
            }),
        ),
      ),
    { discard: true },
  );
});

const listDatabaseRows = Effect.fn("devdb.listDatabaseRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly name: string; readonly owner: string }>`
    SELECT d.datname AS name, pg_get_userbyid(d.datdba) AS owner
    FROM pg_database d
    WHERE d.datistemplate = false
    ORDER BY d.datname
  `;
});

export const listDatabases = Effect.fn("devdb.listDatabases")(function* (
  adminPassword: Redacted.Redacted<string>,
) {
  yield* requireManagedContainer();
  return yield* listDatabaseRows().pipe(
    Effect.provide(adminLayer(adminPassword)("postgres")),
    Effect.mapError(() => new OpsError({ message: `could not list databases on ${CONTAINER}` })),
  );
});

const dropExistingDatabase = Effect.fn("devdb.dropExistingDatabase")(function* (name: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP DATABASE ${sql(name)} WITH (FORCE)`;
});

const dropDatabase = Effect.fn("devdb.dropDatabase")(function* (name: string) {
  const sql = yield* SqlClient.SqlClient;
  const found = yield* sql<{ readonly name: string }>`
    SELECT datname AS name FROM pg_database WHERE datname = ${name}
  `;
  yield* Option.match(Arr.head(found), {
    onNone: () => Effect.void,
    onSome: () => dropExistingDatabase(name),
  });
});

const dropThenProvision = Effect.fn("devdb.dropThenProvision")(function* (
  declaration: PostgresDatabaseDeclaration,
  adminPassword: Redacted.Redacted<string>,
) {
  const layer = adminLayer(adminPassword);
  yield* dropDatabase(declaration.name).pipe(
    Effect.provide(layer("postgres")),
    Effect.mapError(() => new OpsError({ message: `could not drop database ${declaration.name}` })),
  );
  yield* provisionPostgresDatabase(declaration, layer).pipe(
    Effect.mapError(
      (error) =>
        new OpsError({
          message:
            error._tag === "PostgresProvisioningError"
              ? error.message
              : `re-provision failed for ${declaration.name}`,
        }),
    ),
  );
});

export const resetDatabase = Effect.fn("devdb.resetDatabase")(function* (
  declaration: PostgresDatabaseDeclaration,
  adminPassword: Redacted.Redacted<string>,
) {
  yield* requireManagedContainer();
  yield* dropThenProvision(declaration, adminPassword);
});

export const runPsql = Effect.fn("devdb.runPsql")(function* (input: {
  readonly database: string;
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
}) {
  yield* requireManagedContainer();
  yield* run(
    "docker",
    [
      "exec",
      "-e",
      "PGPASSWORD",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      input.username,
      "-d",
      input.database,
    ],
    { PGPASSWORD: Redacted.value(input.password) },
  );
});
