/**
 * The developer databases of one app, as both ends of `ops dev db` derive them.
 *
 * Each cartridge database gets a dev instance on the app's Postgres server, named by
 * `instanceDatabaseName(app, "dev", database)`: giglist's `giglist` becomes `giglist_dev`.
 * Each dev database also gets `<dev>_shadow` (graphile-migrate) and `<dev>_test` (app test
 * suites), with the dev database's roles and extensions. The workstation sends only the app
 * name and its entries (DevDbRequest); the host derives every name itself, so a request can
 * name no live database.
 *
 * Managed env writes SHADOW_DATABASE_URL and TEST_DATABASE_URL as the migration login on
 * those databases, and ROOT_DATABASE_URL as the same login on `postgres`: graphile-migrate
 * commit drops and recreates the shadow through it, so the dev migration login has CREATEDB.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import {
  AppName,
  DatabaseName,
  instanceDatabaseName,
  postgresLoginRole,
  postgresNamespaceIssues,
} from "../Cartridge.ts";
import { ExtensionName, postgresRoles } from "../PostgresDatabase.ts";
import type {
  PostgresDatabaseDeclaration,
  PostgresLoginDeclaration,
} from "../PostgresProvisioning.ts";
import * as Redacted from "effect/Redacted";
import { Verifier } from "./Scram.ts";
import { type DevDbCartridge, isPostgresCredentials } from "./DevDbCartridge.ts";

/** Where the workstation reaches the dev databases: the local end of the SSH tunnel. */
export const tunnelHost = "127.0.0.1";
export const tunnelPort = 5417;

/** What `ops dev db` sends the host: the app, its cartridge's postgres entries, and their logins. */
export const DevDbRequest = S.Struct({
  app: AppName,
  postgres: S.Array(
    S.Struct({
      database: DatabaseName,
      extensions: S.Array(ExtensionName),
      // SCRAM verifiers of the dev database's two logins.
      logins: S.Struct({ api: Verifier, migration: Verifier }),
    }),
  ),
}).check(
  S.makeFilter((request) => {
    const issues = postgresNamespaceIssues(
      request.app,
      request.postgres.map((entry) => entry.database),
    );
    return issues.length === 0 ? undefined : issues;
  }),
);
export type DevDbRequest = typeof DevDbRequest.Type;

type DevTarget = "live" | "shadow" | "test";

/** The dev database of one cartridge database, with its shadow and test databases. */
export const devDatabaseNames = (app: string, database: string) =>
  withScratchDatabases(instanceDatabaseName(app, "dev", database));

/** A dev database with the names of its shadow and test databases. */
const withScratchDatabases = (live: string): Record<DevTarget, string> => ({
  live,
  shadow: `${live}_shadow`,
  test: `${live}_test`,
});

/** Every name the request owns: each entry's dev, shadow and test databases. */
export const ownedDatabases = (request: DevDbRequest): ReadonlyArray<string> =>
  request.postgres.flatMap((entry) => Object.values(devDatabaseNames(request.app, entry.database)));

/** The two logins of one dev database, the API login first. */
export const devLoginRoles = (devDatabase: string): ReadonlyArray<string> => [
  postgresLoginRole(devDatabase, "api"),
  postgresLoginRole(devDatabase, "migration"),
];

/** Every login the request's dev databases use. */
export const requestLoginRoles = (request: DevDbRequest): ReadonlyArray<string> =>
  request.postgres.flatMap((entry) =>
    devLoginRoles(devDatabaseNames(request.app, entry.database).live),
  );

/** The logins of one dev database. Each `password` is a SCRAM verifier, not a plaintext. */
export const loginDeclarations = (
  devDatabase: string,
  logins: DevDbRequest["postgres"][number]["logins"],
): ReadonlyArray<PostgresLoginDeclaration> => {
  const roles = postgresRoles(devDatabase);
  return [
    {
      name: postgresLoginRole(devDatabase, "api"),
      memberOf: roles.visitor,
      inherit: false,
      createDatabases: false,
      password: Redacted.make(logins.api),
    },
    {
      name: postgresLoginRole(devDatabase, "migration"),
      memberOf: roles.owner,
      inherit: true,
      createDatabases: true,
      password: Redacted.make(logins.migration),
    },
  ];
};

