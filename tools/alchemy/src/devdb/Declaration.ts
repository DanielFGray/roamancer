/**
 * Cartridge → provisioning declarations and the .env keys PostgresCredentials name.
 * Each cartridge database also gets `<name>_shadow` (graphile-migrate) and
 * `<name>_test` (app test suites), same roles and extensions. Managed env writes
 * SHADOW_DATABASE_URL and TEST_DATABASE_URL as the migration login on those DBs, and
 * ROOT_DATABASE_URL as the same login on `postgres`: graphile-migrate commit drops and
 * recreates the shadow through it, so the dev migration login has CREATEDB.
 */
import { postgresLoginRole } from "../Cartridge.ts";
import { postgresRoles } from "../PostgresDatabase.ts";
import type {
  PostgresDatabaseDeclaration,
  PostgresLoginDeclaration,
} from "../PostgresProvisioning.ts";
import type * as Redacted from "effect/Redacted";
import { HOST, PORT } from "./Cluster.ts";
import { type DevDbCartridge, isPostgresCredentials } from "./DevDbCartridge.ts";

export type ManagedEnvKey = {
  readonly kind: "url" | "username" | "password" | "shadowUrl" | "testUrl" | "rootUrl";
  readonly env: string;
  readonly database: string;
  readonly login: "api" | "migration";
};

/** The shadow database graphile-migrate uses for one cartridge database. */
export const shadowDatabaseName = (database: string) => `${database}_shadow`;

/** The scratch database app DB tests use for one cartridge database. */
export const testDatabaseName = (database: string) => `${database}_test`;

/** Live / shadow / test names derived from one cartridge database entry. */
export const derivedDatabaseNames = (database: string) => ({
  live: database,
  shadow: shadowDatabaseName(database),
  test: testDatabaseName(database),
});

/**
 * Resolve a reset/up target: the live name, or a derived `_shadow` / `_test`
 * name, back to the cartridge entry and which declarations to (re)provision.
 */
export const resolveDatabaseTarget = (
  cartridge: DevDbCartridge,
  name: string,
):
  | {
      readonly entry: DevDbCartridge["postgres"][number];
      readonly targets: ReadonlyArray<"live" | "shadow" | "test">;
    }
  | undefined => {
  const live = cartridge.postgres.find((candidate) => candidate.database === name);
  if (live !== undefined) {
    return { entry: live, targets: ["live", "shadow", "test"] };
  }
  const asShadow = cartridge.postgres.find(
    (candidate) => shadowDatabaseName(candidate.database) === name,
  );
  if (asShadow !== undefined) {
    return { entry: asShadow, targets: ["shadow"] };
  }
  const asTest = cartridge.postgres.find(
    (candidate) => testDatabaseName(candidate.database) === name,
  );
  if (asTest !== undefined) {
    return { entry: asTest, targets: ["test"] };
  }
  return undefined;
};

/** Every PostgresCredentials env binding across services and migrate tasks, unique by env name. */
export const managedEnvKeys = (cartridge: DevDbCartridge): ReadonlyArray<ManagedEnvKey> => {
  const byEnv = new Map<string, ManagedEnvKey>();
  for (const service of cartridge.services) {
    for (const secret of [...service.secrets, ...(service.migrate?.secrets ?? [])]) {
      if (!isPostgresCredentials(secret)) continue;
      const { database, login } = secret;
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
    byEnv.set("SHADOW_DATABASE_URL", {
      kind: "shadowUrl",
      env: "SHADOW_DATABASE_URL",
      database: entry.database,
      login: "migration",
    });
    byEnv.set("TEST_DATABASE_URL", {
      kind: "testUrl",
      env: "TEST_DATABASE_URL",
      database: entry.database,
      login: "migration",
    });
    byEnv.set("ROOT_DATABASE_URL", {
      kind: "rootUrl",
      env: "ROOT_DATABASE_URL",
      database: entry.database,
      login: "migration",
    });
  }
  return [...byEnv.values()];
};

export const loginDeclarations = (
  database: string,
  passwordFor: (role: string) => Redacted.Redacted<string>,
): ReadonlyArray<PostgresLoginDeclaration> => {
  const roles = postgresRoles(database);
  return [
    {
      name: postgresLoginRole(database, "api"),
      memberOf: roles.visitor,
      inherit: false,
      createDatabases: false,
      password: passwordFor(postgresLoginRole(database, "api")),
    },
    {
      name: postgresLoginRole(database, "migration"),
      memberOf: roles.owner,
      inherit: true,
      createDatabases: true,
      password: passwordFor(postgresLoginRole(database, "migration")),
    },
  ];
};

const declarationFor = (
  name: string,
  sourceDatabase: string,
  extensions: ReadonlyArray<string>,
  passwordFor: (role: string) => Redacted.Redacted<string>,
): PostgresDatabaseDeclaration => {
  const roles = postgresRoles(sourceDatabase);
  return {
    name,
    ownerRole: roles.owner,
    visitorRole: roles.visitor,
    extensions,
    logins: loginDeclarations(sourceDatabase, passwordFor),
  };
};

const declarationsForTargets = (
  entry: DevDbCartridge["postgres"][number],
  targets: ReadonlyArray<"live" | "shadow" | "test">,
  passwordFor: (role: string) => Redacted.Redacted<string>,
): ReadonlyArray<PostgresDatabaseDeclaration> => {
  const names = derivedDatabaseNames(entry.database);
  return targets.map((target) =>
    declarationFor(names[target], entry.database, entry.extensions, passwordFor),
  );
};

/** Live database plus its shadow and test DBs, same roles and extensions. */
export const databaseDeclarations = (
  cartridge: DevDbCartridge,
  passwordFor: (role: string) => Redacted.Redacted<string>,
): ReadonlyArray<PostgresDatabaseDeclaration> =>
  cartridge.postgres.flatMap((entry) =>
    declarationsForTargets(entry, ["live", "shadow", "test"], passwordFor),
  );

/** Declarations for a live name or a derived `_shadow` / `_test` (for `ops dev db reset`). */
export const declarationsForDatabase = (
  cartridge: DevDbCartridge,
  database: string,
  passwordFor: (role: string) => Redacted.Redacted<string>,
): ReadonlyArray<PostgresDatabaseDeclaration> => {
  const resolved = resolveDatabaseTarget(cartridge, database);
  if (resolved === undefined) return [];
  return declarationsForTargets(resolved.entry, resolved.targets, passwordFor);
};

export const connectionUrl = (input: {
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly host?: string;
  readonly port?: number;
  /** PostgreSQL startup options, such as `-c role=none`. */
  readonly options?: string;
}) =>
  `postgresql://${encodeURIComponent(input.username)}:${encodeURIComponent(input.password)}@${input.host ?? HOST}:${input.port ?? PORT}/${input.database}?sslmode=disable${input.options === undefined ? "" : `&options=${encodeURIComponent(input.options)}`}`;

/** Values to write for the managed keys, from login role names and passwords. */
export const managedEnvValues = (
  keys: ReadonlyArray<ManagedEnvKey>,
  passwordFor: (role: string) => string,
): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const key of keys) {
    const role = postgresLoginRole(key.database, key.login);
    if (key.kind === "username") values[key.env] = role;
    else if (key.kind === "password") values[key.env] = passwordFor(role);
    else if (key.kind === "shadowUrl")
      values[key.env] = connectionUrl({
        username: role,
        password: passwordFor(role),
        database: shadowDatabaseName(key.database),
      });
    else if (key.kind === "testUrl")
      values[key.env] = connectionUrl({
        username: role,
        password: passwordFor(role),
        database: testDatabaseName(key.database),
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