const declarationsFor = (
  app: string,
  entry: DevDbRequest["postgres"][number],
  targets: ReadonlyArray<DevTarget>,
): ReadonlyArray<PostgresDatabaseDeclaration> => {
  const names = devDatabaseNames(app, entry.database);
  const roles = postgresRoles(names.live);
  return targets.map((target) => ({
    name: names[target],
    ownerRole: roles.owner,
    visitorRole: roles.visitor,
    extensions: entry.extensions,
    logins: loginDeclarations(names.live, entry.logins),
  }));
};

/** Every dev database of the request, each followed by its shadow and test databases. */
export const databaseDeclarations = (
  request: DevDbRequest,
): ReadonlyArray<PostgresDatabaseDeclaration> =>
  request.postgres.flatMap((entry) =>
    declarationsFor(request.app, entry, ["live", "shadow", "test"]),
  );

/**
 * What `reset <name>` provisions again: a dev database with its shadow and test databases,
 * or one shadow or test database alone. None when the request owns no database of that name.
 */
export const declarationsForDatabase = (
  request: DevDbRequest,
  name: string,
): Option.Option<ReadonlyArray<PostgresDatabaseDeclaration>> =>
  Arr.head(
    request.postgres.flatMap((entry) => {
      const names = devDatabaseNames(request.app, entry.database);
      const targets: ReadonlyArray<DevTarget> =
        names.live === name
          ? ["live", "shadow", "test"]
          : names.shadow === name
            ? ["shadow"]
            : names.test === name
              ? ["test"]
              : [];
      return targets.length === 0 ? [] : [declarationsFor(request.app, entry, targets)];
    }),
  );

/** One .env key ops dev db writes. `database` is always the dev database the key names. */
export type ManagedEnvKey =
  | {
      readonly kind: "url" | "username" | "password" | "shadowUrl" | "testUrl" | "rootUrl";
      readonly env: string;
      readonly database: string;
      readonly login: "api" | "migration";
    }
  | { readonly kind: "databaseName"; readonly env: string; readonly database: string }
  | {
      readonly kind: "databaseRole";
      readonly env: string;
      readonly database: string;
      readonly role: "owner" | "visitor";
    };

/**
 * Every env binding that names a cartridge database, unique by env name, pointed at that
 * database's dev instance: PostgresCredentials across services and migrate tasks, and the
 * environment entries that carry a database name or one of its roles. The dev roles live on
 * the same server as the live ones, so a migration that read a live role name would grant
 * to the live database's roles. Every other environment entry stays the app's own.
 */
export const managedEnvKeys = (cartridge: DevDbCartridge): ReadonlyArray<ManagedEnvKey> => {
  const dev = (database: string) => devDatabaseNames(cartridge.name, database).live;
  const databases = new Set(cartridge.postgres.map((entry) => entry.database));
  const byEnv = new Map<string, ManagedEnvKey>();
  for (const service of cartridge.services) {
    for (const entry of service.environment) {
      if ("database" in entry) {
        byEnv.set(entry.name, {
          kind: "databaseRole",
          env: entry.name,
          database: dev(entry.database),
          role: entry.role,
        });
      } else if ("value" in entry && databases.has(entry.value)) {
        byEnv.set(entry.name, {
          kind: "databaseName",
          env: entry.name,
          database: dev(entry.value),
        });
      }
    }
    for (const secret of [...service.secrets, ...(service.migrate?.secrets ?? [])]) {
      if (!isPostgresCredentials(secret)) continue;
      const database = dev(secret.database);
      const { login } = secret;
      if (secret.urlEnv !== undefined) {
        byEnv.set(secret.urlEnv, { kind: "url", env: secret.urlEnv, database, login });
      }
      if (secret.usernameEnv !== undefined) {
        byEnv.set(secret.usernameEnv, {
          kind: "username",
          env: secret.usernameEnv,
          database,
          login,
        });
      }
      if (secret.passwordEnv !== undefined) {
        byEnv.set(secret.passwordEnv, {
          kind: "password",
          env: secret.passwordEnv,
          database,
          login,
        });
      }
    }
  }
  // One SHADOW_ / TEST_ / ROOT_ URL per cartridge database (graphile-migrate / vitest standard names).
  for (const entry of cartridge.postgres) {
    const database = dev(entry.database);
    for (const [kind, env] of [
      ["shadowUrl", "SHADOW_DATABASE_URL"],
      ["testUrl", "TEST_DATABASE_URL"],
      ["rootUrl", "ROOT_DATABASE_URL"],
    ] as const) {
      byEnv.set(env, { kind, env, database, login: "migration" });
    }
  }
  return [...byEnv.values()];
};

export const connectionUrl = (input: {
  readonly username: string;
  readonly password: string;
  readonly database: string;
  /** PostgreSQL startup options, such as `-c role=none`. */
  readonly options?: string;
}) =>
  `postgresql://${encodeURIComponent(input.username)}:${encodeURIComponent(input.password)}@${tunnelHost}:${tunnelPort}/${input.database}?sslmode=disable${input.options === undefined ? "" : `&options=${encodeURIComponent(input.options)}`}`;

/** Values to write for the managed keys, from login role names and passwords. */
export const managedEnvValues = (
  keys: ReadonlyArray<ManagedEnvKey>,
  passwordFor: (role: string) => string,
): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const key of keys) {
    if (key.kind === "databaseName") {
      values[key.env] = key.database;
      continue;
    }
    if (key.kind === "databaseRole") {
      values[key.env] = postgresRoles(key.database)[key.role];
      continue;
    }
    const role = postgresLoginRole(key.database, key.login);
    const names = withScratchDatabases(key.database);
    if (key.kind === "username") values[key.env] = role;
    else if (key.kind === "password") values[key.env] = passwordFor(role);
    else if (key.kind === "shadowUrl")
      values[key.env] = connectionUrl({
        username: role,
        password: passwordFor(role),
        database: names.shadow,
      });
    else if (key.kind === "testUrl")
      values[key.env] = connectionUrl({
        username: role,
        password: passwordFor(role),
        database: names.test,
      });
    else if (key.kind === "rootUrl")
      // The migration login's sessions default to the owner role, which has no CREATEDB;
      // role=none keeps this session on the login itself.
      values[key.env] = connectionUrl({
        username: role,
        password: passwordFor(role),
        database: "postgres",
        options: "-c role=none",
      });
    else
      values[key.env] = connectionUrl({
        username: role,
        password: passwordFor(role),
        database: key.database,
      });
  }
  return values;
};

export const DevDbAction = S.Union([
  S.TaggedStruct("Up", {}),
  S.TaggedStruct("Reset", { database: S.String }),
  S.TaggedStruct("List", {}),
]);
export type DevDbAction = typeof DevDbAction.Type;

/** dev-db: one action on an app's dev databases (devdb/Host.ts runs it). */
export const DevDbSubmit = S.Struct({
  command: S.Literals(["dev-db"]),
  request: DevDbRequest,
  action: DevDbAction,
});
export type DevDbSubmit = typeof DevDbSubmit.Type;

/**
 * An action on every app's dev databases, found by their markers. `Drop` removes an app's
 * dev databases and their roles: all of them, or those of one cartridge database.
 */
export const DevDbClusterAction = S.Union([
  S.TaggedStruct("Stale", {}),
  S.TaggedStruct("Drop", { app: AppName, database: S.optionalKey(DatabaseName) }),
]);
export type DevDbClusterAction = typeof DevDbClusterAction.Type;

/** dev-db-cluster: an action that needs no cartridge, so it may name an app that is gone. */
export const DevDbClusterSubmit = S.Struct({
  command: S.Literals(["dev-db-cluster"]),
  action: DevDbClusterAction,
});
export type DevDbClusterSubmit = typeof DevDbClusterSubmit.Type;

/**
 * The comment `up` and `reset` write on each dev database: whose it is and when `up` last
 * provisioned it. Postgres records no last-login time, so this date is what says a dev
 * database is stale. Any role that owns a database can change its comment, so the host
 * trusts a marker only when the database's name and owner are the ones it derives from it.
 */
export const DevDbMarker = S.Struct({
  opsDevDb: S.Struct({ app: AppName, database: DatabaseName, lastUp: S.String }),
});
export type DevDbMarker = typeof DevDbMarker.Type;

/**
 * The dev database `name` with the roles that may own it, when the marker's app and
 * database derive that name; none for a marker that claims a name it does not derive.
 */
export const markedDevDatabase = (name: string, marker: DevDbMarker) => {
  const { app, database } = marker.opsDevDb;
  const names = devDatabaseNames(app, database);
  const derived =
    postgresNamespaceIssues(app, [database]).length === 0 && Object.values(names).includes(name);
  return derived
    ? Option.some({
        live: names.live,
        owners: [postgresRoles(names.live).owner, postgresLoginRole(names.live, "migration")],
      })
    : Option.none();
};
